//! File helpers: atomic writes and JSON files that may not exist yet.

use std::io::Write;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{path}: {source}")]
    Json {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

fn io_error(path: &Path, source: std::io::Error) -> FsError {
    FsError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// Writes `bytes` to a temporary file next to `path`, syncs it, then renames it over `path`,
/// so readers see either the old or the new contents.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), FsError> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(path, e))?;
    file.write_all(bytes).map_err(|e| io_error(path, e))?;
    file.as_file().sync_all().map_err(|e| io_error(path, e))?;
    file.persist(path).map_err(|e| io_error(path, e.error))?;
    Ok(())
}

/// Writes `value` as JSON indented by two spaces, atomically.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), FsError> {
    let json = serde_json::to_vec_pretty(value).map_err(|source| FsError::Json {
        path: path.display().to_string(),
        source,
    })?;
    write_atomic(path, &json)
}

/// Reads a JSON file, or none when it does not exist.
pub fn read_json_opt<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, FsError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(path, e)),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|source| FsError::Json {
            path: path.display().to_string(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn writes_and_reads_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        write_json(&path, &json!({ "a": 1 })).unwrap();
        write_json(&path, &json!({ "a": 2 })).unwrap();
        assert_eq!(
            read_json_opt::<Value>(&path).unwrap(),
            Some(json!({ "a": 2 }))
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\n  \"a\": 2\n}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn reads_a_missing_file_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_json_opt::<Value>(&dir.path().join("missing.json")).unwrap(),
            None
        );
    }

    #[test]
    fn reports_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.json");
        std::fs::write(&path, b"{").unwrap();
        assert!(matches!(
            read_json_opt::<Value>(&path),
            Err(FsError::Json { .. })
        ));
    }
}
