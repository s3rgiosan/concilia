//! The Gemini service account key, kept in the OS credential store: the Keychain on macOS,
//! Credential Manager on Windows and the Secret Service on Linux.

use std::sync::Mutex;

use crate::gemini::client::{GeminiError, ServiceAccount};

/// Account name of the stored item; the service is the bundle identifier.
const ITEM_ACCOUNT: &str = "service-account";
/// Debug builds keep the key in this file in the config folder.
pub const DEV_FILE_NAME: &str = "service-account.dev.json";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    #[error("the Keychain refused access: {0}")]
    AccessDenied(String),
    #[error("the stored service account key is not valid: {0}")]
    Corrupt(String),
}

/// Backing store for the single item.
pub trait SecretStore: Send + Sync {
    /// None when the item does not exist.
    fn read(&self) -> Result<Option<String>, SecretError>;
    fn write(&self, value: &str) -> Result<(), SecretError>;
    fn delete(&self) -> Result<(), SecretError>;
}

/// The OS credential store through the `keyring` crate.
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: &str) -> KeychainStore {
        KeychainStore {
            service: service.to_string(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, SecretError> {
        if self.service.is_empty() {
            return Err(SecretError::AccessDenied("empty service name".into()));
        }
        keyring::Entry::new(&self.service, ITEM_ACCOUNT)
            .map_err(|e| SecretError::AccessDenied(e.to_string()))
    }
}

impl SecretStore for KeychainStore {
    fn read(&self) -> Result<Option<String>, SecretError> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::AccessDenied(e.to_string())),
        }
    }

    fn write(&self, value: &str) -> Result<(), SecretError> {
        self.entry()?
            .set_password(value)
            .map_err(|e| SecretError::AccessDenied(e.to_string()))
    }

    fn delete(&self) -> Result<(), SecretError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::AccessDenied(e.to_string())),
        }
    }
}

/// Plain file store for debug builds. Each debug build carries a new ad-hoc signature, which
/// makes the Keychain ask again after every rebuild.
pub struct FileStore {
    path: std::path::PathBuf,
}

impl FileStore {
    pub fn new(path: std::path::PathBuf) -> FileStore {
        FileStore { path }
    }
}

impl SecretStore for FileStore {
    fn read(&self) -> Result<Option<String>, SecretError> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => Ok(Some(raw)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(SecretError::AccessDenied(e.to_string())),
        }
    }

    fn write(&self, value: &str) -> Result<(), SecretError> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| SecretError::AccessDenied(e.to_string()))?;
        }
        // Temporary files are created with mode 0600 on Unix, so the key stays private.
        crate::fsutil::write_atomic(&self.path, value.as_bytes())
            .map_err(|e| SecretError::AccessDenied(e.to_string()))
    }

    fn delete(&self) -> Result<(), SecretError> {
        crate::fsutil::remove_if_exists(&self.path)
            .map_err(|e| SecretError::AccessDenied(e.to_string()))
    }
}

/// In-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    value: Mutex<Option<String>>,
    pub fail: Mutex<bool>,
}

#[cfg(test)]
impl MemoryStore {
    pub fn with_value(value: &str) -> MemoryStore {
        MemoryStore {
            value: Mutex::new(Some(value.to_string())),
            fail: Mutex::new(false),
        }
    }

    pub fn value(&self) -> Option<String> {
        self.value.lock().unwrap().clone()
    }

    fn check(&self) -> Result<(), SecretError> {
        if *self.fail.lock().unwrap() {
            Err(SecretError::AccessDenied("denied".into()))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn read(&self) -> Result<Option<String>, SecretError> {
        self.check()?;
        Ok(self.value.lock().unwrap().clone())
    }

    fn write(&self, value: &str) -> Result<(), SecretError> {
        self.check()?;
        *self.value.lock().unwrap() = Some(value.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<(), SecretError> {
        self.check()?;
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

/// The stored service account, read from the store once and kept in memory.
pub struct ServiceAccountStore {
    store: Box<dyn SecretStore>,
    cached: Mutex<Option<Option<ServiceAccount>>>,
}

impl ServiceAccountStore {
    pub fn new(store: Box<dyn SecretStore>) -> ServiceAccountStore {
        ServiceAccountStore {
            store,
            cached: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Option<ServiceAccount>>> {
        self.cached.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The stored key, or none when there is none. A failed read is not cached, so the next
    /// call asks the store again.
    pub fn get(&self) -> Result<Option<ServiceAccount>, SecretError> {
        let mut cached = self.lock();
        if let Some(account) = cached.as_ref() {
            return Ok(account.clone());
        }
        let account = match self.store.read()? {
            None => None,
            Some(json) => Some(
                ServiceAccount::parse(&json).map_err(|e| SecretError::Corrupt(e.to_string()))?,
            ),
        };
        *cached = Some(account.clone());
        Ok(account)
    }

    /// Checks a key file's contents and stores them.
    pub fn import(&self, json: &str) -> Result<ServiceAccount, ImportError> {
        let account = ServiceAccount::parse(json).map_err(ImportError::Invalid)?;
        self.store.write(json).map_err(ImportError::Store)?;
        *self.lock() = Some(Some(account.clone()));
        Ok(account)
    }

    pub fn remove(&self) -> Result<(), SecretError> {
        self.store.delete()?;
        *self.lock() = Some(None);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImportError {
    #[error("{0}")]
    Invalid(GeminiError),
    #[error("{0}")]
    Store(SecretError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_item_reads_as_none() {
        let accounts = ServiceAccountStore::new(Box::new(MemoryStore::default()));
        assert!(accounts.get().unwrap().is_none());
    }

    #[test]
    fn rejects_invalid_imports_without_storing() {
        let store = std::sync::Arc::new(MemoryStore::default());
        let accounts = ServiceAccountStore::new(Box::new(ArcStore(store.clone())));
        assert!(matches!(
            accounts.import("{}"),
            Err(ImportError::Invalid(_))
        ));
        assert_eq!(store.value(), None);
    }

    #[test]
    fn reports_corrupt_stored_keys() {
        let accounts = ServiceAccountStore::new(Box::new(MemoryStore::with_value("not json")));
        assert!(matches!(accounts.get(), Err(SecretError::Corrupt(_))));
    }

    #[test]
    fn retries_reads_after_access_is_denied() {
        let store = std::sync::Arc::new(MemoryStore::default());
        *store.fail.lock().unwrap() = true;
        let accounts = ServiceAccountStore::new(Box::new(ArcStore(store.clone())));
        assert!(accounts.get().is_err());
        *store.fail.lock().unwrap() = false;
        assert!(accounts.get().unwrap().is_none());
    }

    #[test]
    fn file_store_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("nested").join(DEV_FILE_NAME));
        assert_eq!(store.read().unwrap(), None);
        store.write("{\"a\":1}").unwrap();
        assert_eq!(store.read().unwrap().as_deref(), Some("{\"a\":1}"));
        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.read().unwrap(), None);
    }

    /// Shares a memory store between the test and the account store.
    struct ArcStore(std::sync::Arc<MemoryStore>);

    impl SecretStore for ArcStore {
        fn read(&self) -> Result<Option<String>, SecretError> {
            self.0.read()
        }
        fn write(&self, value: &str) -> Result<(), SecretError> {
            self.0.write(value)
        }
        fn delete(&self) -> Result<(), SecretError> {
            self.0.delete()
        }
    }
}
