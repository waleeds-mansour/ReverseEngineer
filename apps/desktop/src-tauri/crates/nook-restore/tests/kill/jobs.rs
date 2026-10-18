// The job objects every program a kill test starts is put in. Both kill everything in them when
// the harness ends, however it ends, so no test process outlives a test. A guard that left the
// lenient job still ends by itself: its host and the test windows die with the job, and a guard
// whose host is gone restores (finding nothing) and exits.

use std::ffi::c_void;
use std::sync::OnceLock;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Job {
    /// Refuses CREATE_BREAKAWAY_FROM_JOB, so the guard takes its retry and stays inside.
    Strict,
    /// Lets the guard leave, as it does from a job that allows it.
    Lenient,
}

fn create(limits: JOB_OBJECT_LIMIT) -> usize {
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.expect("a job object");
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | limits;
    let size = std::mem::size_of_val(&info) as u32;
    let ptr = &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void;
    unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, size) }
        .expect("the job kills its processes when the harness ends");
    // Kept open for the life of the harness; the kernel closes it, and kills the job, at exit.
    job.0 as usize
}

/// The job's handle, made on first use.
pub fn handle(kind: Job) -> HANDLE {
    static STRICT: OnceLock<usize> = OnceLock::new();
    static LENIENT: OnceLock<usize> = OnceLock::new();
    let raw = match kind {
        Job::Strict => *STRICT.get_or_init(|| create(JOB_OBJECT_LIMIT(0))),
        Job::Lenient => *LENIENT.get_or_init(|| create(JOB_OBJECT_LIMIT_BREAKAWAY_OK)),
    };
    HANDLE(raw as *mut c_void)
}

/// Puts a process (started suspended) in the job; it must not run outside one.
pub fn assign(kind: Job, process: HANDLE) -> windows::core::Result<()> {
    unsafe { AssignProcessToJobObject(handle(kind), process) }
}
