//! State shared by every command: settings, rules, the service account, period locks, the
//! PDF tools and the Gemini client built from them.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;

use crate::config::{ConfigStore, RulesStore, Settings};
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
}

pub struct AppState {
    config: Mutex<ConfigStore>,
    rules: Mutex<RulesStore>,
    pub accounts: ServiceAccountStore,
    pub locks: Arc<PeriodLocks>,
    pub poppler: Poppler,
    gemini: Mutex<Option<Arc<GeminiClient>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl AppState {
    pub fn new(
        config: ConfigStore,
        rules: RulesStore,
        accounts: ServiceAccountStore,
        poppler: Poppler,
    ) -> AppState {
        AppState {
            config: Mutex::new(config),
            rules: Mutex::new(rules),
            accounts,
            locks: PeriodLocks::new(),
            poppler,
            gemini: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        lock(&self.config).settings().clone()
    }

    /// The receipts root, when it is set and is a folder.
    pub fn receipts_root(&self) -> Option<PathBuf> {
        self.settings().receipts_root.filter(|root| root.is_dir())
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
        let mut store = lock(&self.rules);
        store.replace(rules)??;
        Ok(store.rules().to_vec())
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
        }
    }

    /// Saves the settings. The receipts folder and the Gemini settings cannot change while a
    /// job runs.
    pub fn save_settings(&self, settings: Settings) -> CommandResult<AppStateView> {
        {
            let mut config = lock(&self.config);
            let current = config.settings().clone();
            let next = settings.normalized();
            let affects_jobs =
                current.receipts_root != next.receipts_root || current.gemini != next.gemini;
            if affects_jobs && self.locks.busy() {
                return Err(CommandError::new(
                    ErrorKind::Busy,
                    "wait for the running job to finish before changing the folder or Gemini settings",
                ));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::locks::RunKind;
    use crate::secrets::MemoryStore;

    fn state() -> AppState {
        AppState::new(
            ConfigStore::in_memory(Settings::default()),
            RulesStore::in_memory(Vec::new()),
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
        let settings = Settings {
            receipts_root: Some(dir.path().to_path_buf()),
            ..Default::default()
        };
        let view = state.save_settings(settings).unwrap();
        assert_eq!(view.missing, [Missing::ServiceAccount]);
    }

    #[test]
    fn a_receipts_root_that_is_not_a_folder_counts_as_missing() {
        let state = state();
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
        };
        assert_eq!(
            state.save_rules(vec![rule]).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }
}
