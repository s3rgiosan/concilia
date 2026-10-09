//! Per-period locks.
//!
//! A period runs at most one exclusive job at a time (reconcile, scan, Finalize or report
//! export), never alongside a receipt rescan. Rescans of different files may run together,
//! but their writes to the period's JSON files go through one mutex per period.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::period::Period;

/// The exclusive jobs a period can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    Reconcile,
    Scan,
    Finalize,
    Report,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Busy {
    #[error("{0:?} is already running for this period")]
    Running(RunKind),
    #[error("a receipt is being rescanned for this period")]
    Rescanning,
    #[error("this receipt is already being rescanned")]
    SameFile,
}

#[derive(Default)]
struct PeriodState {
    exclusive: Option<(RunKind, CancellationToken)>,
    rescans: HashSet<PathBuf>,
    write: Arc<tokio::sync::Mutex<()>>,
}

impl PeriodState {
    fn idle(&self) -> bool {
        self.exclusive.is_none() && self.rescans.is_empty()
    }
}

type BusyListener = Box<dyn Fn(bool) + Send + Sync>;

/// Locks for every period, shared by all commands.
#[derive(Default)]
pub struct PeriodLocks {
    periods: Mutex<HashMap<Period, PeriodState>>,
    listener: Mutex<Option<BusyListener>>,
}

impl PeriodLocks {
    pub fn new() -> Arc<PeriodLocks> {
        Arc::new(PeriodLocks::default())
    }

