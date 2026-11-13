//! Month folders: listing, summaries, creation and reset, plus the period's statement list.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::apply::{create_target_dirs, pin_moves};
use super::reopen::after_moves;
use super::stored::{read_stored_lenient, write_stored};
use super::{io, journal, read_cache, with_stuck, PipelineError};
use crate::error::ErrorKind;
use crate::finalize::{self, folded, relative_text, Move};
use crate::fsutil::{read_json_lenient, remove_if_exists};
use crate::model::{Draft, MatchResult, Rule, StatementRecord, StatementTransaction, Status};
use crate::period::{Period, PeriodPaths};
use crate::receipts::{walk, STATUS_FOLDERS};
use crate::review::merge_draft;

/// The statements recorded for a period, oldest first; empty when none are recorded.
pub fn read_statements(paths: &PeriodPaths) -> Vec<StatementRecord> {
    read_json_lenient(&paths.statements()).unwrap_or_default()
}

/// What exists for a period.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PeriodStatus {
    /// A match result exists.
    pub exists: bool,
    pub applied: bool,
    pub has_transactions: bool,
    pub has_draft: bool,
}

pub fn period_status(paths: &PeriodPaths) -> PeriodStatus {
    PeriodStatus {
        exists: paths.match_result().exists(),
        applied: paths.applied_marker().exists(),
        has_transactions: paths.transactions().exists(),
        has_draft: paths.draft().exists(),
    }
}

/// Where a month stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeriodState {
    Empty,
    Ready,
    InReview,
    Finalized,
}

/// One month folder under the receipts root, for the month list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PeriodSummary {
    pub year: String,
    pub month: String,
    pub status: PeriodState,
    /// Receipt files waiting in the receipts folder plus those already sorted into the
    /// status folders.
    pub receipts: usize,
    pub transactions: usize,
    /// Transactions still REVIEW or UNMATCHED after the review draft; only counted while in
    /// review.
    pub pending: usize,
}

/// The `YYYY/MM` folders under `root`, newest first. Other entries are ignored.
pub fn list_periods(root: &Path) -> Vec<PeriodSummary> {
    let mut found = Vec::new();
    for year in subdirs(root) {
        for month in subdirs(&root.join(&year)) {
            if let Ok(period) = Period::parse(&year, &month) {
                found.push(summarize_period(&period, &period.paths(root)));
            }
        }
    }
    found.sort_by(|a, b| (&b.year, &b.month).cmp(&(&a.year, &a.month)));
    found
}

fn subdirs(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect()
}

/// The month-list entry of one period under `root`.
pub fn period_summary(root: &Path, period: &Period) -> PeriodSummary {
    summarize_period(period, &period.paths(root))
}

