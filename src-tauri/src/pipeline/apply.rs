//! Finalize: sorts the receipts into their status folders and writes the final results.

use std::path::{Component, Path};

use super::{create_dir, io, read_cache, PipelineError};
use crate::dates::time_now_iso;
use crate::excel;
use crate::finalize::{self, Move};
use crate::fsutil::{read_json_opt, remove_if_exists, write_atomic, write_json};
use crate::model::{Draft, Language, MatchResult, ReceiptMeta};
use crate::period::PeriodPaths;
use crate::receipts::STATUS_FOLDERS;
use crate::review::{effective_unmatched, merge_draft};

/// Whether a stored receipt path lies inside the period's `receipts/` folder. Existing files
/// are compared by their real paths, so a root reached through a symlink still counts.
fn inside_receipts(paths: &PeriodPaths, file: &str) -> bool {
    let path = Path::new(file);
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    match (path.canonicalize(), paths.receipts.canonicalize()) {
        (Ok(real), Ok(folder)) => real.starts_with(folder),
        _ => path.starts_with(&paths.receipts),
    }
}

/// Applies the review: moves every receipt into its status folder, writes the final match
/// result and report, marks the period finalized and deletes the draft. Either every file
/// moves and both files are written, or nothing changes.
pub fn finalize(paths: &PeriodPaths, language: Language) -> Result<(), PipelineError> {
    let result: MatchResult =
        read_json_opt(&paths.match_result())?.ok_or_else(PipelineError::not_reconciled)?;
    let draft: Draft = read_json_opt(&paths.draft())?.unwrap_or_default();
    let merged =
        merge_draft(&result, &draft).map_err(|e| PipelineError::InvalidInput(e.to_string()))?;
    let unmatched = effective_unmatched(&result, &merged);
    let reimbursements: Vec<ReceiptMeta> = read_cache(&paths.reimbursements_cache());

    let plan = finalize::plan(
        &merged,
        &unmatched,
        &paths.receipts,
        |f| inside_receipts(paths, f),
        Path::exists,
    );
    let final_result = MatchResult {
        transactions: plan.transactions,
        receipts_by_status: plan.receipts_by_status,
        unmatched_receipts: plan.unmatched_receipts,
    };

    let result_tmp = paths.docs.join("match-result.json.tmp");
    let report_tmp = paths.docs.join("report.xlsx.tmp");
    let cleanup = || {
        let _ = remove_if_exists(&result_tmp);
        let _ = remove_if_exists(&report_tmp);
    };
    let prepared = write_json(&result_tmp, &final_result)
        .map_err(PipelineError::from)
        .and_then(|_| {
            let sheets = excel::build(&final_result, &reimbursements, language);
            excel::write(&sheets, &report_tmp).map_err(|e| io(&report_tmp, e))
        });
    if let Err(error) = prepared {
        cleanup();
        return Err(error);
    }

    for folder in STATUS_FOLDERS {
        if let Err(error) = create_dir(&paths.receipts.join(folder)) {
            cleanup();
            return Err(error);
        }
    }
    let moves = match pin_moves(paths, &plan.moves) {
        Ok(moves) => moves,
        Err(error) => {
            cleanup();
            return Err(error);
        }
    };
    if let Err(error) = finalize::execute(&moves) {
        cleanup();
        return Err(io(&paths.receipts, error));
    }
    if let Err(error) = publish(paths, &result_tmp, &report_tmp) {
        finalize::undo(&moves);
        cleanup();
        return Err(error);
    }
    if let Err(error) = remove_if_exists(&paths.draft()) {
        log::warn!("could not delete the review draft: {error}");
    }
    Ok(())
}

/// The moves with both ends under the real `receipts/` folder: each source is its folder's
/// real path plus its file name, so a folder swapped for a symlink after the check cannot
/// redirect a move. Fails when a source leads outside the folder.
fn pin_moves(paths: &PeriodPaths, moves: &[Move]) -> Result<Vec<Move>, PipelineError> {
    let receipts_real = paths
        .receipts
        .canonicalize()
        .map_err(|e| io(&paths.receipts, e))?;
    let outside = |path: &Path| {
        PipelineError::InvalidInput(format!(
            "{} is not inside the receipts folder",
            path.display()
        ))
    };
    moves
        .iter()
        .map(|step| {
            let name = step.from.file_name().ok_or_else(|| outside(&step.from))?;
            let parent = step.from.parent().ok_or_else(|| outside(&step.from))?;
            let from = parent.canonicalize().map_err(|e| io(parent, e))?.join(name);
            let to = step
                .to
                .strip_prefix(&paths.receipts)
                .map(|rest| receipts_real.join(rest))
                .map_err(|_| outside(&step.to))?;
            if !from.starts_with(&receipts_real) {
                return Err(outside(&step.from));
            }
            Ok(Move { from, to })
        })
        .collect()
}

/// The contents of a file before Finalize replaces it, to put back if a later step fails.
struct Backup<'a> {
    path: &'a Path,
    bytes: Option<Vec<u8>>,
}

impl<'a> Backup<'a> {
    fn take(path: &'a Path) -> Result<Backup<'a>, PipelineError> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io(path, error)),
        };
        Ok(Backup { path, bytes })
    }

    fn restore(&self) {
        let restored = match &self.bytes {
            Some(bytes) => write_atomic(self.path, bytes).map_err(|e| e.to_string()),
            None => remove_if_exists(self.path).map_err(|e| e.to_string()),
        };
        if let Err(error) = restored {
            log::error!(
                "finalize rollback failed for {}: {error}",
                self.path.display()
            );
        }
    }
}

/// Puts the final match result and report in place and writes the applied marker. When a step
/// fails, the match result and report are restored.
fn publish(paths: &PeriodPaths, result_tmp: &Path, report_tmp: &Path) -> Result<(), PipelineError> {
    let result_path = paths.match_result();
    let report_path = paths.report();
    let backups = [Backup::take(&result_path)?, Backup::take(&report_path)?];
    let outcome = std::fs::rename(result_tmp, &result_path)
        .map_err(|e| io(&result_path, e))
        .and_then(|_| std::fs::rename(report_tmp, &report_path).map_err(|e| io(&report_path, e)))
        .and_then(|_| {
            write_atomic(&paths.applied_marker(), time_now_iso().as_bytes())
                .map_err(PipelineError::from)
        });
    if outcome.is_err() {
        for backup in &backups {
            backup.restore();
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::period::Period;

    fn paths(root: &Path) -> PeriodPaths {
        let paths = Period::parse("2030", "03").unwrap().paths(root);
        std::fs::create_dir_all(&paths.receipts).unwrap();
        paths
    }

    #[test]
    fn pins_moves_to_the_real_receipts_folder() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        let step = Move {
            from: paths.receipts.join("acme.pdf"),
            to: paths.receipts.join("_matched").join("acme.pdf"),
        };
        let pinned = pin_moves(&paths, &[step]).unwrap();
        let real = paths.receipts.canonicalize().unwrap();
        assert_eq!(pinned[0].from, real.join("acme.pdf"));
        assert_eq!(pinned[0].to, real.join("_matched").join("acme.pdf"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_source_folder_that_leads_outside() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), paths.receipts.join("sub")).unwrap();
        let step = Move {
            from: paths.receipts.join("sub").join("acme.pdf"),
            to: paths.receipts.join("_matched").join("acme.pdf"),
        };
        let error = pin_moves(&paths, &[step]).unwrap_err();
        assert!(matches!(error, PipelineError::InvalidInput(_)), "{error:?}");
    }
}
