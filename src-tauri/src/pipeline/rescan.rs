//! Reading one receipt again and patching the stored results.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use super::{create_dir, io, off_thread, PipelineError};
use crate::error::ErrorKind;
use crate::extract::{ExtractError, ReceiptExtractor};
use crate::fsutil::{read_json_opt, write_json};
use crate::model::{MatchResult, ReceiptMeta};
use crate::period::PeriodPaths;
use crate::receipts::is_receipt_name;

/// How long a single-receipt rescan may take.
const RESCAN_TIMEOUT: Duration = Duration::from_secs(180);

/// Which folder a rescanned file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescanKind {
    Receipt,
    Reimbursement,
}

/// A file inside the period, checked: its stored path, which records refer to it by, and its
/// canonical path, which every read, open and lock uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodFile {
    pub stored: String,
    pub canonical: PathBuf,
}

/// Resolves a period-relative path (`YYYY/MM/receipts/...`) to a receipt file of `kind`,
/// rejecting anything outside its folder, missing, or whose name or real file has another
/// extension. A symlink counts only when its target is a receipt inside the same folder.
pub fn resolve_period_file(
    paths: &PeriodPaths,
    kind: RescanKind,
    relative: &str,
) -> Result<PeriodFile, PipelineError> {
    let outside = || {
        PipelineError::coded(
            ErrorKind::InvalidInput,
            "receipt_outside_period",
            "the file is not a receipt of this period",
        )
    };
    let rest = relative
        .strip_prefix(&paths.prefix)
        .and_then(|r| r.strip_prefix('/'))
        .ok_or_else(outside)?;
    let rest_path = Path::new(rest);
    if !rest_path
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(outside());
    }
    let folder = match kind {
        RescanKind::Receipt => &paths.receipts,
        RescanKind::Reimbursement => &paths.reimbursements,
    };
    let stored_path = paths.dir.join(rest_path);
    if !stored_path.starts_with(folder) || !is_receipt_name(rest) {
        return Err(outside());
    }
    let canonical = stored_path.canonicalize().map_err(|_| {
        PipelineError::coded(
            ErrorKind::NotFound,
            "file_missing",
            "the receipt file no longer exists",
        )
    })?;
    let folder_real = folder.canonicalize().map_err(|e| io(folder, e))?;
    let target_name = canonical
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    if !canonical.starts_with(&folder_real)
        || !canonical.is_file()
        || !is_receipt_name(&target_name)
    {
        return Err(outside());
    }
    Ok(PeriodFile {
        stored: stored_path.to_string_lossy().into_owned(),
        canonical,
    })
}

fn same_file(stored: &str, target: &PeriodFile) -> bool {
    stored == target.stored
        || Path::new(stored)
            .canonicalize()
            .is_ok_and(|p| p == target.canonical)
}

/// Extracts one receipt again and stores the result. The caller holds the file's rescan
/// lock; `write_lock` serializes the JSON updates with other rescans of the period.
pub async fn rescan(
    paths: &PeriodPaths,
    extractor: &dyn ReceiptExtractor,
    kind: RescanKind,
    file: &PeriodFile,
    write_lock: &tokio::sync::Mutex<()>,
) -> Result<ReceiptMeta, PipelineError> {
    let extracted = tokio::time::timeout(RESCAN_TIMEOUT, extractor.extract(&file.canonical))
        .await
        .map_err(|_| {
            PipelineError::coded(
                ErrorKind::Timeout,
                "read_timeout",
                "Gemini took too long to read the receipt",
            )
        })?;
    let mut meta = match extracted {
        Ok(meta) => meta,
        Err(ExtractError::Fatal(message)) => return Err(PipelineError::Unauthorized(message)),
        Err(ExtractError::Failed(message)) => return Err(PipelineError::Io(message)),
        Err(ExtractError::Rejected { code, message }) => {
            return Err(PipelineError::coded(ErrorKind::InvalidInput, code, message))
        }
    };
    meta.file = file.stored.clone();

    let _writing = write_lock.lock().await;
    let (paths, file, stored) = (paths.clone(), file.clone(), meta.clone());
    off_thread(move || store_rescan(&paths, kind, &file, &stored)).await??;
    Ok(meta)
}

/// Puts a rescanned receipt's metadata in the cache and, for a receipt, the match result.
fn store_rescan(
    paths: &PeriodPaths,
    kind: RescanKind,
    file: &PeriodFile,
    meta: &ReceiptMeta,
) -> Result<(), PipelineError> {
    let replace = |list: &mut Vec<ReceiptMeta>, append: bool| {
        let mut found = false;
        for entry in list.iter_mut().filter(|e| same_file(&e.file, file)) {
            *entry = ReceiptMeta {
                file: entry.file.clone(),
                ..meta.clone()
            };
            found = true;
        }
        if !found && append {
            list.push(meta.clone());
        }
    };
    match kind {
        RescanKind::Receipt => {
            let cache_path = paths.receipts_cache();
            if let Some(mut cache) = read_json_opt::<Vec<ReceiptMeta>>(&cache_path)? {
                replace(&mut cache, true);
                write_json(&cache_path, &cache)?;
            }
            if let Some(mut result) = read_json_opt::<MatchResult>(&paths.match_result())? {
                for tx in &mut result.transactions {
                    replace(&mut tx.receipt_meta, false);
                }
                replace(&mut result.unmatched_receipts, false);
                write_json(&paths.match_result(), &result)?;
            }
        }
        RescanKind::Reimbursement => {
            create_dir(&paths.docs)?;
            let cache_path = paths.reimbursements_cache();
            let mut cache = read_json_opt::<Vec<ReceiptMeta>>(&cache_path)?.unwrap_or_default();
            replace(&mut cache, true);
            write_json(&cache_path, &cache)?;
        }
    }
    Ok(())
}
