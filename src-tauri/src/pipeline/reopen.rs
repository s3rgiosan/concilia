//! Reopen: brings a finalized period back to review. The sorted receipts move back into
//! `receipts/`, and every decision the finalized result holds is kept, so a scan can add new
//! receipts without losing the review.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use super::apply::{pin_moves, Backup};
use super::draft::match_with_draft;
use super::periods::restore_moves;
use super::{io, read_cache, readable, PipelineError};
use crate::error::ErrorKind;
use crate::finalize;
use crate::fsutil::{read_json_opt, remove_if_exists, write_json};
use crate::matcher::match_transactions;
use crate::model::{
    Draft, FileIdentity, MatchResult, ReceiptMeta, ReceiptsByStatus, Rule, StatementTransaction,
    Transaction,
};
use crate::period::PeriodPaths;
use crate::receipts::{is_receipt_name, walk};

/// What reopening a period did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenReport {
    /// Receipts moved back into `receipts/`.
    pub restored: usize,
    /// Transactions whose finalized decision differs from what the matcher finds, kept as
    /// review decisions.
    pub kept_decisions: usize,
}

/// The files a reopened period gets, computed before anything moves.
struct Reopened {
    cache: Vec<ReceiptMeta>,
    result: MatchResult,
    draft: Draft,
}

/// Moves the receipts of a finalized period back into `receipts/` and returns the period to
/// review with the same decisions. The match result becomes what the matcher finds now, and
/// every finalized transaction that differs from it becomes a draft decision. The extraction
/// cache follows the moved files, so no receipt is read again.
///
/// Everything is computed and written to temporary files first. Either every receipt moves
/// back and the period leaves Finalize, or the files and the period stay as they were. A
/// receipt that cannot move back refuses the whole reopen.
pub fn reopen(paths: &PeriodPaths, rules: &[Rule]) -> Result<ReopenReport, PipelineError> {
    if !paths.applied_marker().exists() {
        return Err(PipelineError::coded(
            ErrorKind::InvalidInput,
            "not_finalized",
            "this period is not finalized",
        ));
    }
    let finalized: MatchResult =
        read_json_opt(&paths.match_result())?.ok_or_else(PipelineError::not_reconciled)?;
    let transactions: Vec<StatementTransaction> =
        read_json_opt(&paths.transactions())?.ok_or_else(PipelineError::not_reconciled)?;
    let cache = read_cache(&paths.receipts_cache());

    let mut warnings = Vec::new();
    let moves = restore_moves(paths, &mut warnings);
    if !warnings.is_empty() {
        return Err(PipelineError::Io(format!(
            "cannot move every receipt back: {}",
            warnings.join("; ")
        )));
    }
    let pinned = pin_moves(paths, &moves)?;

    // The files `receipts/` will hold once the moves are done.
    let mut present: HashSet<String> = walk(&paths.receipts).into_iter().collect();
    present.extend(
        moves
            .iter()
            .filter(|m| moved_receipt(&m.to))
            .map(|m| text(&m.to)),
    );
    let moved: HashMap<String, String> =
        moves.iter().map(|m| (text(&m.from), text(&m.to))).collect();
    // A move keeps a file's size and time, so a file still to move back is checked at its
    // source.
    let sources: HashMap<String, &Path> = moves
        .iter()
        .map(|m| (text(&m.to), m.from.as_path()))
        .collect();
    let identity = |file: &str| match sources.get(file) {
        Some(from) => FileIdentity::of(from),
        None => FileIdentity::of(Path::new(file)),
    };
    let reopened = reopened(
        &relocated(&finalized, &moved),
        &transactions,
        &cache,
        &present,
        &identity,
        rules,
    );

    let staged = Staged::write(paths, &reopened)?;
    if let Err(error) = finalize::execute(&pinned) {
        staged.discard();
        return Err(io(&paths.receipts, error));
    }
    if let Err(error) = staged.publish(paths) {
        finalize::undo(&pinned);
        return Err(error);
    }
    Ok(ReopenReport {
        restored: moves.len(),
        kept_decisions: reopened.draft.len(),
    })
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Whether a file moved back is one `walk` lists as a receipt.
fn moved_receipt(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| is_receipt_name(&name.to_string_lossy()))
}