/// Creates `<root>/YYYY/MM/receipts/` one folder at a time. `root` must exist, and every
/// folder on the way must resolve inside it, so a symlink leading elsewhere is refused before
/// anything is created through it.
pub fn ensure_period_dirs(root: &Path, period: &Period) -> Result<PeriodPaths, PipelineError> {
    let root_real = root.canonicalize().map_err(|e| io(root, e))?;
    let paths = period.paths(root);
    let outside = || {
        PipelineError::coded(
            ErrorKind::InvalidInput,
            "outside_root",
            format!("{} leads outside the receipts folder", paths.prefix),
        )
    };
    let mut dir = root.to_path_buf();
    for part in [period.year(), period.month(), "receipts"] {
        dir.push(part);
        match dir.canonicalize() {
            Ok(real) => {
                if !real.starts_with(&root_real) {
                    return Err(outside());
                }
                if !real.is_dir() {
                    return Err(io(&dir, "not a folder"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if dir.symlink_metadata().is_ok() {
                    // A dangling symlink: creating through it would land outside the root.
                    return Err(outside());
                }
                std::fs::create_dir(&dir).map_err(|e| io(&dir, e))?;
            }
            Err(error) => return Err(io(&dir, error)),
        }
    }
    Ok(paths)
}

fn summarize_period(period: &Period, paths: &PeriodPaths) -> PeriodSummary {
    let mut receipts = walk(&paths.receipts).len();
    for folder in STATUS_FOLDERS {
        receipts += walk(&paths.receipts.join(folder)).len();
    }
    let result: Option<MatchResult> = read_json_lenient(&paths.match_result());
    let applied = paths.applied_marker().exists();
    let status = if applied {
        PeriodState::Finalized
    } else if paths.match_result().exists() {
        PeriodState::InReview
    } else if receipts > 0 || paths.transactions().exists() {
        PeriodState::Ready
    } else {
        PeriodState::Empty
    };
    let transactions = match &result {
        Some(result) => result.transactions.len(),
        None => read_json_lenient::<Vec<Value>>(&paths.transactions()).map_or(0, |list| list.len()),
    };
    let pending = match (&result, status) {
        (Some(result), PeriodState::InReview) => pending_count(result, paths),
        _ => 0,
    };
    PeriodSummary {
        year: period.year().to_string(),
        month: period.month().to_string(),
        status,
        receipts,
        transactions,
        pending,
    }
}

fn pending_count(result: &MatchResult, paths: &PeriodPaths) -> usize {
    let draft: Draft = read_json_lenient(&paths.draft()).unwrap_or_default();
    let merged = merge_draft(result, &draft).unwrap_or_else(|error| {
        log::warn!("ignoring review draft of {}: {error}", paths.prefix);
        result.transactions.clone()
    });
    merged
        .iter()
        .filter(|tx| matches!(tx.status, Status::Review | Status::Unmatched))
        .count()
}

/// What resetting a period did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResetReport {
    pub restored: usize,
    /// For a finalized period, its final result with the paths the receipts moved back to.
    pub finalized: Option<MatchResult>,
}

/// `<base>-restored<ext>`, then `<base>-restored-2<ext>` and so on.
fn restored_name(name: &str, n: usize) -> String {
    let (base, ext) = match name.rfind('.') {
        Some(dot) => name.split_at(dot),
        None => (name, ""),
    };
    if n == 1 {
        format!("{base}-restored{ext}")
    } else {
        format!("{base}-restored-{n}{ext}")
    }
}

/// `original` as a place inside `receipts/` to restore a receipt to: a relative path of plain
/// parts outside the status folders. Any other path gives none.
fn restorable(original: &str) -> Option<&Path> {
    let path = Path::new(original);
    let first = path.components().next()?;
    let plain = path.components().all(|c| matches!(c, Component::Normal(_)));
    let sorted = STATUS_FOLDERS
        .iter()
        .any(|folder| first.as_os_str() == *folder);
    (plain && !sorted).then_some(path)
}

/// The moves that bring every sorted receipt back into `receipts/`, sorted by source. A receipt
/// goes back to the path the match result records for it, else to the top of `receipts/` with
/// its current name. Only regular files move: hidden files such as `.DS_Store`, subfolders,
/// symlinks and status folders that are symlinks stay where they are. Name clashes get a
/// `-restored` suffix; a file with no free name is left out and reported in `warnings`.
pub(super) fn restore_moves(paths: &PeriodPaths, warnings: &mut Vec<String>) -> Vec<Move> {
    let original_paths = read_json_lenient::<MatchResult>(&paths.match_result())
        .map(|result| result.original_paths)
        .unwrap_or_default();
    let mut sources: Vec<PathBuf> = Vec::new();
    for folder in STATUS_FOLDERS {
        let dir = paths.receipts.join(folder);
        let is_real_dir = std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir());
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        if !is_real_dir {
            warnings.push(format!("{folder} is not a folder; its files stay in place"));
            continue;
        }
        sources.extend(
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
                .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
                .map(|entry| entry.path()),
        );
    }
    sources.sort();
    let mut reserved: HashSet<String> = HashSet::new();
    let mut moves = Vec::new();
    for from in sources {
        let original = relative_text(&from, &paths.receipts)
            .and_then(|sorted| original_paths.get(&sorted))
            .and_then(|original| restorable(original));
        let wanted = match original {
            Some(original) => paths.receipts.join(original),
            None => paths.receipts.join(from.file_name().unwrap_or_default()),
        };
        let dir = wanted.parent().unwrap_or(&paths.receipts).to_path_buf();
        let name = wanted
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let taken = |path: &Path| path.exists() || reserved.contains(&folded(path));
        let mut target = wanted.clone();
        let mut n = 1;
        while taken(&target) && n <= 10_000 {
            target = dir.join(restored_name(&name, n));
            n += 1;
        }
        if taken(&target) {
            warnings.push(format!("no free name to restore {name}"));
            continue;
        }
        reserved.insert(folded(&target));
        moves.push(Move { from, to: target });
    }
    moves
}

/// Moves finalized receipts back to where Finalize took them from and deletes the extraction
/// cache, the match result and the finalized marker. Transactions, reimbursements, the draft
/// and the report stay. Name clashes get a `-restored` suffix. A finalized period keeps its
/// review decisions: the reset adds them to the draft, as Reopen does, with the paths the
/// receipts moved back to.
///
/// A receipt that cannot move back stops the reset with an error. The moves already made are
/// undone, and nothing is deleted, so no receipt is left behind in a status folder. A marker,
/// result or cache file that cannot be deleted also stops the reset with an error.
pub fn reset_period(paths: &PeriodPaths, rules: &[Rule]) -> Result<ResetReport, PipelineError> {
    let mut warnings = Vec::new();
    let moves = restore_moves(paths, &mut warnings);
    if !warnings.is_empty() {
        return Err(PipelineError::Io(format!(
            "cannot move every receipt back: {}",
            warnings.join("; ")
        )));
    }
    let kept = finalized_decisions(paths, &moves, rules);
    let mut pinned = Vec::new();
    if !moves.is_empty() {
        pinned = pin_moves(paths, &moves)?;
        create_target_dirs(paths, &pinned)?;
        journal::write(paths, &pinned, false, &[])?;
        if let Err(failure) = finalize::execute(&pinned) {
            if failure.stuck.is_empty() {
                journal::clear(paths);
            }
            return Err(io(&paths.receipts, failure));
        }
    }
    if let Some((_, decisions)) = &kept {
        if let Err(error) = keep_decisions(paths, decisions) {
            let stuck = finalize::undo(&pinned);
            if stuck.is_empty() {
                journal::clear(paths);
            }
            return Err(with_stuck(error, &stuck));
        }
    }
    // The marker goes first: once it is gone, the reset counts as done. A marker that stays
    // puts the receipts back in their status folders.
    let marker = paths.applied_marker();
    if let Err(error) = remove_if_exists(&marker) {
        let stuck = finalize::undo(&pinned);
        if stuck.is_empty() {
            journal::clear(paths);
        }
        return Err(with_stuck(io(&marker, error), &stuck));
    }
    for file in [paths.match_result(), paths.receipts_cache()] {
        remove_if_exists(&file).map_err(|error| io(&file, error))?;
    }
    journal::clear(paths);
    Ok(ResetReport {
        restored: moves.len(),
        finalized: kept.map(|(result, _)| result),
    })
}

/// The review decisions of a finalized period as a draft, with the receipt paths that `moves`
/// give, and its final result with the same paths. None when the period is not finalized or
/// its files cannot be read.
fn finalized_decisions(
    paths: &PeriodPaths,
    moves: &[Move],
    rules: &[Rule],
) -> Option<(MatchResult, Draft)> {
    if !paths.applied_marker().exists() {
        return None;
    }
    let finalized: MatchResult = read_stored_lenient(&paths.dir, &paths.match_result())?;
    let transactions: Vec<StatementTransaction> = read_json_lenient(&paths.transactions())?;
    let cache = read_cache(&paths.dir, &paths.receipts_cache());
    let (relocated, reopened) = after_moves(paths, &finalized, &transactions, &cache, moves, rules);
    Some((relocated, reopened.draft))
}

/// Lays `decisions` over the saved draft and saves it.
fn keep_decisions(paths: &PeriodPaths, decisions: &Draft) -> Result<(), PipelineError> {
    if decisions.is_empty() {
        return Ok(());
    }
    let mut draft: Draft = read_stored_lenient(&paths.dir, &paths.draft()).unwrap_or_default();
    draft.extend(decisions.clone());
    Ok(write_stored(&paths.dir, &paths.draft(), &draft)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn result_json(statuses: &[&str]) -> String {
        let transactions: Vec<Value> = statuses
            .iter()
            .enumerate()
            .map(|(i, status)| {
                serde_json::json!({
                    "id": format!("tx-{i}"),
                    "date": "2030-03-01",
                    "description": "ACME",
                    "amount_cents": -1000,
                    "abs_cents": 1000,
                    "status": status,
                })
            })
            .collect();
        serde_json::json!({ "transactions": transactions }).to_string()
    }

    fn summary_of(root: &Path, year: &str, month: &str) -> PeriodSummary {
        list_periods(root)
            .into_iter()
            .find(|p| p.year == year && p.month == month)
            .unwrap()
    }

    #[test]
    fn lists_nothing_for_a_missing_root() {
        assert!(list_periods(Path::new("/nonexistent/concilia-root")).is_empty());
    }

    #[test]
    fn empty_month_has_no_receipts_or_transactions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("2030/03")).unwrap();
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.status, PeriodState::Empty);
        assert_eq!((s.receipts, s.transactions, s.pending), (0, 0, 0));
    }

    #[test]
    fn receipts_make_a_month_ready_and_count_sorted_files() {
        let dir = tempfile::tempdir().unwrap();
        let month = dir.path().join("2030/03");
        write(&month.join("receipts/acme.pdf"), "x");
        write(&month.join("receipts/sub/globex.PNG"), "x");
        write(&month.join("receipts/notes.txt"), "x");
        write(&month.join("receipts/_matched/hooli.pdf"), "x");
        write(&month.join("receipts/_review/initech.jpg"), "x");
        write(&month.join("receipts/_unmatched/umbrella.pdf"), "x");
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.status, PeriodState::Ready);
        assert_eq!(s.receipts, 5);
    }

    #[test]
    fn transactions_alone_make_a_month_ready() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("2030/03/docs/transactions.json"),
            "[{\"id\":\"a\"},{\"id\":\"b\"}]",
        );
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.status, PeriodState::Ready);
        assert_eq!(s.transactions, 2);
    }

    #[test]
    fn match_result_means_in_review_with_pending_through_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("2030/03/docs");
        write(
            &docs.join("match-result.json"),
            &result_json(&["MATCHED", "REVIEW", "UNMATCHED", "UNMATCHED"]),
        );
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.status, PeriodState::InReview);
        assert_eq!((s.transactions, s.pending), (4, 3));

        write(
            &docs.join("review-draft.json"),
            "{\"tx-1\":{\"status\":\"MATCHED\"},\"tx-2\":{\"status\":\"MATCHED\"}}",
        );
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.pending, 1);
    }

    #[test]
    fn applied_marker_means_finalized_with_no_pending() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("2030/03/docs");
        write(&docs.join("match-result.json"), &result_json(&["REVIEW"]));
        write(&docs.join(".applied"), "2030-04-01T00:00:00Z");
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.status, PeriodState::Finalized);
        assert_eq!((s.transactions, s.pending), (1, 0));
    }

    #[test]
    fn unreadable_json_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("2030/03/docs");
        write(&docs.join("match-result.json"), "{ not json");
        write(&docs.join("transactions.json"), "also not json");
        write(&docs.join("review-draft.json"), "nope");
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.status, PeriodState::InReview);
        assert_eq!((s.transactions, s.pending), (0, 0));

        write(&docs.join("match-result.json"), &result_json(&["REVIEW"]));
        let s = summary_of(dir.path(), "2030", "03");
        assert_eq!(s.pending, 1);
    }

    #[test]
    fn ignores_invalid_names_and_files_and_sorts_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        for sub in [
            "2029/12", "2030/01", "2030/03", "2030/13", "2030/00", "2030/3", "30/01", "abcd/01",
            "backup",
        ] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        write(&dir.path().join("2031/05"), "a file, not a folder");
        let months: Vec<String> = list_periods(dir.path())
            .iter()
            .map(|p| format!("{}-{}", p.year, p.month))
            .collect();
        assert_eq!(months, ["2030-03", "2030-01", "2029-12"]);
    }

    #[test]
    fn serializes_states_in_snake_case() {
        let json = serde_json::to_value(PeriodState::InReview).unwrap();
        assert_eq!(json, serde_json::json!("in_review"));
    }

    #[test]
    fn restores_only_to_plain_paths_outside_the_status_folders() {
        assert_eq!(restorable("sub/acme.pdf"), Some(Path::new("sub/acme.pdf")));
        assert_eq!(restorable("acme.pdf"), Some(Path::new("acme.pdf")));
        for refused in [
            "",
            "/acme.pdf",
            "../acme.pdf",
            "sub/../acme.pdf",
            "_matched/acme.pdf",
        ] {
            assert_eq!(restorable(refused), None, "{refused}");
        }
    }

    #[test]
    fn restores_a_recorded_path_and_falls_back_to_the_name() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Period::parse("2030", "03").unwrap().paths(dir.path());
        write(&paths.receipts.join("_matched/acme-1.pdf"), "a");
        write(&paths.receipts.join("_matched/globex.pdf"), "g");
        write(&paths.receipts.join("_unmatched/escape.pdf"), "e");
        write(
            &paths.match_result(),
            &serde_json::json!({
                "transactions": [],
                "originalPaths": {
                    "_matched/acme-1.pdf": "2030-03/acme.pdf",
                    "_unmatched/escape.pdf": "../escape.pdf"
                }
            })
            .to_string(),
        );
        let mut warnings = Vec::new();
        let moves = restore_moves(&paths, &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        let targets: Vec<PathBuf> = moves.into_iter().map(|m| m.to).collect();
        assert_eq!(
            targets,
            [
                paths.receipts.join("2030-03/acme.pdf"),
                paths.receipts.join("globex.pdf"),
                paths.receipts.join("escape.pdf"),
            ]
        );
    }

    #[test]
    fn names_restored_files() {
        assert_eq!(restored_name("acme.pdf", 1), "acme-restored.pdf");
        assert_eq!(restored_name("acme.pdf", 2), "acme-restored-2.pdf");
        assert_eq!(restored_name("noext", 1), "noext-restored");
    }
}