    /// Calls `listener` with the new busy state whenever any job starts or ends.
    pub fn on_busy_change(&self, listener: impl Fn(bool) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Box::new(listener));
    }

    fn notify(&self) {
        let busy = self.busy();
        if let Some(listener) = lock(&self.listener).as_ref() {
            listener(busy);
        }
    }

    /// Starts an exclusive job, returning its guard and cancellation token.
    pub fn try_exclusive(
        self: &Arc<Self>,
        period: &Period,
        kind: RunKind,
    ) -> Result<ExclusiveGuard, Busy> {
        let token = CancellationToken::new();
        {
            let mut periods = lock(&self.periods);
            let state = periods.entry(period.clone()).or_default();
            if let Some((running, _)) = &state.exclusive {
                return Err(Busy::Running(*running));
            }
            if !state.rescans.is_empty() {
                return Err(Busy::Rescanning);
            }
            state.exclusive = Some((kind, token.clone()));
        }
        self.notify();
        Ok(ExclusiveGuard {
            locks: Arc::clone(self),
            period: period.clone(),
            token,
        })
    }

    /// Starts a rescan of one file, identified by its canonical path.
    pub fn try_rescan(
        self: &Arc<Self>,
        period: &Period,
        file: PathBuf,
    ) -> Result<RescanGuard, Busy> {
        {
            let mut periods = lock(&self.periods);
            let state = periods.entry(period.clone()).or_default();
            if let Some((running, _)) = &state.exclusive {
                return Err(Busy::Running(*running));
            }
            if !state.rescans.insert(file.clone()) {
                return Err(Busy::SameFile);
            }
        }
        self.notify();
        Ok(RescanGuard {
            locks: Arc::clone(self),
            period: period.clone(),
            file,
        })
    }

    /// The mutex serializing writes to the period's JSON files.
    pub fn write_lock(&self, period: &Period) -> Arc<tokio::sync::Mutex<()>> {
        let mut periods = lock(&self.periods);
        Arc::clone(&periods.entry(period.clone()).or_default().write)
    }

    /// The exclusive job running for the period, if any.
    pub fn running(&self, period: &Period) -> Option<RunKind> {
        lock(&self.periods)
            .get(period)
            .and_then(|s| s.exclusive.as_ref().map(|(kind, _)| *kind))
    }

    /// Asks the period's exclusive job to stop. Returns whether one was running.
    pub fn cancel(&self, period: &Period) -> bool {
        match lock(&self.periods)
            .get(period)
            .and_then(|s| s.exclusive.as_ref())
        {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Whether any job runs in any period.
    pub fn busy(&self) -> bool {
        lock(&self.periods).values().any(|s| !s.idle())
    }

    fn release(&self, period: &Period, release: impl FnOnce(&mut PeriodState)) {
        {
            let mut periods = lock(&self.periods);
            if let Some(state) = periods.get_mut(period) {
                release(state);
                // Keep the entry while someone still holds its write mutex.
                if state.idle() && Arc::strong_count(&state.write) == 1 {
                    periods.remove(period);
                }
            }
        }
        self.notify();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Held for the length of an exclusive job; releases the period when dropped.
pub struct ExclusiveGuard {
    locks: Arc<PeriodLocks>,
    period: Period,
    token: CancellationToken,
}

impl ExclusiveGuard {
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for ExclusiveGuard {
    fn drop(&mut self) {
        self.locks
            .release(&self.period, |state| state.exclusive = None);
    }
}

/// Held for the length of a rescan; releases the file when dropped.
pub struct RescanGuard {
    locks: Arc<PeriodLocks>,
    period: Period,
    file: PathBuf,
}

impl Drop for RescanGuard {
    fn drop(&mut self) {
        let file = std::mem::take(&mut self.file);
        self.locks.release(&self.period, |state| {
            state.rescans.remove(&file);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn period(month: &str) -> Period {
        Period::parse("2030", month).unwrap()
    }

    #[test]
    fn one_exclusive_job_per_period() {
        let locks = PeriodLocks::new();
        let guard = locks
            .try_exclusive(&period("03"), RunKind::Reconcile)
            .unwrap();
        assert_eq!(
            locks.try_exclusive(&period("03"), RunKind::Scan).err(),
            Some(Busy::Running(RunKind::Reconcile))
        );
        assert!(locks.try_exclusive(&period("04"), RunKind::Scan).is_ok());
        assert_eq!(locks.running(&period("03")), Some(RunKind::Reconcile));
        drop(guard);
        assert_eq!(locks.running(&period("03")), None);
        assert!(locks.try_exclusive(&period("03"), RunKind::Scan).is_ok());
    }

    #[test]
    fn rescans_exclude_exclusive_jobs_and_the_same_file() {
        let locks = PeriodLocks::new();
        let p = period("03");
        let a = locks.try_rescan(&p, "/r/a.pdf".into()).unwrap();
        let _b = locks.try_rescan(&p, "/r/b.pdf".into()).unwrap();
        assert_eq!(
            locks.try_rescan(&p, "/r/a.pdf".into()).err(),
            Some(Busy::SameFile)
        );
        assert_eq!(
            locks.try_exclusive(&p, RunKind::Finalize).err(),
            Some(Busy::Rescanning)
        );
        drop(a);
        assert!(locks.try_rescan(&p, "/r/a.pdf".into()).is_ok());

        let other = period("04");
        let _job = locks.try_exclusive(&other, RunKind::Scan).unwrap();
        assert_eq!(
            locks.try_rescan(&other, "/r/c.pdf".into()).err(),
            Some(Busy::Running(RunKind::Scan))
        );
    }

    #[test]
    fn cancels_the_running_job() {
        let locks = PeriodLocks::new();
        let p = period("03");
        assert!(!locks.cancel(&p));
        let guard = locks.try_exclusive(&p, RunKind::Reconcile).unwrap();
        assert!(locks.cancel(&p));
        assert!(guard.token().is_cancelled());
    }

    #[test]
    fn reports_busy_changes() {
        let locks = PeriodLocks::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&changes);
        locks.on_busy_change(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        assert!(!locks.busy());
        let guard = locks.try_exclusive(&period("03"), RunKind::Report).unwrap();
        assert!(locks.busy());
        drop(guard);
        assert!(!locks.busy());
        assert_eq!(changes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn writes_share_one_mutex_per_period() {
        let locks = PeriodLocks::new();
        let first = locks.write_lock(&period("03"));
        let second = locks.write_lock(&period("03"));
        assert!(Arc::ptr_eq(&first, &second));
        let held = first.lock().await;
        assert!(second.try_lock().is_err());
        drop(held);
        assert!(!Arc::ptr_eq(&first, &locks.write_lock(&period("04"))));
    }
}