/// The cache, match result and draft for the receipts in `present`. `identity` gives the
/// current identity of a present file.
fn reopened(
    finalized: &MatchResult,
    transactions: &[StatementTransaction],
    cache: &[ReceiptMeta],
    present: &HashSet<String>,
    identity: &dyn Fn(&str) -> Option<FileIdentity>,
    rules: &[Rule],
) -> Reopened {
    let cache = rebuilt_cache(finalized, cache, present, identity);
    let receipts: Vec<ReceiptMeta> = readable(cache.clone())
        .into_iter()
        .filter(|r| present.contains(&r.file))
        .collect();
    let fresh = match_transactions(transactions, &receipts, rules);
    let draft = decisions(finalized, &fresh);
    let result = match_with_draft(Some(&fresh), &draft, transactions, &receipts, rules);
    Reopened {
        cache,
        result,
        draft,
    }
}

/// The reopened files written next to their targets, waiting to replace them.
struct Staged {
    cache: PathBuf,
    result: PathBuf,
    /// None when the draft is empty, so the saved draft is deleted instead.
    draft: Option<PathBuf>,
}

impl Staged {
    fn write(paths: &PeriodPaths, reopened: &Reopened) -> Result<Staged, PipelineError> {
        let staged = Staged {
            cache: tmp(&paths.receipts_cache()),
            result: tmp(&paths.match_result()),
            draft: (!reopened.draft.is_empty()).then(|| tmp(&paths.draft())),
        };
        let written = write_json(&staged.cache, &reopened.cache)
            .and_then(|_| write_json(&staged.result, &reopened.result))
            .and_then(|_| match &staged.draft {
                Some(draft) => write_json(draft, &reopened.draft),
                None => Ok(()),
            });
        if let Err(error) = written {
            staged.discard();
            return Err(error.into());
        }
        Ok(staged)
    }

    fn discard(&self) {
        for path in [Some(&self.cache), Some(&self.result), self.draft.as_ref()]
            .into_iter()
            .flatten()
        {
            let _ = remove_if_exists(path);
        }
    }

    /// Puts the staged files in place and removes the finalized marker. When a step fails, the
    /// earlier files are restored and the staged ones removed.
    fn publish(&self, paths: &PeriodPaths) -> Result<(), PipelineError> {
        let (cache, result, draft, marker) = (
            paths.receipts_cache(),
            paths.match_result(),
            paths.draft(),
            paths.applied_marker(),
        );
        let backups = [
            Backup::take(&cache)?,
            Backup::take(&result)?,
            Backup::take(&draft)?,
            Backup::take(&marker)?,
        ];
        let outcome = std::fs::rename(&self.cache, &cache)
            .map_err(|e| io(&cache, e))
            .and_then(|_| std::fs::rename(&self.result, &result).map_err(|e| io(&result, e)))
            .and_then(|_| match &self.draft {
                Some(staged) => std::fs::rename(staged, &draft).map_err(|e| io(&draft, e)),
                None => remove_if_exists(&draft).map_err(|e| io(&draft, e)),
            })
            .and_then(|_| remove_if_exists(&marker).map_err(|e| io(&marker, e)));
        if outcome.is_err() {
            for backup in &backups {
                backup.restore();
            }
            self.discard();
        }
        outcome
    }
}

