//! Receipt paths in a period's JSON files. The files store each path relative to the period
//! folder, so the receipts folder can move without losing the review. In memory, every path
//! is absolute.

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::finalize::relative_text;
use crate::fsutil::{read_json_lenient, read_json_opt, write_json, FsError};
use crate::model::{Draft, MatchResult, ReceiptMeta};

/// Data that holds receipt paths.
pub trait StoredPaths {
    /// Replaces every receipt path with `change(path)`.
    fn map_paths(&mut self, change: &dyn Fn(&str) -> String);
}

impl StoredPaths for Vec<ReceiptMeta> {
    fn map_paths(&mut self, change: &dyn Fn(&str) -> String) {
        for meta in self {
            meta.file = change(&meta.file);
        }
    }
}

impl StoredPaths for MatchResult {
    fn map_paths(&mut self, change: &dyn Fn(&str) -> String) {
        let list = |files: &mut Vec<String>| {
            for file in files {
                *file = change(file);
            }
        };
        for tx in &mut self.transactions {
            list(&mut tx.receipt_files);
            tx.receipt_meta.map_paths(change);
        }
        list(&mut self.receipts_by_status.matched);
        list(&mut self.receipts_by_status.review);
        list(&mut self.receipts_by_status.unmatched);
        self.unmatched_receipts.map_paths(change);
    }
}

impl StoredPaths for Draft {
    fn map_paths(&mut self, change: &dyn Fn(&str) -> String) {
        let replace = |value: &mut Value| {
            if let Value::String(file) = value {
                *file = change(file);
            }
        };
        for decision in self.values_mut() {
            let Value::Object(fields) = decision else {
                continue;
            };
            if let Some(Value::Array(files)) = fields.get_mut("receipt_files") {
                files.iter_mut().for_each(replace);
            }
            if let Some(Value::Array(metas)) = fields.get_mut("receipt_meta") {
                for meta in metas {
                    if let Some(file) = meta.get_mut("file") {
                        replace(file);
                    }
                }
            }
        }
    }
}

/// `file` as stored: relative to the period folder `dir`, with `/` between the parts. A path
/// outside `dir` stays as it is.
pub fn stored_path(dir: &Path, file: &str) -> String {
    relative_text(Path::new(file), dir).unwrap_or_else(|| file.to_string())
}

/// The absolute path of a stored `file` in the period folder `dir`. An empty or absolute path
/// stays as it is. Each part of the stored path joins with the separator of the platform, so
/// the result equals the paths that a folder walk returns.
pub fn resolved_path(dir: &Path, file: &str) -> String {
    if file.is_empty() || Path::new(file).is_absolute() {
        return file.to_string();
    }
    let path = file
        .split('/')
        .fold(dir.to_path_buf(), |path, part| path.join(part));
    path.to_string_lossy().into_owned()
}

/// `value` with its paths resolved in the period folder `dir`.
pub fn resolved<T: StoredPaths>(dir: &Path, mut value: T) -> T {
    value.map_paths(&|file| resolved_path(dir, file));
    value
}

/// Reads a JSON file of the period folder `dir` with its paths resolved, or none when it does
/// not exist.
pub fn read_stored<T: DeserializeOwned + StoredPaths>(
    dir: &Path,
    file: &Path,
) -> Result<Option<T>, FsError> {
    Ok(read_json_opt::<T>(file)?.map(|value| resolved(dir, value)))
}

/// [`read_stored`] for a caller that can do without the file: a missing or damaged file reads
/// as none.
pub fn read_stored_lenient<T: DeserializeOwned + StoredPaths>(
    dir: &Path,
    file: &Path,
) -> Option<T> {
    read_json_lenient::<T>(file).map(|value| resolved(dir, value))
}

/// Writes `value` to a JSON file of the period folder `dir`, with its paths stored relative
/// to `dir`.
pub fn write_stored<T: Serialize + StoredPaths + Clone>(
    dir: &Path,
    file: &Path,
    value: &T,
) -> Result<(), FsError> {
    let mut stored = value.clone();
    stored.map_paths(&|path| stored_path(dir, path));
    write_json(file, &stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn stores_paths_inside_the_period_relative_to_it() {
        let dir = Path::new("/root/2030/03");
        assert_eq!(
            stored_path(dir, "/root/2030/03/receipts/sub/acme.pdf"),
            "receipts/sub/acme.pdf"
        );
        assert_eq!(stored_path(dir, "/other/acme.pdf"), "/other/acme.pdf");
        assert_eq!(stored_path(dir, ""), "");
        let expected: PathBuf = ["/moved/2030/03", "receipts", "sub", "acme.pdf"]
            .iter()
            .collect();
        assert_eq!(
            resolved_path(Path::new("/moved/2030/03"), "receipts/sub/acme.pdf"),
            expected.to_string_lossy()
        );
        assert_eq!(resolved_path(dir, "/other/acme.pdf"), "/other/acme.pdf");
        assert_eq!(resolved_path(dir, ""), "");
    }

    #[test]
    fn maps_every_path_of_a_draft() {
        let mut draft: Draft = serde_json::from_value(json!({
            "t1": {
                "status": "MATCHED",
                "receipt_files": ["/root/2030/03/receipts/a.pdf"],
                "receipt_meta": [{ "file": "/root/2030/03/receipts/a.pdf", "amount_cents": 1000 }],
                "notes": "manual_match"
            },
            "t2": { "notes": "transfer" }
        }))
        .unwrap();
        draft.map_paths(&|file| stored_path(Path::new("/root/2030/03"), file));
        assert_eq!(
            Value::Object(draft),
            json!({
                "t1": {
                    "status": "MATCHED",
                    "receipt_files": ["receipts/a.pdf"],
                    "receipt_meta": [{ "file": "receipts/a.pdf", "amount_cents": 1000 }],
                    "notes": "manual_match"
                },
                "t2": { "notes": "transfer" }
            })
        );
    }

    #[test]
    fn writes_relative_paths_and_reads_them_back_in_a_moved_folder() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old/2030/03");
        let file = dir.path().join("receipts.json");
        let cache = vec![ReceiptMeta {
            file: old.join("receipts/a.pdf").to_string_lossy().into_owned(),
            ..Default::default()
        }];
        write_stored(&old, &file, &cache).unwrap();
        let raw: Value = read_json_opt(&file).unwrap().unwrap();
        assert_eq!(raw[0]["file"], "receipts/a.pdf");

        let new = dir.path().join("new/2030/03");
        let back: Vec<ReceiptMeta> = read_stored(&new, &file).unwrap().unwrap();
        assert_eq!(back[0].file, new.join("receipts/a.pdf").to_string_lossy());
    }
}
