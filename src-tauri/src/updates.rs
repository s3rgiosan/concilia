//! App updates: the scheduled check, the update found, and its download and install.
//!
//! The update manifest and the update archive come from the GitHub release assets named in
//! `plugins.updater.endpoints` in `tauri.conf.json`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Emitted while an update downloads, with an `UpdateProgress` payload.
pub const UPDATE_PROGRESS_EVENT: &str = "update-progress";
/// Emitted to the main window after a check started from the app menu, with an `UpdateCheckResult`.
pub const UPDATE_CHECK_RESULT_EVENT: &str = "update-check-result";

/// The first scheduled check runs this long after launch.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Scheduled checks after the first are this far apart.
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a check may take before it fails.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the update download may take before it fails.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// A newer release than the running app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    /// The release notes, when the release has any.
    pub notes: Option<String>,
}

/// Download progress in bytes. `total` is `None` when the server sends no length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// The outcome of a check started from the app menu: the update found, or why the check failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateCheckResult {
    pub update: Option<UpdateInfo>,
    pub error: Option<String>,
}

impl From<&Result<Option<UpdateInfo>, UpdateError>> for UpdateCheckResult {
    fn from(result: &Result<Option<UpdateInfo>, UpdateError>) -> UpdateCheckResult {
        match result {
            Ok(update) => UpdateCheckResult {
                update: update.clone(),
                error: None,
            },
            Err(e) => UpdateCheckResult {
                update: None,
                error: Some(e.to_string()),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpdateError {
    /// The update server could not be reached or answered with an error.
    #[error("{0}")]
    Network(String),
    /// The manifest or the archive is unusable, or the install failed.
    #[error("{0}")]
    Internal(String),
    #[error("no update is pending")]
    NothingPending,
    #[error("an update is already being installed")]
    AlreadyInstalling,
}

/// Receives download progress.
pub type ProgressSink<'a> = &'a (dyn Fn(UpdateProgress) + Send + Sync);

/// Looks for a release newer than the running app.
#[async_trait::async_trait]
pub trait UpdateSource: Send + Sync {
    async fn check(&self) -> Result<Option<Arc<dyn PendingUpdate>>, UpdateError>;
}

/// A release found by a check, ready to download and install.
#[async_trait::async_trait]
pub trait PendingUpdate: Send + Sync {
    fn info(&self) -> UpdateInfo;

    /// Downloads, verifies and installs the update over the running app. The app must be
    /// relaunched afterwards to run it.
    async fn download_and_install(&self, progress: ProgressSink<'_>) -> Result<(), UpdateError>;
}

/// Runs checks and keeps the update the last successful check found.
pub struct UpdateManager {
    source: Arc<dyn UpdateSource>,
    pending: Mutex<Option<Arc<dyn PendingUpdate>>>,
    installing: AtomicBool,
}

impl UpdateManager {
    pub fn new(source: Arc<dyn UpdateSource>) -> UpdateManager {
        UpdateManager {
            source,
            pending: Mutex::new(None),
            installing: AtomicBool::new(false),
        }
    }

    /// Checks for an update and keeps what it finds. A failed check keeps the update
    /// found before.
    pub async fn check_now(&self) -> Result<Option<UpdateInfo>, UpdateError> {
        let found = self.source.check().await?;
        let info = found.as_ref().map(|update| update.info());
        *self.pending.lock().unwrap() = found;
        Ok(info)
    }

    /// The update the last successful check found.
    pub fn pending(&self) -> Option<UpdateInfo> {
        self.pending.lock().unwrap().as_ref().map(|u| u.info())
    }

    /// Downloads and installs the pending update, reporting progress to `progress`.
    pub async fn install(&self, progress: ProgressSink<'_>) -> Result<(), UpdateError> {
        let update = self
            .pending
            .lock()
            .unwrap()
            .clone()
            .ok_or(UpdateError::NothingPending)?;
        let already = self.installing.swap(true, Ordering::SeqCst);
        if already {
            return Err(UpdateError::AlreadyInstalling);
        }
        let result = update.download_and_install(progress).await;
        self.installing.store(false, Ordering::SeqCst);
        result
    }
}

/// Checks `FIRST_CHECK_DELAY` after it starts and every `CHECK_INTERVAL` after that, skipping
/// each check while `enabled` returns false. Failures are logged at debug, since being offline is
/// the common cause.
pub async fn run_schedule(manager: Arc<UpdateManager>, enabled: impl Fn() -> bool + Send + Sync) {
    tokio::time::sleep(FIRST_CHECK_DELAY).await;
    loop {
        if enabled() {
            match manager.check_now().await {
                Ok(Some(update)) => log::info!("update {} is available", update.version),
                Ok(None) => log::debug!("no update available"),
                Err(e) => log::debug!("update check failed: {e}"),
            }
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

/// Checks and installs through `tauri-plugin-updater`.
pub struct PluginSource {
    app: tauri::AppHandle,
}

impl PluginSource {
    pub fn new(app: tauri::AppHandle) -> PluginSource {
        PluginSource { app }
    }
}

#[async_trait::async_trait]
impl UpdateSource for PluginSource {
    async fn check(&self) -> Result<Option<Arc<dyn PendingUpdate>>, UpdateError> {
        use tauri_plugin_updater::UpdaterExt;
        let updater = self
            .app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(classify)?;
        let found = updater.check().await.map_err(classify)?;
        Ok(found.map(|update| Arc::new(PluginUpdate(update)) as Arc<dyn PendingUpdate>))
    }
}

struct PluginUpdate(tauri_plugin_updater::Update);

#[async_trait::async_trait]
impl PendingUpdate for PluginUpdate {
    fn info(&self) -> UpdateInfo {
        let notes = self
            .0
            .body
            .as_deref()
            .map(str::trim)
            .filter(|notes| !notes.is_empty())
            .map(str::to_string);
        UpdateInfo {
            version: self.0.version.clone(),
            notes,
        }
    }

    async fn download_and_install(&self, progress: ProgressSink<'_>) -> Result<(), UpdateError> {
        let mut update = self.0.clone();
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        let mut downloaded: u64 = 0;
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    progress(UpdateProgress { downloaded, total });
                },
                || {},
            )
            .await
            .map_err(classify)
    }
}

/// Sorts updater failures into the server being unreachable and everything else.
fn classify(error: tauri_plugin_updater::Error) -> UpdateError {
    use tauri_plugin_updater::Error;
    let message = error.to_string();
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => {
            UpdateError::Network(message)
        }
        _ => UpdateError::Internal(message),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    #[test]
    fn unreachable_servers_are_network_errors_and_the_rest_internal() {
        use tauri_plugin_updater::Error;
        assert!(matches!(
            classify(Error::Network("status 503".into())),
            UpdateError::Network(_)
        ));
        assert!(matches!(
            classify(Error::ReleaseNotFound),
            UpdateError::Network(_)
        ));
        assert!(matches!(
            classify(Error::TargetNotFound("darwin-aarch64".into())),
            UpdateError::Internal(_)
        ));
        assert!(matches!(
            classify(Error::EmptyEndpoints),
            UpdateError::Internal(_)
        ));
    }

    #[test]
    fn check_results_carry_the_update_or_the_error() {
        let found = UpdateInfo {
            version: "9.9.9".into(),
            notes: None,
        };
        assert_eq!(
            serde_json::to_value(UpdateCheckResult::from(&Ok(Some(found)))).unwrap(),
            serde_json::json!({ "update": { "version": "9.9.9", "notes": null }, "error": null })
        );
        let failed = Err(UpdateError::Network("offline".into()));
        assert_eq!(
            serde_json::to_value(UpdateCheckResult::from(&failed)).unwrap(),
            serde_json::json!({ "update": null, "error": "offline" })
        );
    }

    fn info(version: &str) -> UpdateInfo {
        UpdateInfo {
            version: version.into(),
            notes: Some("Fixes.".into()),
        }
    }

    /// An update that reports two chunks of progress, then finishes with `outcome` once
    /// `gate` opens.
    struct FakeUpdate {
        info: UpdateInfo,
        outcome: Result<(), UpdateError>,
        installs: AtomicUsize,
        gate: tokio::sync::Semaphore,
    }

    impl FakeUpdate {
        fn new(version: &str, outcome: Result<(), UpdateError>) -> Arc<FakeUpdate> {
            Arc::new(FakeUpdate {
                info: info(version),
                outcome,
                installs: AtomicUsize::new(0),
                gate: tokio::sync::Semaphore::new(tokio::sync::Semaphore::MAX_PERMITS),
            })
        }
    }

    #[async_trait::async_trait]
    impl PendingUpdate for FakeUpdate {
        fn info(&self) -> UpdateInfo {
            self.info.clone()
        }

        async fn download_and_install(
            &self,
            progress: ProgressSink<'_>,
        ) -> Result<(), UpdateError> {
            self.installs.fetch_add(1, Ordering::SeqCst);
            progress(UpdateProgress {
                downloaded: 10,
                total: Some(20),
            });
            let _permit = self.gate.acquire().await.unwrap();
            progress(UpdateProgress {
                downloaded: 20,
                total: Some(20),
            });
            self.outcome.clone()
        }
    }

    type CheckResult = Result<Option<Arc<dyn PendingUpdate>>, UpdateError>;

    /// Answers each check with the next scripted result.
    struct FakeSource {
        results: Mutex<Vec<CheckResult>>,
    }

    impl FakeSource {
        fn scripted(results: Vec<CheckResult>) -> Arc<FakeSource> {
            Arc::new(FakeSource {
                results: Mutex::new(results.into_iter().rev().collect()),
            })
        }
    }

    #[async_trait::async_trait]
    impl UpdateSource for FakeSource {
        async fn check(&self) -> Result<Option<Arc<dyn PendingUpdate>>, UpdateError> {
            self.results
                .lock()
                .unwrap()
                .pop()
                .expect("a scripted check")
        }
    }

    fn found(update: &Arc<FakeUpdate>) -> CheckResult {
        Ok(Some(update.clone() as Arc<dyn PendingUpdate>))
    }

    #[tokio::test]
    async fn keeps_the_update_a_check_finds() {
        let update = FakeUpdate::new("9.9.9", Ok(()));
        let manager = UpdateManager::new(FakeSource::scripted(vec![found(&update), Ok(None)]));
        assert_eq!(manager.pending(), None);

        assert_eq!(manager.check_now().await, Ok(Some(info("9.9.9"))));
        assert_eq!(manager.pending(), Some(info("9.9.9")));

        assert_eq!(manager.check_now().await, Ok(None));
        assert_eq!(manager.pending(), None);
    }

    #[tokio::test]
    async fn a_failed_check_keeps_the_update_found_before() {
        let update = FakeUpdate::new("9.9.9", Ok(()));
        let manager = UpdateManager::new(FakeSource::scripted(vec![
            found(&update),
            Err(UpdateError::Network("offline".into())),
        ]));
        manager.check_now().await.unwrap();

        assert_eq!(
            manager.check_now().await,
            Err(UpdateError::Network("offline".into()))
        );
        assert_eq!(manager.pending(), Some(info("9.9.9")));
    }

    #[tokio::test]
    async fn installing_needs_a_pending_update() {
        let manager = UpdateManager::new(FakeSource::scripted(Vec::new()));
        assert_eq!(
            manager.install(&|_| {}).await,
            Err(UpdateError::NothingPending)
        );
    }

    #[tokio::test]
    async fn installing_reports_progress_and_allows_a_retry_after_failure() {
        let update = FakeUpdate::new("9.9.9", Err(UpdateError::Internal("bad archive".into())));
        let manager = UpdateManager::new(FakeSource::scripted(vec![found(&update)]));
        manager.check_now().await.unwrap();

        let seen = Mutex::new(Vec::new());
        let sink = |progress| seen.lock().unwrap().push(progress);
        let first = manager.install(&sink).await;
        let second = manager.install(&sink).await;

        assert_eq!(first, Err(UpdateError::Internal("bad archive".into())));
        assert_eq!(second, first);
        assert_eq!(update.installs.load(Ordering::SeqCst), 2);
        let downloaded: Vec<u64> = seen.lock().unwrap().iter().map(|p| p.downloaded).collect();
        assert_eq!(downloaded, [10, 20, 10, 20]);
        assert_eq!(manager.pending(), Some(info("9.9.9")));
    }

    #[tokio::test]
    async fn refuses_a_second_install_while_one_runs() {
        let update = Arc::new(FakeUpdate {
            info: info("9.9.9"),
            outcome: Ok(()),
            installs: AtomicUsize::new(0),
            gate: tokio::sync::Semaphore::new(0),
        });
        let manager = Arc::new(UpdateManager::new(FakeSource::scripted(vec![found(
            &update,
        )])));
        manager.check_now().await.unwrap();

        let running = tokio::spawn({
            let manager = manager.clone();
            async move { manager.install(&|_| {}).await }
        });
        while update.installs.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }

        assert_eq!(
            manager.install(&|_| {}).await,
            Err(UpdateError::AlreadyInstalling)
        );
        update.gate.add_permits(1);
        assert_eq!(running.await.unwrap(), Ok(()));
        assert_eq!(manager.install(&|_| {}).await, Ok(()));
    }
}