/// `<path>.tmp`.
fn tmp(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

/// `result` with every receipt path that moved replaced by where it went.
fn relocated(result: &MatchResult, moved: &HashMap<String, String>) -> MatchResult {
    let path = |file: &String| moved.get(file).cloned().unwrap_or_else(|| file.clone());
    let meta = |list: &[ReceiptMeta]| -> Vec<ReceiptMeta> {
        list.iter()
            .map(|m| finalize::clean(m, &path(&m.file)))
            .collect()
    };
    let paths = |list: &[String]| -> Vec<String> { list.iter().map(path).collect() };
    MatchResult {
        transactions: result
            .transactions
            .iter()
            .map(|tx| Transaction {
                receipt_meta: meta(&tx.receipt_meta),
                receipt_files: paths(&tx.receipt_files),
                ..tx.clone()
            })
            .collect(),
        receipts_by_status: ReceiptsByStatus {
            matched: paths(&result.receipts_by_status.matched),
            review: paths(&result.receipts_by_status.review),
            unmatched: paths(&result.receipts_by_status.unmatched),
        },
        unmatched_receipts: meta(&result.unmatched_receipts),
    }
}

/// The extraction cache for the files now in `receipts/`: the finalized result's metadata for
/// the receipts it holds, then the earlier cache entries of the other files. An entry counts
/// only when its identity is the current identity of the file, so a new file with an old name
/// is read again.
fn rebuilt_cache(
    finalized: &MatchResult,
    cache: &[ReceiptMeta],
    present: &HashSet<String>,
    identity: &dyn Fn(&str) -> Option<FileIdentity>,
) -> Vec<ReceiptMeta> {
    let mut entries: Vec<ReceiptMeta> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let held = finalized
        .transactions
        .iter()
        .flat_map(|tx| &tx.receipt_meta)
        .chain(&finalized.unmatched_receipts);
    for meta in held.chain(cache) {
        if !present.contains(&meta.file) || seen.contains(&meta.file) {
            continue;
        }
        let current = identity(&meta.file);
        if meta.identity.is_some() && meta.identity == current {
            seen.insert(meta.file.clone());
            entries.push(meta.clone());
        }
    }
    entries
}

/// The files of a transaction's receipts, in a fixed order.
fn file_set(tx: &Transaction) -> Vec<&str> {
    let mut files: Vec<&str> = tx.receipt_files.iter().map(String::as_str).collect();
    files.sort_unstable();
    files
}

/// Draft decisions for the finalized transactions that `fresh` matches differently. The order
/// of a transaction's receipts does not count as a difference.
fn decisions(finalized: &MatchResult, fresh: &MatchResult) -> Draft {
    let fresh_by_id: HashMap<&str, &Transaction> = fresh
        .transactions
        .iter()
        .map(|tx| (tx.id.as_str(), tx))
        .collect();
    let mut draft = Draft::new();
    for tx in &finalized.transactions {
        let same = fresh_by_id.get(tx.id.as_str()).is_some_and(|other| {
            other.status == tx.status && other.notes == tx.notes && file_set(other) == file_set(tx)
        });
        if same {
            continue;
        }
        let mut decision = Map::new();
        decision.insert(
            "status".into(),
            serde_json::to_value(tx.status).unwrap_or(Value::Null),
        );
        decision.insert(
            "receipt_meta".into(),
            serde_json::to_value(&tx.receipt_meta).unwrap_or(Value::Array(Vec::new())),
        );
        decision.insert(
            "receipt_files".into(),
            serde_json::to_value(&tx.receipt_files).unwrap_or(Value::Array(Vec::new())),
        );
        decision.insert("notes".into(), Value::String(tx.notes.clone()));
        draft.insert(tx.id.clone(), Value::Object(decision));
    }
    draft
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Status;
    use serde_json::json;

    fn tx(id: &str, status: Status, files: &[&str], notes: &str) -> Transaction {
        serde_json::from_value(json!({
            "id": id, "date": "2030-03-01", "description": "ACME", "amount_cents": -1000,
            "abs_cents": 1000, "status": status, "notes": notes,
            "receipt_files": files,
            "receipt_meta": files.iter().map(|f| json!({ "file": f, "amount_cents": 1000 })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    fn result(transactions: Vec<Transaction>) -> MatchResult {
        MatchResult {
            transactions,
            ..Default::default()
        }
    }

    #[test]
    fn keeps_only_the_decisions_the_matcher_does_not_repeat() {
        let finalized = result(vec![
            tx("t1", Status::Matched, &["/r/a.pdf"], "amount_match"),
            tx(
                "t2",
                Status::Matched,
                &["/r/b.pdf", "/r/c.pdf"],
                "manual_match",
            ),
            tx("t3", Status::Matched, &[], "transfer"),
        ]);
        let fresh = result(vec![
            tx("t1", Status::Matched, &["/r/a.pdf"], "amount_match"),
            tx("t2", Status::Matched, &["/r/b.pdf"], "amount_match"),
            tx("t3", Status::Unmatched, &[], ""),
        ]);
        let draft = decisions(&finalized, &fresh);
        assert_eq!(draft.keys().collect::<Vec<_>>(), ["t2", "t3"]);
        assert_eq!(
            draft["t2"]["receipt_files"],
            json!(["/r/b.pdf", "/r/c.pdf"])
        );
        assert_eq!(draft["t2"]["status"], "MATCHED");
        assert_eq!(draft["t3"]["notes"], "transfer");
    }

    #[test]
    fn ignores_the_order_of_a_transactions_receipts() {
        let finalized = result(vec![tx(
            "t1",
            Status::Review,
            &["/r/b.pdf", "/r/a.pdf"],
            "2 receipts match amount",
        )]);
        let fresh = result(vec![tx(
            "t1",
            Status::Review,
            &["/r/a.pdf", "/r/b.pdf"],
            "2 receipts match amount",
        )]);
        assert!(decisions(&finalized, &fresh).is_empty());
    }

    #[test]
    fn relocates_moved_receipts_everywhere() {
        let mut finalized = result(vec![tx("t1", Status::Matched, &["/r/_matched/a.pdf"], "x")]);
        finalized.unmatched_receipts = vec![ReceiptMeta {
            file: "/r/_unmatched/b.pdf".into(),
            ..Default::default()
        }];
        finalized.receipts_by_status.matched = vec!["/r/_matched/a.pdf".into()];
        let moved = HashMap::from([
            ("/r/_matched/a.pdf".to_string(), "/r/a.pdf".to_string()),
            (
                "/r/_unmatched/b.pdf".to_string(),
                "/r/b-restored.pdf".to_string(),
            ),
        ]);
        let back = relocated(&finalized, &moved);
        assert_eq!(back.transactions[0].receipt_files, ["/r/a.pdf"]);
        assert_eq!(back.transactions[0].receipt_meta[0].file, "/r/a.pdf");
        assert_eq!(back.unmatched_receipts[0].file, "/r/b-restored.pdf");
        assert_eq!(back.receipts_by_status.matched, ["/r/a.pdf"]);
    }

    const SAME: Option<FileIdentity> = Some(FileIdentity {
        size: 10,
        modified_secs: 1_900_000_000,
        modified_nanos: 5,
    });

    fn same(_: &str) -> Option<FileIdentity> {
        SAME
    }

    #[test]
    fn rebuilds_the_cache_for_present_files_preferring_the_finalized_metadata() {
        let mut finalized = result(vec![tx("t1", Status::Matched, &["/r/a.pdf"], "x")]);
        finalized.transactions[0].receipt_meta[0].identity = SAME;
        let cache = vec![
            ReceiptMeta {
                file: "/r/a.pdf".into(),
                amount_cents: Some(5),
                identity: SAME,
                ..Default::default()
            },
            ReceiptMeta {
                file: "/r/new.pdf".into(),
                identity: SAME,
                ..Default::default()
            },
            ReceiptMeta {
                file: "/r/gone.pdf".into(),
                identity: SAME,
                ..Default::default()
            },
        ];
        let present = HashSet::from(["/r/a.pdf".to_string(), "/r/new.pdf".to_string()]);
        let rebuilt = rebuilt_cache(&finalized, &cache, &present, &same);
        let files: Vec<&str> = rebuilt.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, ["/r/a.pdf", "/r/new.pdf"]);
        assert_eq!(rebuilt[0].amount_cents, Some(1000));
    }

    #[test]
    fn leaves_out_entries_whose_file_changed_or_has_no_identity() {
        let finalized = result(vec![tx("t1", Status::Matched, &["/r/a.pdf"], "x")]);
        let changed = Some(FileIdentity {
            size: 99,
            ..SAME.unwrap()
        });
        let cache = vec![
            ReceiptMeta {
                file: "/r/a.pdf".into(),
                amount_cents: Some(5),
                identity: SAME,
                ..Default::default()
            },
            ReceiptMeta {
                file: "/r/b.pdf".into(),
                identity: changed,
                ..Default::default()
            },
        ];
        let present = HashSet::from(["/r/a.pdf".to_string(), "/r/b.pdf".to_string()]);
        let rebuilt = rebuilt_cache(&finalized, &cache, &present, &same);
        let files: Vec<&str> = rebuilt.iter().map(|m| m.file.as_str()).collect();
        assert_eq!(files, ["/r/a.pdf"]);
        assert_eq!(rebuilt[0].amount_cents, Some(5));
    }
}
