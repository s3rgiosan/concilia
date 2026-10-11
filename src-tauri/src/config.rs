//! `config.json` (settings) and `rules.json` (match rules) in the app's config folder.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::fsutil::write_json;
use crate::gemini::client::{
    check_location, check_model, check_project, InvalidSetting, DEFAULT_LOCATION, DEFAULT_MODEL,
};
use crate::model::{Language, Rule};

const SCHEMA_VERSION: u32 = 1;
pub const FILE_NAME: &str = "config.json";
pub const RULES_FILE_NAME: &str = "rules.json";
/// Debug builds use their own files so they never touch a release build's settings.
pub const DEV_FILE_NAME: &str = "config.dev.json";
pub const DEV_RULES_FILE_NAME: &str = "rules.dev.json";

/// Which Google Cloud project, region and model reads the receipts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GeminiSettings {
    /// None uses the service account's own project.
    pub project: Option<String>,
    pub location: String,
    pub model: String,
}

impl Default for GeminiSettings {
    fn default() -> GeminiSettings {
        GeminiSettings {
            project: None,
            location: DEFAULT_LOCATION.into(),
            model: DEFAULT_MODEL.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// None until the user picks one; the windows then follow the system language.
    pub language: Option<Language>,
    /// The folder holding the `<year>/<month>/` period folders.
    pub receipts_root: Option<PathBuf>,
    pub gemini: GeminiSettings,
    /// Whether Concilia looks for a new release a minute after launch and daily.
    pub check_for_updates: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            language: None,
            receipts_root: None,
            gemini: GeminiSettings::default(),
            check_for_updates: true,
        }
    }
}

impl Settings {
    /// Trims text fields and treats blank ones as unset.
    pub fn normalized(mut self) -> Settings {
        let trimmed = |value: String, fallback: &str| {
            let value = value.trim().to_string();
            if value.is_empty() {
                fallback.to_string()
            } else {
                value
            }
        };
        self.gemini.project = self
            .gemini
            .project
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        self.gemini.location = trimmed(self.gemini.location, DEFAULT_LOCATION);
        self.gemini.model = trimmed(self.gemini.model, DEFAULT_MODEL);
        self.receipts_root = self.receipts_root.filter(|p| !p.as_os_str().is_empty());
        self
    }

    /// Checks that the region, project and model can be part of the Gemini API address.
    pub fn validate(&self) -> Result<(), InvalidSetting> {
        check_location(&self.gemini.location)?;
        if let Some(project) = &self.gemini.project {
            check_project(project)?;
        }
        check_model(&self.gemini.model)
    }

    /// The report's language: the chosen one, English when none is chosen.
    pub fn report_language(&self) -> Language {
        self.language.unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(default = "current_version")]
    schema_version: u32,
    #[serde(default)]
    settings: Settings,
}

fn current_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read or write {0}")]
    Io(String),
    #[error("{0} is not valid: {1}")]
    Parse(String, String),
    #[error("the settings were saved by a newer Concilia and are read-only")]
    ReadOnly,
}

/// Reads a JSON file, or none when it does not exist. A file that does not parse is moved
/// aside as `<name>.corrupt-<unix time>` and read as missing.
fn load_or_recover<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, ConfigError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ConfigError::Io(format!("{}: {e}", path.display()))),
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let backup = path.with_file_name(format!("{name}.corrupt-{stamp}"));
            log::error!(
                "{} does not parse ({error}); moving it to {}",
                path.display(),
                backup.display()
            );
            fs::rename(path, &backup)
                .map_err(|e| ConfigError::Io(format!("{}: {e}", path.display())))?;
            Ok(None)
        }
    }
}

fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), ConfigError> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| ConfigError::Io(format!("{}: {e}", dir.display())))?;
    }
    write_json(path, value).map_err(|e| ConfigError::Io(e.to_string()))
}

/// Owns `config.json`. Saves are atomic and refused when the file is newer than this build.
#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
    settings: Settings,
    read_only: bool,
}

impl ConfigStore {
    pub fn load(path: &Path) -> Result<ConfigStore, ConfigError> {
        let file: Option<ConfigFile> = load_or_recover(path)?;
        let read_only = file
            .as_ref()
            .is_some_and(|f| f.schema_version > SCHEMA_VERSION);
        if read_only {
            log::warn!(
                "{} has a newer schema; settings are read-only",
                path.display()
            );
        }
        Ok(ConfigStore {
            path: path.to_path_buf(),
            settings: file.map(|f| f.settings.normalized()).unwrap_or_default(),
            read_only,
        })
    }

    /// A store that keeps settings in memory only.
    pub fn in_memory(settings: Settings) -> ConfigStore {
        ConfigStore {
            path: PathBuf::new(),
            settings,
            read_only: false,
        }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Replaces the settings and writes the file. Nothing changes in memory when the write fails.
    pub fn replace(&mut self, settings: Settings) -> Result<(), ConfigError> {
        if self.read_only {
            return Err(ConfigError::ReadOnly);
        }
        let settings = settings.normalized();
        save(
            &self.path,
            &ConfigFile {
                schema_version: SCHEMA_VERSION,
                settings: settings.clone(),
            },
        )?;
        self.settings = settings;
        Ok(())
    }
}

/// Owns `rules.json`.
#[derive(Debug)]
pub struct RulesStore {
    path: PathBuf,
    rules: Vec<Rule>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("rule {index}: both the receipt vendor and the transaction description are required")]
pub struct InvalidRule {
    pub index: usize,
}

impl RulesStore {
    pub fn load(path: &Path) -> Result<RulesStore, ConfigError> {
        Ok(RulesStore {
            path: path.to_path_buf(),
            rules: load_or_recover(path)?.unwrap_or_default(),
        })
    }

