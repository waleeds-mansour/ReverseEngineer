// FakeSignals: the shared objects for tests, living in the same world as FakeDesktop. A revoke
// takes the world's lock, the same one every write is checked under, so a test can say exactly
// which writes landed before it and prove none landed after.

use super::{guard, World};
use crate::objects::Signals;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
pub(super) struct Lock {
    held: Mutex<bool>,
    freed: Condvar,
}

#[derive(Clone)]
pub struct FakeSignals {
    pub(super) world: Arc<Mutex<World>>,
    pub(super) lock: Arc<Lock>,
}

impl Signals for FakeSignals {
    fn revoke(&self, epoch: u64) {
        let mut w = guard(&self.world);
        w.revoked = true;
        w.epoch = w.epoch.max(epoch);
        let landed = w.writes.len();
        w.revoked_after.get_or_insert(landed);
    }
    fn is_revoked(&self, epoch: u64) -> bool {
        let w = guard(&self.world);
        w.revoked || w.epoch > epoch
    }
    fn epoch(&self) -> u64 {
        guard(&self.world).epoch
    }
    fn begin(&self, epoch: u64) {
        let mut w = guard(&self.world);
        w.epoch = w.epoch.max(epoch);
        w.revoked = false;
        w.revoked_after = None;
    }
    fn lock_journal(&self, timeout: Duration) -> bool {
        let held = guard(&self.lock.held);
        let wait = self.lock.freed.wait_timeout_while(held, timeout, |h| *h);
        let (mut held, _) = wait.unwrap_or_else(|p| p.into_inner());
        if *held {
            return false;
        }
        *held = true;
        true
    }
    fn unlock_journal(&self) {
        *guard(&self.lock.held) = false;
        self.lock.freed.notify_one();
    }
    fn finished(&self) {
        guard(&self.world).finished += 1;
    }
}
