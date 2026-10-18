// The real shared objects: four manual-reset events, the journal mutex and a small shared section
// holding the heartbeat, the shared epoch and the reason for a requested restore. They live in the
// session's Local\ namespace, so another user's session can't see or signal them.

use super::{object_name, reason_code, reason_from_code, Signals};
use crate::recover::Reason;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;
use windows::core::{Error, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, E_FAIL, HANDLE, INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_READ, FILE_MAP_WRITE,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, GetCurrentProcessId, OpenEventW, ReleaseMutex, ResetEvent,
    SetEvent, WaitForSingleObject, SYNCHRONIZATION_SYNCHRONIZE,
};

/// The Beat section's layout. Bump it when the fields change, so an old guard and a new app
/// never read each other's numbers.
const LAYOUT: u32 = 1;
const SECTION_BYTES: u32 = 4096;

#[repr(C)]
struct BeatData {
    layout: AtomicU32,
    reason: AtomicU32,
    beat: AtomicU64,
    epoch: AtomicU64,
}

struct Owned(HANDLE);

// Kernel handles may be used from any thread; the objects behind them do their own locking.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct View(MEMORY_MAPPED_VIEW_ADDRESS);

unsafe impl Send for View {}
unsafe impl Sync for View {}

impl Drop for View {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(self.0);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Restore,
    Revoked,
    Done,
    Armed,
}

pub struct SessionObjects {
    tag: String,
    restore: Owned,
    revoked: Owned,
    done: Owned,
    armed: Owned,
    journal: Owned,
    _section: Owned,
    view: View,
}

