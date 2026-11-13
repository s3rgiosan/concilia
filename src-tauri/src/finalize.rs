//! Planning and applying Finalize: every receipt moves into `receipts/_matched`, `_review` or
//! `_unmatched`, and the stored paths follow the files.
//!
//! Each source file gets exactly one destination, chosen by the strongest status that
//! references it (MATCHED, then REVIEW, then UNMATCHED), and every reference is rewritten to
//! it. Name clashes get a numeric suffix; existing files are never overwritten.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::fsutil::rename_no_replace;
use crate::model::{basename, ReceiptMeta, ReceiptsByStatus, Status, Transaction};

/// Fields added for display that never belong in stored metadata.
pub const TRANSIENT_FIELDS: &[&str] = &["receiptUrl", "rel_path"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// The file moves and the rewritten records of one Finalize.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalizePlan {
    pub moves: Vec<Move>,
    pub transactions: Vec<Transaction>,
    pub unmatched_receipts: Vec<ReceiptMeta>,
    pub receipts_by_status: ReceiptsByStatus,
    /// The original path of each moved receipt, keyed by its new path, both relative to the
    /// receipts folder.
    pub original_paths: BTreeMap<String, String>,
}

fn folder(status: Status) -> &'static str {
    match status {
        Status::Matched => "_matched",
        Status::Review => "_review",
        Status::Unmatched => "_unmatched",
    }
}

fn rank(status: Status) -> u8 {
    match status {
        Status::Matched => 0,
        Status::Review => 1,
        Status::Unmatched => 2,
    }
}

/// `name` with `-n` before its extension.
fn suffixed(name: &str, n: usize) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}-{n}.{ext}"),
        _ => format!("{name}-{n}"),
    }
}

/// `path` in lowercase. Reserved targets are compared in this form, because a
/// case-insensitive volume treats names that differ only in case as one file.
pub(crate) fn folded(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// `path` relative to `base`, with `/` between the parts, or none when `path` is not inside
/// `base`.
pub(crate) fn relative_text(path: &Path, base: &Path) -> Option<String> {
    let rest = path.strip_prefix(base).ok()?;
    let parts: Vec<String> = rest
        .iter()
        .map(|part| part.to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// `meta` stored at `file`, without the fields added for display.
pub(crate) fn clean(meta: &ReceiptMeta, file: &str) -> ReceiptMeta {
    let mut meta = meta.clone();
    meta.file = file.to_string();
    for field in TRANSIENT_FIELDS {
        meta.extra.remove(*field);
    }
    meta
}

fn unique_in_order(files: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    files
        .into_iter()
        .filter(|f| seen.insert(f.clone()))
        .collect()
}

/// Plans Finalize for the reviewed `transactions` and the receipts left `unmatched`.
///
/// Receipts for which `is_known` is false are dropped from the records. Receipts missing on
/// disk keep their path and are not moved.
pub fn plan(
    transactions: &[Transaction],
    unmatched: &[ReceiptMeta],
    receipts_dir: &Path,
    is_known: impl Fn(&str) -> bool,
    exists: impl Fn(&Path) -> bool,
) -> FinalizePlan {
    // Strongest status per file, in first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut best: HashMap<String, Status> = HashMap::new();
    let references = transactions
        .iter()
        .flat_map(|tx| {
            tx.receipt_meta
                .iter()
                .map(move |m| (m.file.as_str(), tx.status))
        })
        .chain(
            unmatched
                .iter()
                .map(|m| (m.file.as_str(), Status::Unmatched)),
        );
    for (file, status) in references {
        if !is_known(file) {
            log::warn!("finalize: dropping unknown receipt {file}");
            continue;
        }
        match best.get_mut(file) {
            Some(current) if rank(status) < rank(*current) => *current = status,
            Some(_) => {}
            None => {
                order.push(file.to_string());
                best.insert(file.to_string(), status);
            }
        }
    }

    let mut moves = Vec::new();
    let mut original_paths = BTreeMap::new();
    let mut destinations: HashMap<String, String> = HashMap::new();
    let mut reserved: HashSet<String> = HashSet::new();
    for file in &order {
        let source = PathBuf::from(file);
        if !exists(&source) {
            destinations.insert(file.clone(), file.clone());
            continue;
        }
        let dir = receipts_dir.join(folder(best[file]));
        let name = basename(file);
        let mut target = dir.join(name);
        let mut n = 0;
        while target != source && (reserved.contains(&folded(&target)) || exists(&target)) {
            n += 1;
            target = dir.join(suffixed(name, n));
        }
        reserved.insert(folded(&target));
        if target != source {
            let relative = (
                relative_text(&target, receipts_dir),
                relative_text(&source, receipts_dir),
            );
            if let (Some(to), Some(from)) = relative {
                original_paths.insert(to, from);
            }
            moves.push(Move {
                from: source,
                to: target.clone(),
            });
        }
        destinations.insert(file.clone(), target.to_string_lossy().into_owned());
    }

    let rewritten = |meta: &[ReceiptMeta]| -> Vec<ReceiptMeta> {
        meta.iter()
            .filter_map(|m| destinations.get(&m.file).map(|to| clean(m, to)))
            .collect()
    };
    let transactions: Vec<Transaction> = transactions
        .iter()
        .map(|tx| {
            let receipt_meta = rewritten(&tx.receipt_meta);
            Transaction {
                receipt_files: receipt_meta.iter().map(|m| m.file.clone()).collect(),
                receipt_meta,
                ..tx.clone()
            }
        })
        .collect();
    let unmatched_receipts = rewritten(unmatched);

    let files_with = |status: Status| {
        transactions
            .iter()
            .filter(move |tx| tx.status == status)
            .flat_map(|tx| tx.receipt_files.iter().cloned())
    };
    let receipts_by_status = ReceiptsByStatus {
        matched: unique_in_order(files_with(Status::Matched)),
        review: unique_in_order(files_with(Status::Review)),
        unmatched: unique_in_order(
            files_with(Status::Unmatched).chain(unmatched_receipts.iter().map(|m| m.file.clone())),
        ),
    };

    FinalizePlan {
        moves,
        transactions,
        unmatched_receipts,
        receipts_by_status,
        original_paths,
    }
}

/// A move that failed, with the files that could not move back after it.
#[derive(Debug)]
pub struct MoveFailure {
    pub error: std::io::Error,
    /// Each file left at its target, with the reason.
    pub stuck: Vec<String>,
}

impl std::fmt::Display for MoveFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.error)?;
        if !self.stuck.is_empty() {
            write!(f, "; could not move back: {}", self.stuck.join("; "))?;
        }
        Ok(())
    }
}