    pub fn in_memory(rules: Vec<Rule>) -> RulesStore {
        RulesStore {
            path: PathBuf::new(),
            rules,
        }
    }

    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    /// Trims and checks the rules, then saves them.
    pub fn replace(&mut self, rules: Vec<Rule>) -> Result<Result<(), InvalidRule>, ConfigError> {
        let mut cleaned = Vec::with_capacity(rules.len());
        for (index, rule) in rules.into_iter().enumerate() {
            let rule = Rule {
                id: rule.id.trim().to_string(),
                receipt_vendor: rule.receipt_vendor.trim().to_string(),
                transaction_description: rule.transaction_description.trim().to_string(),
            };
            if rule.receipt_vendor.is_empty() || rule.transaction_description.is_empty() {
                return Ok(Err(InvalidRule { index }));
            }
            cleaned.push(rule);
        }
        save(&self.path, &cleaned)?;
        self.rules = cleaned;
        Ok(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(vendor: &str, description: &str) -> Rule {
        Rule {
            id: "r1".into(),
            receipt_vendor: vendor.into(),
            transaction_description: description.into(),
        }
    }

    #[test]
    fn a_missing_file_starts_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::load(&dir.path().join(FILE_NAME)).unwrap();
        assert_eq!(store.settings(), &Settings::default());
        assert!(store.settings().check_for_updates);
        assert_eq!(store.settings().gemini.location, "europe-west1");
        assert_eq!(store.settings().gemini.model, "gemini-2.5-flash");
    }

    #[test]
    fn saves_and_reloads_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        let mut store = ConfigStore::load(&path).unwrap();
        let settings = Settings {
            language: Some(Language::Pt),
            receipts_root: Some("/receipts".into()),
            gemini: GeminiSettings {
                project: Some("  acme-test ".into()),
                model: "   ".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        store.replace(settings).unwrap();

        let reloaded = ConfigStore::load(&path).unwrap();
        assert_eq!(reloaded.settings().language, Some(Language::Pt));
        assert_eq!(
            reloaded.settings().gemini.project.as_deref(),
            Some("acme-test")
        );
        assert_eq!(reloaded.settings().gemini.model, "gemini-2.5-flash");
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["schema_version"], 1);
    }

    #[test]
    fn validates_the_gemini_settings() {
        let with = |location: &str, project: Option<&str>, model: &str| Settings {
            gemini: GeminiSettings {
                project: project.map(str::to_string),
                location: location.into(),
                model: model.into(),
            },
            ..Default::default()
        };
        assert_eq!(Settings::default().validate(), Ok(()));
        assert_eq!(
            with("global", Some("acme-test"), "gemini-2.5-flash").validate(),
            Ok(())
        );
        assert_eq!(
            with("evil.com/", None, "gemini-2.5-flash").validate(),
            Err(InvalidSetting::Region)
        );
        assert_eq!(
            with("europe-west1", Some("ACME"), "gemini-2.5-flash").validate(),
            Err(InvalidSetting::Project)
        );
        assert_eq!(
            with("europe-west1", None, "gemini/../x").validate(),
            Err(InvalidSetting::Model)
        );
    }

    #[test]
    fn moves_a_corrupt_file_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, b"{ not json").unwrap();
        let store = ConfigStore::load(&path).unwrap();
        assert_eq!(store.settings(), &Settings::default());
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("config.json.corrupt-"), "{names:?}");
    }

    #[test]
    fn a_newer_schema_is_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(
            &path,
            br#"{"schema_version": 99, "settings": {"language": "pt"}}"#,
        )
        .unwrap();
        let mut store = ConfigStore::load(&path).unwrap();
        assert!(store.read_only());
        assert_eq!(store.settings().language, Some(Language::Pt));
        assert!(matches!(
            store.replace(Settings::default()),
            Err(ConfigError::ReadOnly)
        ));
    }

    #[test]
    fn rules_are_trimmed_validated_and_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RULES_FILE_NAME);
        let mut store = RulesStore::load(&path).unwrap();
        assert!(store.rules().is_empty());

        assert_eq!(
            store
                .replace(vec![rule("ACME", "ACME"), rule("  ", "X")])
                .unwrap(),
            Err(InvalidRule { index: 1 })
        );
        assert!(store.rules().is_empty());

        store
            .replace(vec![rule(" ACME ", " ACME CORP ")])
            .unwrap()
            .unwrap();
        let reloaded = RulesStore::load(&path).unwrap();
        assert_eq!(reloaded.rules(), [rule("ACME", "ACME CORP")]);
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json[0]["receiptVendor"], "ACME");
    }
}
