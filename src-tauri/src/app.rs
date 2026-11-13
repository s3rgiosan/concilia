//! State shared by every command: settings, rules, the service account, period locks, the
//! PDF tools and the Gemini client built from them.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

use crate::config::{ConfigStore, ReasonsStore, RulesStore, Settings};
use crate::error::{CommandError, CommandResult, ErrorKind};
use crate::gemini::client::{GeminiClient, GeminiConfig, ServiceAccount};
use crate::locks::PeriodLocks;
use crate::period::{Period, PeriodPaths};
use crate::poppler::Poppler;
use crate::secrets::ServiceAccountStore;

/// Emitted to every window after the settings or the service account change, with an
/// `AppStateView`.
pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";
/// Emitted to every window when any job starts or ends, with `{ busy }`.
pub const BUSY_CHANGED_EVENT: &str = "busy-changed";

/// A setting that must be filled in before a period can be reconciled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Missing {
    ReceiptsRoot,
    ServiceAccount,
    Project,
}

/// The parts of the service account the windows show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceAccountInfo {
    pub client_email: String,
    pub project_id: Option<String>,
}

impl From<&ServiceAccount> for ServiceAccountInfo {
    fn from(account: &ServiceAccount) -> ServiceAccountInfo {
        ServiceAccountInfo {
            client_email: account.client_email.clone(),
            project_id: account.project_id.clone(),
        }
    }
}

/// Everything the windows need to know about the app's setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppStateView {
    pub settings: Settings,
    pub service_account: Option<ServiceAccountInfo>,
    /// Why the stored service account cannot be read, when it cannot.
    pub service_account_error: Option<String>,
    pub missing: Vec<Missing>,
    pub configured: bool,
    pub busy: bool,
    pub read_only: bool,
    /// The no-receipt reasons, in menu order.
    pub reasons: Vec<crate::model::Reason>,
}