/// The tag for this logon session's objects: its Windows session id.
pub fn session_tag() -> String {
    let mut id = 0u32;
    unsafe {
        let _ = ProcessIdToSessionId(GetCurrentProcessId(), &mut id);
    }
    id.to_string()
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn millis(timeout: Duration) -> u32 {
    // u32::MAX is INFINITE; a finite wait must stay below it.
    timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32
}

impl SessionObjects {
    /// Opens the objects for `tag`, creating any that don't exist yet.
    pub fn create(tag: &str) -> windows::core::Result<SessionObjects> {
        let event = |kind: &str| -> windows::core::Result<Owned> {
            let name = wide(&object_name(kind, tag));
            unsafe { CreateEventW(None, true, false, PCWSTR(name.as_ptr())) }.map(Owned)
        };
        let restore = event("Restore")?;
        let revoked = event("Revoked")?;
        let done = event("Done")?;
        let armed = event("Armed")?;
        let mutex_name = wide(&object_name("Journal", tag));
        let journal = unsafe { CreateMutexW(None, false, PCWSTR(mutex_name.as_ptr())) }?;
        let journal = Owned(journal);
        let beat_name = wide(&object_name("Beat", tag));
        let section = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                SECTION_BYTES,
                PCWSTR(beat_name.as_ptr()),
            )
        }?;
        let section = Owned(section);
        let view = unsafe { MapViewOfFile(section.0, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, 0) };
        if view.Value.is_null() {
            return Err(Error::from_win32());
        }
        let objects = SessionObjects {
            tag: tag.to_string(),
            restore,
            revoked,
            done,
            armed,
            journal,
            _section: section,
            view: View(view),
        };
        // A fresh section is zeroed; anything other than our layout means someone else's section
        // holds the name, and its numbers can't be trusted.
        let layout = &objects.data().layout;
        match layout.compare_exchange(0, LAYOUT, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => Ok(objects),
            Err(found) if found == LAYOUT => Ok(objects),
            Err(_) => Err(Error::from_hresult(E_FAIL)),
        }
    }

    /// Whether any running party (the app or the guard) holds the objects for `tag`.
    pub fn exists(tag: &str) -> bool {
        let name = wide(&object_name("Restore", tag));
        unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) }
            .map(Owned)
            .is_ok()
    }

    pub fn tag(&self) -> &str {
        &self.tag
    }

    fn data(&self) -> &BeatData {
        // The view is at least a page, page-aligned, and lives as long as self.
        unsafe { &*(self.view.0.Value as *const BeatData) }
    }

    /// The event handle, for the guard's WaitForMultipleObjects.
    pub fn handle(&self, kind: Kind) -> HANDLE {
        match kind {
            Kind::Restore => self.restore.0,
            Kind::Revoked => self.revoked.0,
            Kind::Done => self.done.0,
            Kind::Armed => self.armed.0,
        }
    }

    fn is_set(&self, kind: Kind) -> bool {
        unsafe { WaitForSingleObject(self.handle(kind), 0) == WAIT_OBJECT_0 }
    }

    /// Something is journaled: the guard starts watching the heartbeat.
    pub fn arm(&self) {
        unsafe {
            let _ = SetEvent(self.armed.0);
        }
    }

    /// Nothing is journaled: the guard goes back to waiting without a timeout.
    pub fn disarm(&self) {
        unsafe {
            let _ = ResetEvent(self.armed.0);
        }
    }

    pub fn is_armed(&self) -> bool {
        self.is_set(Kind::Armed)
    }

    /// One heartbeat from the window manager's sweep.
    pub fn pulse(&self) {
        self.data().beat.fetch_add(1, Ordering::SeqCst);
    }

    pub fn beats(&self) -> u64 {
        self.data().beat.load(Ordering::SeqCst)
    }

    /// Asks whoever runs Nook to put the windows back for `reason`, and clears Done so the
    /// caller can wait for this restore rather than an earlier one.
    pub fn request_restore(&self, reason: Reason) {
        self.data()
            .reason
            .store(reason_code(reason), Ordering::SeqCst);
        unsafe {
            let _ = ResetEvent(self.done.0);
            let _ = SetEvent(self.restore.0);
        }
    }

    pub fn restore_requested(&self) -> bool {
        self.is_set(Kind::Restore)
    }

    /// The reason the last request carried.
    pub fn requested_reason(&self) -> Reason {
        reason_from_code(self.data().reason.load(Ordering::SeqCst))
    }

    /// Waits up to `timeout` for a restore to finish.
    pub fn wait_done(&self, timeout: Duration) -> bool {
        unsafe { WaitForSingleObject(self.done.0, millis(timeout)) == WAIT_OBJECT_0 }
    }

    /// Forgets a restore that finished before now. Done stays set after a restore, and a guard
    /// started later (Nook turned on again) must not take that old restore for its own ending.
    pub fn clear_done(&self) {
        unsafe {
            let _ = ResetEvent(self.done.0);
        }
    }
}

impl Signals for SessionObjects {
    fn revoke(&self, epoch: u64) {
        self.data().epoch.fetch_max(epoch, Ordering::SeqCst);
        unsafe {
            let _ = SetEvent(self.revoked.0);
        }
    }

    fn is_revoked(&self, epoch: u64) -> bool {
        self.is_set(Kind::Revoked) || self.data().epoch.load(Ordering::SeqCst) > epoch
    }

    fn epoch(&self) -> u64 {
        self.data().epoch.load(Ordering::SeqCst)
    }

    fn begin(&self, epoch: u64) {
        // The epoch goes up before Revoked clears, so an older writer is never unfenced.
        self.data().epoch.fetch_max(epoch, Ordering::SeqCst);
        unsafe {
            let _ = ResetEvent(self.revoked.0);
        }
    }

    fn lock_journal(&self, timeout: Duration) -> bool {
        // An abandoned mutex means its holder died mid-write; the journal file is still whole
        // (atomic replace), so taking it over is safe.
        let got = unsafe { WaitForSingleObject(self.journal.0, millis(timeout)) };
        got == WAIT_OBJECT_0 || got == WAIT_ABANDONED
    }

    fn unlock_journal(&self) {
        unsafe {
            let _ = ReleaseMutex(self.journal.0);
        }
    }

    fn finished(&self) {
        unsafe {
            let _ = ResetEvent(self.restore.0);
            let _ = ResetEvent(self.armed.0);
            let _ = SetEvent(self.done.0);
        }
    }
}