/// Performs the moves in order. A move never replaces an existing file. On failure, moves
/// already made are undone and the error returned with any file that could not move back.
pub fn execute(moves: &[Move]) -> Result<(), MoveFailure> {
    for (done, step) in moves.iter().enumerate() {
        if let Err(error) = rename_no_replace(&step.from, &step.to) {
            let stuck = undo(&moves[..done]);
            return Err(MoveFailure { error, stuck });
        }
    }
    Ok(())
}

/// Moves every file of `moves` back to where it came from, last move first. A file whose
/// origin is taken again stays at its target. Returns each file that could not move back,
/// with the reason.
pub fn undo(moves: &[Move]) -> Vec<String> {
    let mut stuck = Vec::new();
    for step in moves.iter().rev() {
        if let Err(error) = rename_no_replace(&step.to, &step.from) {
            log::error!(
                "finalize rollback failed for {}: {error}",
                step.to.display()
            );
            stuck.push(format!("{}: {error}", step.to.display()));
        }
    }
    stuck
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn receipt(file: &str) -> ReceiptMeta {
        ReceiptMeta {
            file: file.into(),
            amount_cents: Some(1000),
            ..Default::default()
        }
    }

    fn tx(id: &str, status: Status, files: &[&str]) -> Transaction {
        let receipt_meta: Vec<ReceiptMeta> = files.iter().map(|f| receipt(f)).collect();
        Transaction {
            id: id.into(),
            date: "2030-03-01".into(),
            description: "ACME".into(),
            amount_cents: -1000,
            abs_cents: 1000,
            status,
            receipt_files: files.iter().map(|f| f.to_string()).collect(),
            receipt_meta,
            notes: String::new(),
            extra: Default::default(),
        }
    }

    const DIR: &str = "/p/receipts";

    fn plan_with(txs: &[Transaction], unmatched: &[ReceiptMeta], on_disk: &[&str]) -> FinalizePlan {
        let on_disk: HashSet<PathBuf> = on_disk.iter().map(PathBuf::from).collect();
        plan(
            txs,
            unmatched,
            Path::new(DIR),
            |_| true,
            |p| on_disk.contains(p),
        )
    }

    #[test]
    fn moves_each_file_to_its_status_folder() {
        let txs = [
            tx("t1", Status::Matched, &["/p/receipts/a.pdf"]),
            tx("t2", Status::Review, &["/p/receipts/b.pdf"]),
        ];
        let p = plan_with(
            &txs,
            &[receipt("/p/receipts/c.pdf")],
            &[
                "/p/receipts/a.pdf",
                "/p/receipts/b.pdf",
                "/p/receipts/c.pdf",
            ],
        );
        assert_eq!(
            p.moves,
            vec![
                Move {
                    from: "/p/receipts/a.pdf".into(),
                    to: "/p/receipts/_matched/a.pdf".into()
                },
                Move {
                    from: "/p/receipts/b.pdf".into(),
                    to: "/p/receipts/_review/b.pdf".into()
                },
                Move {
                    from: "/p/receipts/c.pdf".into(),
                    to: "/p/receipts/_unmatched/c.pdf".into()
                },
            ]
        );
        assert_eq!(
            p.transactions[0].receipt_files,
            ["/p/receipts/_matched/a.pdf"]
        );
        assert_eq!(
            p.transactions[0].receipt_meta[0].file,
            "/p/receipts/_matched/a.pdf"
        );
        assert_eq!(p.unmatched_receipts[0].file, "/p/receipts/_unmatched/c.pdf");
        assert_eq!(p.receipts_by_status.matched, ["/p/receipts/_matched/a.pdf"]);
        assert_eq!(p.receipts_by_status.review, ["/p/receipts/_review/b.pdf"]);
        assert_eq!(
            p.receipts_by_status.unmatched,
            ["/p/receipts/_unmatched/c.pdf"]
        );
    }

    #[test]
    fn records_where_each_moved_receipt_came_from() {
        let txs = [tx(
            "t1",
            Status::Matched,
            &["/p/receipts/x/a.pdf", "/p/receipts/y/a.pdf"],
        )];
        let p = plan_with(&txs, &[], &["/p/receipts/x/a.pdf", "/p/receipts/y/a.pdf"]);
        assert_eq!(
            p.original_paths,
            BTreeMap::from([
                ("_matched/a.pdf".to_string(), "x/a.pdf".to_string()),
                ("_matched/a-1.pdf".to_string(), "y/a.pdf".to_string()),
            ])
        );
    }

    #[test]
    fn a_file_referenced_twice_gets_one_destination() {
        let txs = [
            tx("t1", Status::Review, &["/p/receipts/a.pdf"]),
            tx("t2", Status::Matched, &["/p/receipts/a.pdf"]),
        ];
        let p = plan_with(
            &txs,
            &[receipt("/p/receipts/a.pdf")],
            &["/p/receipts/a.pdf"],
        );
        assert_eq!(p.moves.len(), 1);
        assert_eq!(p.moves[0].to, PathBuf::from("/p/receipts/_matched/a.pdf"));
        for files in [
            &p.transactions[0].receipt_files,
            &p.transactions[1].receipt_files,
        ] {
            assert_eq!(files, &["/p/receipts/_matched/a.pdf"]);
        }
        assert_eq!(p.unmatched_receipts[0].file, "/p/receipts/_matched/a.pdf");
    }

    #[test]
    fn clashing_names_get_a_suffix() {
        let txs = [tx(
            "t1",
            Status::Matched,
            &["/p/receipts/x/a.pdf", "/p/receipts/y/a.pdf"],
        )];
        let p = plan_with(
            &txs,
            &[],
            &[
                "/p/receipts/x/a.pdf",
                "/p/receipts/y/a.pdf",
                "/p/receipts/_matched/a-1.pdf",
            ],
        );
        let targets: Vec<_> = p.moves.iter().map(|m| m.to.clone()).collect();
        assert_eq!(
            targets,
            [
                PathBuf::from("/p/receipts/_matched/a.pdf"),
                PathBuf::from("/p/receipts/_matched/a-2.pdf")
            ]
        );
    }

    #[test]
    fn names_that_differ_only_in_case_get_distinct_targets() {
        let txs = [tx(
            "t1",
            Status::Matched,
            &["/p/receipts/a/Invoice.pdf", "/p/receipts/b/invoice.pdf"],
        )];
        let p = plan_with(
            &txs,
            &[],
            &["/p/receipts/a/Invoice.pdf", "/p/receipts/b/invoice.pdf"],
        );
        let targets: Vec<_> = p.moves.iter().map(|m| m.to.clone()).collect();
        assert_eq!(
            targets,
            [
                PathBuf::from("/p/receipts/_matched/Invoice.pdf"),
                PathBuf::from("/p/receipts/_matched/invoice-1.pdf")
            ]
        );
    }

    #[test]
    fn a_move_never_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fs::create_dir(d.join("_matched")).unwrap();
        fs::write(d.join("a.pdf"), b"a").unwrap();
        fs::write(d.join("b.pdf"), b"b").unwrap();
        fs::write(d.join("_matched/b.pdf"), b"earlier").unwrap();
        let moves = vec![
            Move {
                from: d.join("a.pdf"),
                to: d.join("_matched/a.pdf"),
            },
            Move {
                from: d.join("b.pdf"),
                to: d.join("_matched/b.pdf"),
            },
        ];
        let error = execute(&moves).unwrap_err();
        assert_eq!(error.error.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(error.stuck.is_empty());
        assert_eq!(fs::read(d.join("a.pdf")).unwrap(), b"a");
        assert_eq!(fs::read(d.join("b.pdf")).unwrap(), b"b");
        assert_eq!(fs::read(d.join("_matched/b.pdf")).unwrap(), b"earlier");
        assert!(!d.join("_matched/a.pdf").exists());
    }

    #[test]
    fn files_already_in_place_stay() {
        let txs = [tx("t1", Status::Matched, &["/p/receipts/_matched/a.pdf"])];
        let p = plan_with(&txs, &[], &["/p/receipts/_matched/a.pdf"]);
        assert!(p.moves.is_empty());
        assert_eq!(
            p.transactions[0].receipt_files,
            ["/p/receipts/_matched/a.pdf"]
        );
    }

    #[test]
    fn missing_files_keep_their_path() {
        let txs = [tx("t1", Status::Matched, &["/p/receipts/gone.pdf"])];
        let p = plan_with(&txs, &[], &[]);
        assert!(p.moves.is_empty());
        assert_eq!(p.transactions[0].receipt_files, ["/p/receipts/gone.pdf"]);
    }

    #[test]
    fn unknown_receipts_are_dropped() {
        let txs = [tx(
            "t1",
            Status::Matched,
            &["/p/receipts/a.pdf", "/etc/secret.pdf"],
        )];
        let p = plan(
            &txs,
            &[],
            Path::new(DIR),
            |f| f != "/etc/secret.pdf",
            |p| p == Path::new("/p/receipts/a.pdf"),
        );
        assert_eq!(
            p.transactions[0].receipt_files,
            ["/p/receipts/_matched/a.pdf"]
        );
        assert_eq!(p.moves.len(), 1);
    }

    #[test]
    fn strips_display_fields() {
        let mut meta = receipt("/p/receipts/a.pdf");
        meta.extra
            .insert("receiptUrl".into(), "/api/receipt/x".into());
        meta.extra
            .insert("rel_path".into(), "2030/03/receipts/a.pdf".into());
        meta.extra.insert("kept".into(), true.into());
        let mut t = tx("t1", Status::Matched, &[]);
        t.receipt_meta = vec![meta];
        let p = plan_with(&[t], &[], &[]);
        let extra = &p.transactions[0].receipt_meta[0].extra;
        assert_eq!(extra.keys().collect::<Vec<_>>(), ["kept"]);
    }

    #[test]
    fn undo_returns_the_files_that_could_not_move_back() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fs::write(d.join("a.pdf"), b"new").unwrap();
        fs::create_dir(d.join("_matched")).unwrap();
        fs::write(d.join("_matched/a.pdf"), b"a").unwrap();
        let moves = [Move {
            from: d.join("a.pdf"),
            to: d.join("_matched/a.pdf"),
        }];
        let stuck = undo(&moves);
        assert_eq!(stuck.len(), 1);
        assert!(stuck[0].contains("_matched"), "{stuck:?}");
        let failure = MoveFailure {
            error: std::io::Error::other("disk full"),
            stuck,
        };
        assert!(failure.to_string().contains("could not move back"));
    }

    #[test]
    fn suffixes_names_before_the_extension() {
        assert_eq!(suffixed("a.pdf", 1), "a-1.pdf");
        assert_eq!(suffixed("a.b.png", 2), "a.b-2.png");
        assert_eq!(suffixed("noext", 3), "noext-3");
        assert_eq!(suffixed(".hidden", 1), ".hidden-1");
    }

    #[test]
    fn executes_moves_and_rolls_back_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        fs::create_dir(d.join("_matched")).unwrap();
        fs::write(d.join("a.pdf"), b"a").unwrap();
        fs::write(d.join("b.pdf"), b"b").unwrap();
        let moves = vec![
            Move {
                from: d.join("a.pdf"),
                to: d.join("_matched/a.pdf"),
            },
            Move {
                from: d.join("b.pdf"),
                to: d.join("missing-dir/b.pdf"),
            },
        ];
        assert!(execute(&moves).is_err());
        assert!(d.join("a.pdf").exists());
        assert!(!d.join("_matched/a.pdf").exists());

        assert!(execute(&moves[..1]).is_ok());
        assert!(d.join("_matched/a.pdf").exists());
    }
}