pub struct AppState {
    config: Mutex<ConfigStore>,
    rules: Mutex<RulesStore>,
    reasons: Mutex<ReasonsStore>,
    pub accounts: ServiceAccountStore,
    pub locks: Arc<PeriodLocks>,
    pub poppler: Poppler,
    gemini: Mutex<Option<Arc<GeminiClient>>>,
    /// Paths the user chose in a file dialog or dropped on a window, which commands may read.
    granted: Mutex<HashSet<PathBuf>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl AppState {
    pub fn new(
        config: ConfigStore,
        rules: RulesStore,
        reasons: ReasonsStore,
        accounts: ServiceAccountStore,
        poppler: Poppler,
    ) -> AppState {
        AppState {
            config: Mutex::new(config),
            rules: Mutex::new(rules),
            reasons: Mutex::new(reasons),
            accounts,
            locks: PeriodLocks::new(),
            poppler,
            gemini: Mutex::new(None),
            granted: Mutex::new(HashSet::new()),
        }
    }

    /// Records paths the user chose, so commands accept them. Each path is kept as given and
    /// as its real path.
    pub fn grant_paths(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut granted = lock(&self.granted);
        for path in paths {
            if let Ok(real) = path.canonicalize() {
                granted.insert(real);
            }
            granted.insert(path);
        }
    }

    /// Whether the user chose `path` in a file dialog or dropped it on a window.
    pub fn is_granted(&self, path: &Path) -> bool {
        let granted = lock(&self.granted);
        granted.contains(path)
            || path
                .canonicalize()
                .is_ok_and(|real| granted.contains(&real))
    }

    /// Fails unless every path was chosen by the user.
    pub fn ensure_granted<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> CommandResult<()> {
        for path in paths {
            if !self.is_granted(path) {
                return Err(not_granted(path));
            }
        }
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        lock(&self.config).settings().clone()
    }

    /// The receipts root, when it is set and is a folder.
    pub fn receipts_root(&self) -> Option<PathBuf> {
        let root = lock(&self.config).settings().receipts_root.clone();
        root.filter(|root| root.is_dir())
    }

    pub fn period_paths(&self, period: &Period) -> CommandResult<PeriodPaths> {
        self.receipts_root()
            .map(|root| period.paths(&root))
            .ok_or_else(|| {
                CommandError::new(
                    ErrorKind::NotConfigured,
                    "choose the receipts folder in Settings",
                )
            })
    }

    pub fn rules(&self) -> Vec<crate::model::Rule> {
        lock(&self.rules).rules().to_vec()
    }

    pub fn save_rules(
        &self,
        rules: Vec<crate::model::Rule>,
    ) -> CommandResult<Vec<crate::model::Rule>> {
        let reasons = lock(&self.reasons);
        let mut store = lock(&self.rules);
        store.replace(rules, reasons.reasons())??;
        Ok(store.rules().to_vec())
    }

    pub fn reasons(&self) -> Vec<crate::model::Reason> {
        lock(&self.reasons).reasons().to_vec()
    }

    /// Saves the no-receipt reasons. Rules that name a reason no longer in the list change to
    /// the Other reason.
    pub fn save_reasons(&self, reasons: Vec<crate::model::Reason>) -> CommandResult<AppStateView> {
        {
            let mut store = lock(&self.reasons);
            store.replace(reasons)??;
            let mut rules = lock(&self.rules);
            let kept = |id: &String| store.reasons().iter().any(|r| &r.id == id);
            if rules
                .rules()
                .iter()
                .any(|rule| rule.no_receipt.as_ref().is_some_and(|id| !kept(id)))
            {
                let moved = rules
                    .rules()
                    .iter()
                    .cloned()
                    .map(|mut rule| {
                        if rule.no_receipt.as_ref().is_some_and(|id| !kept(id)) {
                            rule.no_receipt = Some(crate::model::OTHER_REASON.to_string());
                        }
                        rule
                    })
                    .collect();
                rules.replace(moved, store.reasons())??;
            }
        }
        Ok(self.view())
    }

    /// The Gemini client for the current settings and service account, built on first use.
    pub fn gemini(&self) -> CommandResult<Arc<GeminiClient>> {
        let mut cached = lock(&self.gemini);
        if let Some(client) = cached.as_ref() {
            return Ok(Arc::clone(client));
        }
        let account = self.accounts.get()?.ok_or_else(|| {
            CommandError::new(
                ErrorKind::NotConfigured,
                "import a service account key in Settings",
            )
        })?;
        let settings = self.settings();
        let project = settings
            .gemini
            .project
            .clone()
            .or_else(|| account.project_id.clone())
            .ok_or_else(|| {
                CommandError::new(
                    ErrorKind::NotConfigured,
                    "set the Google Cloud project in Settings",
                )
            })?;
        let client = Arc::new(GeminiClient::new(
            account,
            GeminiConfig {
                project,
                location: settings.gemini.location,
                model: settings.gemini.model,
            },
        )?);
        *cached = Some(Arc::clone(&client));
        Ok(client)
    }

    /// Drops the Gemini client so the next use builds one from the current setup.
    pub fn reset_gemini(&self) {
        *lock(&self.gemini) = None;
    }

    pub fn view(&self) -> AppStateView {
        let (settings, read_only) = {
            let config = lock(&self.config);
            (config.settings().clone(), config.read_only())
        };
        let (account, account_error) = match self.accounts.get() {
            Ok(account) => (account, None),
            Err(error) => (None, Some(error.to_string())),
        };
        let mut missing = Vec::new();
        if !settings.receipts_root.as_ref().is_some_and(|r| r.is_dir()) {
            missing.push(Missing::ReceiptsRoot);
        }
        match &account {
            None => missing.push(Missing::ServiceAccount),
            Some(a) if settings.gemini.project.is_none() && a.project_id.is_none() => {
                missing.push(Missing::Project)
            }
            Some(_) => {}
        }
        AppStateView {
            configured: missing.is_empty(),
            missing,
            service_account: account.as_ref().map(ServiceAccountInfo::from),
            service_account_error: account_error,
            settings,
            busy: self.locks.busy(),
            read_only,
            reasons: self.reasons(),
        }
    }

    /// Saves the settings. The receipts folder and the Gemini settings cannot change while a
    /// job runs, and a new receipts folder must be one the user chose.
    pub fn save_settings(&self, settings: Settings) -> CommandResult<AppStateView> {
        {
            let mut config = lock(&self.config);
            let current = config.settings().clone();
            let next = settings.normalized();
            next.validate()?;
            let root_changed = current.receipts_root != next.receipts_root;
            let affects_jobs = root_changed || current.gemini != next.gemini;
            if affects_jobs && self.locks.busy() {
                return Err(CommandError::new(
                    ErrorKind::Busy,
                    "wait for the running job to finish before changing the folder or Gemini settings",
                ));
            }
            if let (true, Some(root)) = (root_changed, &next.receipts_root) {
                self.ensure_granted([root.as_path()])?;
            }
            config.replace(next)?;
            if current.gemini != config.settings().gemini {
                self.reset_gemini();
            }
        }
        Ok(self.view())
    }

    /// Stores a service account key file's contents.
    pub fn import_service_account(&self, json: &str) -> CommandResult<AppStateView> {
        self.ensure_idle()?;
        self.accounts.import(json)?;
        self.reset_gemini();
        Ok(self.view())
    }

    pub fn remove_service_account(&self) -> CommandResult<AppStateView> {
        self.ensure_idle()?;
        self.accounts.remove()?;
        self.reset_gemini();
        Ok(self.view())
    }

    fn ensure_idle(&self) -> CommandResult<()> {
        if self.locks.busy() {
            Err(CommandError::new(
                ErrorKind::Busy,
                "wait for the running job to finish before changing the service account",
            ))
        } else {
            Ok(())
        }
    }
}

/// The error for a path the user never chose.
fn not_granted(path: &Path) -> CommandError {
    CommandError::coded(
        ErrorKind::InvalidInput,
        "path_not_chosen",
        format!(
            "{} was not chosen in a dialog or dropped on the window",
            path.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locks::RunKind;
    use crate::secrets::MemoryStore;

    fn state() -> AppState {
        AppState::new(
            ConfigStore::in_memory(Settings::default()),
            RulesStore::in_memory(Vec::new()),
            ReasonsStore::in_memory(crate::model::default_reasons()),
            ServiceAccountStore::new(Box::new(MemoryStore::default())),
            Poppler::resolve(None),
        )
    }

    #[test]
    fn lists_what_is_missing() {
        let state = state();
        let view = state.view();
        assert!(!view.configured);
        assert_eq!(
            view.missing,
            [Missing::ReceiptsRoot, Missing::ServiceAccount]
        );

        let dir = tempfile::tempdir().unwrap();
        state.grant_paths([dir.path().to_path_buf()]);
        let settings = Settings {
            receipts_root: Some(dir.path().to_path_buf()),
            ..Default::default()
        };
        let view = state.save_settings(settings).unwrap();
        assert_eq!(view.missing, [Missing::ServiceAccount]);
    }

    #[test]
    fn a_new_receipts_root_must_have_been_chosen() {
        let state = state();
        let chosen = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let with_root = |root: &Path| Settings {
            receipts_root: Some(root.to_path_buf()),
            ..Default::default()
        };

        let error = state.save_settings(with_root(other.path())).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert_eq!(error.code.as_deref(), Some("path_not_chosen"));

        state.grant_paths([chosen.path().to_path_buf()]);
        state.save_settings(with_root(chosen.path())).unwrap();
        // The folder already in the settings needs no new grant.
        let language = Settings {
            language: Some(crate::model::Language::Pt),
            ..with_root(chosen.path())
        };
        let fresh = AppState::new(
            ConfigStore::in_memory(language.clone()),
            RulesStore::in_memory(Vec::new()),
            ReasonsStore::in_memory(crate::model::default_reasons()),
            ServiceAccountStore::new(Box::new(MemoryStore::default())),
            Poppler::resolve(None),
        );
        assert!(fresh.save_settings(language).is_ok());
        // Clearing the folder needs no grant either.
        assert!(state.save_settings(Settings::default()).is_ok());
    }

    #[test]
    fn granted_paths_match_by_real_path() {
        let state = state();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("statement.pdf");
        std::fs::write(&file, b"%PDF-1.4").unwrap();
        assert!(!state.is_granted(&file));
        state.grant_paths([file.clone()]);
        assert!(state.is_granted(&file));
        let indirect = dir.path().join(".").join("statement.pdf");
        assert!(state.is_granted(&indirect));
        assert!(state.ensure_granted([file.as_path()]).is_ok());
        let other = dir.path().join("other.pdf");
        assert_eq!(
            state
                .ensure_granted([file.as_path(), other.as_path()])
                .unwrap_err()
                .code
                .as_deref(),
            Some("path_not_chosen")
        );
    }

    #[test]
    fn refuses_invalid_gemini_settings() {
        let state = state();
        let mut settings = Settings::default();
        settings.gemini.location = "evil.com/".into();
        let error = state.save_settings(settings).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("invalid_region"));
        assert_eq!(state.settings().gemini.location, "europe-west1");
    }

    #[test]
    fn a_receipts_root_that_is_not_a_folder_counts_as_missing() {
        let state = state();
        state.grant_paths([PathBuf::from("/nonexistent/receipts")]);
        let settings = Settings {
            receipts_root: Some("/nonexistent/receipts".into()),
            ..Default::default()
        };
        let view = state.save_settings(settings).unwrap();
        assert!(view.missing.contains(&Missing::ReceiptsRoot));
        assert!(state.receipts_root().is_none());
        let period = Period::parse("2030", "03").unwrap();
        assert_eq!(
            state.period_paths(&period).unwrap_err().kind,
            ErrorKind::NotConfigured
        );
    }

    #[test]
    fn refuses_job_affecting_changes_while_busy() {
        let state = state();
        let _job = state
            .locks
            .try_exclusive(&Period::parse("2030", "03").unwrap(), RunKind::Reconcile)
            .unwrap();

        let language_only = Settings {
            language: Some(crate::model::Language::Pt),
            ..Default::default()
        };
        assert!(state.save_settings(language_only.clone()).is_ok());

        let folder = Settings {
            receipts_root: Some("/receipts".into()),
            ..language_only
        };
        assert_eq!(
            state.save_settings(folder).unwrap_err().kind,
            ErrorKind::Busy
        );
        assert_eq!(
            state.remove_service_account().unwrap_err().kind,
            ErrorKind::Busy
        );
    }

    #[test]
    fn gemini_needs_a_service_account() {
        let state = state();
        assert_eq!(
            state.gemini().err().map(|e| e.kind),
            Some(ErrorKind::NotConfigured)
        );
    }

    #[test]
    fn invalid_rules_are_refused() {
        let state = state();
        let rule = crate::model::Rule {
            id: "r1".into(),
            receipt_vendor: " ".into(),
            transaction_description: "ACME".into(),
            no_receipt: None,
        };
        assert_eq!(
            state.save_rules(vec![rule]).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn rules_of_a_removed_reason_move_to_other() {
        use crate::model::{default_reasons, Rule, OTHER_REASON};
        let state = state();
        let rule = |id: &str, reason: &str| Rule {
            id: id.into(),
            receipt_vendor: String::new(),
            transaction_description: "TRF".into(),
            no_receipt: Some(reason.into()),
        };
        state
            .save_rules(vec![rule("r1", "salary"), rule("r2", "transfer")])
            .unwrap();
        let without_salary: Vec<_> = default_reasons()
            .into_iter()
            .filter(|r| r.id != "salary")
            .collect();

        let view = state.save_reasons(without_salary.clone()).unwrap();

        assert_eq!(view.reasons, without_salary);
        assert_eq!(
            state.rules(),
            [rule("r1", OTHER_REASON), rule("r2", "transfer")]
        );
    }

    #[test]
    fn invalid_reasons_change_nothing() {
        let state = state();
        let error = state.save_reasons(Vec::new()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert_eq!(state.reasons(), crate::model::default_reasons());
    }
}
