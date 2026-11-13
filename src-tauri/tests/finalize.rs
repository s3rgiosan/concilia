//! Finalize on a period folder: receipts move into their status folders, the stored paths
//! follow them, and a failure leaves the period as it was.

mod common;

use std::path::{Path, PathBuf};

use common::{read_stored_file, receipt_meta, report_sheet_names, write_file, write_json_file};
use concilia_lib::model::{
    default_reasons, Language, MatchResult, ReceiptMeta, ReceiptsByStatus, Status, Transaction,
};
use concilia_lib::period::{Period, PeriodPaths};
use concilia_lib::pipeline::{self, PipelineError};
use serde_json::{json, Value};
use tempfile::TempDir;

const ACME_ID: &str = "tx-001-2030-03-01--1000";
const GLOBEX_ID: &str = "tx-002-2030-03-02--2000";
const INITECH_ID: &str = "tx-003-2030-03-03--3000";

/// A period folder with receipt files and a match result written by hand.
struct Fixture {
    dir: TempDir,
    paths: PeriodPaths,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let paths = Period::parse("2030", "03").unwrap().paths(dir.path());
        std::fs::create_dir_all(&paths.receipts).unwrap();
        std::fs::create_dir_all(&paths.docs).unwrap();
        Fixture { dir, paths }
    }

    /// Writes a receipt under `receipts/` holding its own relative path, and returns its path.
    fn receipt(&self, relative: &str) -> String {
        let path = self.paths.receipts.join(relative);
        write_file(&path, relative.as_bytes());
        path.to_string_lossy().into_owned()
    }

    /// The path a receipt would have under `receipts/`, without creating it.
    fn receipt_path(&self, relative: &str) -> String {
        self.paths
            .receipts
            .join(relative)
            .to_string_lossy()
            .into_owned()
    }

    fn write_result(&self, transactions: Vec<Transaction>, unmatched: Vec<ReceiptMeta>) {
        let files_with = |status: Status| -> Vec<String> {
            transactions
                .iter()
                .filter(|t| t.status == status)
                .flat_map(|t| t.receipt_files.clone())
                .collect()
        };
        let result = MatchResult {
            receipts_by_status: ReceiptsByStatus {
                matched: files_with(Status::Matched),
                review: files_with(Status::Review),
                unmatched: unmatched.iter().map(|m| m.file.clone()).collect(),
            },
            transactions,
            unmatched_receipts: unmatched,
            ..Default::default()
        };
        write_json_file(&self.paths.match_result(), &result);
    }

    fn write_draft(&self, draft: Value) {
        write_json_file(&self.paths.draft(), &draft);
    }

    fn result(&self) -> MatchResult {
        read_stored_file(&self.paths.dir, &self.paths.match_result())
    }

    fn finalize(&self) -> Result<(), PipelineError> {
        pipeline::finalize(&self.paths, Language::En, &default_reasons())
    }

    /// Contents of a file under `receipts/`.
    fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.paths.receipts.join(relative))
            .unwrap_or_else(|e| panic!("{relative}: {e}"))
    }

    fn exists(&self, relative: &str) -> bool {
        self.paths.receipts.join(relative).exists()
    }

    /// Names of the files directly inside a folder under `receipts/`, sorted.
    fn listing(&self, folder: &str) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.paths.receipts.join(folder)) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn temporary_files_in_docs(&self) -> Vec<PathBuf> {
        std::fs::read_dir(&self.paths.docs)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "tmp"))
            .collect()
    }
}

fn tx(
    id: &str,
    description: &str,
    status: Status,
    receipts: &[ReceiptMeta],
    notes: &str,
) -> Transaction {
    let cents: i64 = id.rsplit("--").next().unwrap().parse().unwrap();
    Transaction {
        id: id.into(),
        date: id[7..17].into(),
        description: description.into(),
        amount_cents: -cents,
        abs_cents: cents,
        status,
        receipt_files: receipts.iter().map(|r| r.file.clone()).collect(),
        receipt_meta: receipts.to_vec(),
        notes: notes.into(),
        extra: Default::default(),
    }
}

/// Every receipt path a match result stores.
fn stored_paths(result: &MatchResult) -> Vec<String> {
    let by_status = &result.receipts_by_status;
    result
        .transactions
        .iter()
        .flat_map(|t| {
            t.receipt_files
                .iter()
                .cloned()
                .chain(t.receipt_meta.iter().map(|m| m.file.clone()))
        })
        .chain(result.unmatched_receipts.iter().map(|m| m.file.clone()))
        .chain(by_status.matched.iter().cloned())
        .chain(by_status.review.iter().cloned())
        .chain(by_status.unmatched.iter().cloned())
        .collect()
}

fn assert_stored_paths_exist(result: &MatchResult) {
    for file in stored_paths(result) {
        assert!(Path::new(&file).is_file(), "{file} is on disk");
    }
}

fn is_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 20
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            19 => *b == b'Z',
            _ => b.is_ascii_digit(),
        })
}

#[test]
fn moves_receipts_into_their_status_folders() {
    let f = Fixture::new();
    let acme = receipt_meta(&f.receipt("acme.pdf"), 1000, "ACME");
    let globex = receipt_meta(&f.receipt("globex.jpg"), 2000, "GLOBEX");
    let hooli = receipt_meta(&f.receipt("hooli.png"), 4000, "HOOLI");
    f.write_result(
        vec![
            tx(
                ACME_ID,
                "ACME CORP",
                Status::Matched,
                &[acme],
                "amount_match",
            ),
            tx(
                GLOBEX_ID,
                "GLOBEX",
                Status::Review,
                &[globex],
                "filename_match (globex.jpg)",
            ),
            tx(INITECH_ID, "INITECH", Status::Unmatched, &[], ""),
        ],
        vec![hooli],
    );
    f.write_draft(json!({}));
    let taxi = f.paths.reimbursements.join("taxi.jpg");
    write_json_file(
        &f.paths.reimbursements_cache(),
        &[receipt_meta(&taxi.to_string_lossy(), 1500, "TAXI CO")],
    );

    f.finalize().unwrap();

    assert_eq!(f.listing(""), ["_matched", "_review", "_unmatched"]);
    assert_eq!(f.read("_matched/acme.pdf"), "acme.pdf");
    assert_eq!(f.read("_review/globex.jpg"), "globex.jpg");
    assert_eq!(f.read("_unmatched/hooli.png"), "hooli.png");

    let result = f.result();
    let (acme_to, globex_to, hooli_to) = (
        f.receipt_path("_matched/acme.pdf"),
        f.receipt_path("_review/globex.jpg"),
        f.receipt_path("_unmatched/hooli.png"),
    );
    assert_eq!(
        result.transactions[0].receipt_files,
        std::slice::from_ref(&acme_to)
    );
    assert_eq!(
        result.transactions[0].receipt_meta,
        [receipt_meta(&acme_to, 1000, "ACME")]
    );
    assert_eq!(
        result.transactions[1].receipt_files,
        std::slice::from_ref(&globex_to)
    );
    assert_eq!(result.transactions[1].status, Status::Review);
    assert!(result.transactions[2].receipt_files.is_empty());
    assert_eq!(
        result.unmatched_receipts,
        [receipt_meta(&hooli_to, 4000, "HOOLI")]
    );
    assert_eq!(
        result.receipts_by_status,
        ReceiptsByStatus {
            matched: vec![acme_to],
            review: vec![globex_to],
            unmatched: vec![hooli_to],
        }
    );
    assert_stored_paths_exist(&result);

    assert!(f.paths.report().is_file());
    assert!(report_sheet_names(&f.paths.report()).contains(&"Reimbursements".to_string()));
    let applied = std::fs::read_to_string(f.paths.applied_marker()).unwrap();
    assert!(is_iso_timestamp(&applied), "{applied}");
    assert!(!f.paths.draft().exists());
    assert!(f.temporary_files_in_docs().is_empty());
    assert!(pipeline::period_status(&f.paths).applied);
}

#[test]
fn applies_the_review_decisions() {
    let f = Fixture::new();
    let acme_a = receipt_meta(&f.receipt("acme-a.pdf"), 1000, "ACME");
    let acme_b = receipt_meta(&f.receipt("acme-b.pdf"), 1000, "ACME");
    let globex = receipt_meta(&f.receipt("globex.jpg"), 2000, "GLOBEX");
    f.write_result(
        vec![
            tx(
                ACME_ID,
                "ACME CORP",
                Status::Review,
                &[acme_a.clone(), acme_b],
                "2 receipts match amount",
            ),
            tx(
                GLOBEX_ID,
                "GLOBEX",
                Status::Matched,
                &[globex],
                "amount_match",
            ),
            tx(INITECH_ID, "INITECH", Status::Unmatched, &[], ""),
        ],
        Vec::new(),
    );
    f.write_draft(json!({
        ACME_ID: {
            "status": "MATCHED",
            "receipt_files": [acme_a.file],
            "receipt_meta": [acme_a],
            "notes": "manual_match"
        },
        GLOBEX_ID: { "status": "UNMATCHED", "receipt_files": [], "receipt_meta": [], "notes": "" },
        INITECH_ID: { "status": "MATCHED", "receipt_files": [], "receipt_meta": [], "notes": "transfer" }
    }));

    f.finalize().unwrap();

    assert_eq!(f.listing("_matched"), ["acme-a.pdf"]);
    assert_eq!(f.listing("_unmatched"), ["acme-b.pdf", "globex.jpg"]);
    let result = f.result();
    let outcome: Vec<(Status, &str, Vec<String>)> = result
        .transactions
        .iter()
        .map(|t| (t.status, t.notes.as_str(), t.receipt_files.clone()))
        .collect();
    assert_eq!(
        outcome,
        [
            (
                Status::Matched,
                "manual_match",
                vec![f.receipt_path("_matched/acme-a.pdf")]
            ),
            (Status::Unmatched, "", vec![]),
            (Status::Matched, "transfer", vec![]),
        ]
    );
    assert_eq!(
        result.unmatched_receipts,
        [
            receipt_meta(&f.receipt_path("_unmatched/acme-b.pdf"), 1000, "ACME"),
            receipt_meta(&f.receipt_path("_unmatched/globex.jpg"), 2000, "GLOBEX"),
        ]
    );
    assert_stored_paths_exist(&result);
}

#[test]
fn candidates_left_out_of_a_confirmed_review_go_to_unmatched() {
    let f = Fixture::new();
    let acme_a = receipt_meta(&f.receipt("acme-a.pdf"), 1000, "ACME");
    let acme_b = receipt_meta(&f.receipt("acme-b.pdf"), 1000, "ACME");
    f.write_result(
        vec![tx(
            ACME_ID,
            "ACME CORP",
            Status::Review,
            &[acme_a.clone(), acme_b],
            "2 receipts match amount",
        )],
        Vec::new(),
    );
    f.write_draft(json!({
        ACME_ID: {
            "status": "MATCHED",
            "receipt_files": [acme_a.file],
            "receipt_meta": [acme_a],
            "notes": "manual_match"
        }
    }));

    f.finalize().unwrap();

    assert_eq!(f.listing("_unmatched"), ["acme-b.pdf"]);
    assert!(!f.exists("acme-b.pdf"));
    assert_eq!(
        f.result().receipts_by_status.unmatched,
        [f.receipt_path("_unmatched/acme-b.pdf")]
    );
}

#[test]
fn a_receipt_referenced_twice_ends_up_in_one_place() {
    let f = Fixture::new();
    let hooli = receipt_meta(&f.receipt("hooli.png"), 2000, "HOOLI");
    f.write_result(
        vec![tx(
            GLOBEX_ID,
            "GLOBEX",
            Status::Review,
            std::slice::from_ref(&hooli),
            "1 receipts match amount",
        )],
        vec![hooli],
    );

    f.finalize().unwrap();

    assert_eq!(f.listing("_review"), ["hooli.png"]);
    assert!(f.listing("_unmatched").is_empty());
    assert!(!f.exists("hooli.png"));
    let result = f.result();
    let target = f.receipt_path("_review/hooli.png");
    assert_eq!(
        result.transactions[0].receipt_files,
        std::slice::from_ref(&target)
    );
    assert_eq!(result.unmatched_receipts[0].file, target);
    assert!(stored_paths(&result).iter().all(|p| *p == target));
    assert_stored_paths_exist(&result);
}

#[test]
fn receipts_with_the_same_name_get_distinct_targets() {
    let f = Fixture::new();
    let first = receipt_meta(&f.receipt("a/acme.pdf"), 1000, "ACME");
    let second = receipt_meta(&f.receipt("b/acme.pdf"), 2000, "ACME");
    f.write_result(
        vec![
            tx(
                ACME_ID,
                "ACME CORP",
                Status::Matched,
                &[first],
                "amount_match",
            ),
            tx(
                GLOBEX_ID,
                "ACME ONLINE",
                Status::Matched,
                &[second],
                "amount_match",
            ),
        ],
        Vec::new(),
    );

    f.finalize().unwrap();

    assert_eq!(f.listing("_matched"), ["acme-1.pdf", "acme.pdf"]);
    assert!(!f.exists("a/acme.pdf") && !f.exists("b/acme.pdf"));
    let result = f.result();
    for (tx, origin) in result.transactions.iter().zip(["a/acme.pdf", "b/acme.pdf"]) {
        let stored = &tx.receipt_files[0];
        assert_eq!(std::fs::read_to_string(stored).unwrap(), origin);
    }
    assert_stored_paths_exist(&result);
}

#[test]
fn receipts_whose_names_differ_only_in_case_keep_both_files() {
    let f = Fixture::new();
    let first = receipt_meta(&f.receipt("a/Invoice.pdf"), 1000, "ACME");
    let second = receipt_meta(&f.receipt("b/invoice.pdf"), 2000, "GLOBEX");
    f.write_result(
        vec![
            tx(
                ACME_ID,
                "ACME CORP",
                Status::Matched,
                &[first],
                "amount_match",
            ),
            tx(
                GLOBEX_ID,
                "GLOBEX",
                Status::Matched,
                &[second],
                "amount_match",
            ),
        ],
        Vec::new(),
    );

    f.finalize().unwrap();

    assert_eq!(f.listing("_matched"), ["Invoice.pdf", "invoice-1.pdf"]);
    let result = f.result();
    for (tx, origin) in result
        .transactions
        .iter()
        .zip(["a/Invoice.pdf", "b/invoice.pdf"])
    {
        let stored = &tx.receipt_files[0];
        assert_eq!(std::fs::read_to_string(stored).unwrap(), origin);
    }
    assert_stored_paths_exist(&result);
}

#[test]
fn existing_files_in_a_status_folder_are_never_overwritten() {
    let f = Fixture::new();
    write_file(&f.paths.receipts.join("_matched/acme.pdf"), b"earlier");
    let first = receipt_meta(&f.receipt("a/acme.pdf"), 1000, "ACME");
    let second = receipt_meta(&f.receipt("b/acme.pdf"), 2000, "ACME");
    f.write_result(
        vec![
            tx(
                ACME_ID,
                "ACME CORP",
                Status::Matched,
                &[first],
                "amount_match",
            ),
            tx(
                GLOBEX_ID,
                "ACME ONLINE",
                Status::Matched,
                &[second],
                "amount_match",
            ),
        ],
        Vec::new(),
    );

    f.finalize().unwrap();

    assert_eq!(f.read("_matched/acme.pdf"), "earlier");
    assert_eq!(f.read("_matched/acme-1.pdf"), "a/acme.pdf");
    assert_eq!(f.read("_matched/acme-2.pdf"), "b/acme.pdf");
    let result = f.result();
    assert_eq!(
        result.receipts_by_status.matched,
        [
            f.receipt_path("_matched/acme-1.pdf"),
            f.receipt_path("_matched/acme-2.pdf")
        ]
    );
    assert_stored_paths_exist(&result);
}

#[test]
fn receipts_outside_the_period_are_dropped_and_never_moved() {
    let f = Fixture::new();
    let acme = receipt_meta(&f.receipt("acme.pdf"), 1000, "ACME");
    let april = Period::parse("2030", "04")
        .unwrap()
        .paths(f.dir.path())
        .receipts
        .join("globex.jpg");
    write_file(&april, b"april");
    let docs_file = f.paths.docs.join("secret.pdf");
    write_file(&docs_file, b"docs");
    let escaping = format!("{}/../docs/secret.pdf", f.paths.receipts.display());
    f.write_result(
        vec![tx(
            ACME_ID,
            "ACME CORP",
            Status::Matched,
            &[
                acme,
                receipt_meta("/etc/hosts", 1000, "ACME"),
                receipt_meta(&escaping, 1000, "ACME"),
            ],
            "amount_match",
        )],
        vec![receipt_meta(&april.to_string_lossy(), 2000, "GLOBEX")],
    );

    f.finalize().unwrap();

    let result = f.result();
    assert_eq!(
        result.transactions[0].receipt_files,
        [f.receipt_path("_matched/acme.pdf")]
    );
    assert_eq!(result.transactions[0].receipt_meta.len(), 1);
    assert!(result.unmatched_receipts.is_empty());
    assert!(result.receipts_by_status.unmatched.is_empty());
    assert_eq!(std::fs::read(&april).unwrap(), b"april");
    assert_eq!(std::fs::read(&docs_file).unwrap(), b"docs");
    assert!(Path::new("/etc/hosts").is_file());
    assert!(f.listing("_unmatched").is_empty());
}

#[cfg(unix)]
#[test]
fn symlinks_leading_out_of_the_receipts_folder_are_dropped() {
    let f = Fixture::new();
    let outside = f.dir.path().join("outside.pdf");
    write_file(&outside, b"outside");
    let link = f.paths.receipts.join("link.pdf");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    f.write_result(
        vec![tx(
            ACME_ID,
            "ACME CORP",
            Status::Matched,
            &[receipt_meta(&link.to_string_lossy(), 1000, "ACME")],
            "amount_match",
        )],
        Vec::new(),
    );

    f.finalize().unwrap();

    assert!(f.result().transactions[0].receipt_files.is_empty());
    assert!(link.symlink_metadata().is_ok(), "the link stays in place");
    assert!(f.listing("_matched").is_empty());
}

#[test]
fn missing_receipts_keep_their_recorded_path() {
    let f = Fixture::new();
    let gone = f.receipt_path("gone.pdf");
    let acme = receipt_meta(&f.receipt("acme.pdf"), 1000, "ACME");
    f.write_result(
        vec![
            tx(
                ACME_ID,
                "ACME CORP",
                Status::Matched,
                &[acme],
                "amount_match",
            ),
            tx(
                GLOBEX_ID,
                "GLOBEX",
                Status::Matched,
                &[receipt_meta(&gone, 2000, "GLOBEX")],
                "amount_match",
            ),
        ],
        Vec::new(),
    );

    f.finalize().unwrap();

    let result = f.result();
    assert_eq!(
        result.transactions[1].receipt_files,
        std::slice::from_ref(&gone)
    );
    assert_eq!(
        result.receipts_by_status.matched,
        [f.receipt_path("_matched/acme.pdf"), gone]
    );
    assert!(f.exists("_matched/acme.pdf"));
}

/// Snapshot of what a failed Finalize must leave untouched.
struct Before {
    result: Vec<u8>,
    report: Vec<u8>,
}

fn prepare_rollback(f: &Fixture) -> Before {
    let acme = receipt_meta(&f.receipt("acme.pdf"), 1000, "ACME");
    let hooli = receipt_meta(&f.receipt("hooli.png"), 4000, "HOOLI");
    f.write_result(
        vec![tx(
            ACME_ID,
            "ACME CORP",
            Status::Matched,
            &[acme],
            "amount_match",
        )],
        vec![hooli],
    );
    f.write_draft(json!({ ACME_ID: { "notes": "manual_match" } }));
    write_file(&f.paths.report(), b"earlier report");
    Before {
        result: std::fs::read(f.paths.match_result()).unwrap(),
        report: std::fs::read(f.paths.report()).unwrap(),
    }
}

fn assert_unchanged(f: &Fixture, before: &Before) {
    assert_eq!(f.read("acme.pdf"), "acme.pdf");
    assert_eq!(f.read("hooli.png"), "hooli.png");
    assert_eq!(
        std::fs::read(f.paths.match_result()).unwrap(),
        before.result
    );
    assert_eq!(std::fs::read(f.paths.report()).unwrap(), before.report);
    assert!(!f.paths.applied_marker().exists());
    assert!(f.paths.draft().is_file());
    assert!(f.temporary_files_in_docs().is_empty());
}

#[test]
fn a_status_folder_that_cannot_be_created_changes_nothing() {
    let f = Fixture::new();
    let before = prepare_rollback(&f);
    write_file(&f.paths.receipts.join("_matched"), b"not a folder");

    let error = f.finalize().unwrap_err();

    assert!(matches!(error, PipelineError::Io(_)), "{error:?}");
    assert_unchanged(&f, &before);
}

/// Restores a folder's permissions when dropped, so the temporary folder can be removed.
#[cfg(unix)]
struct ReadOnly(PathBuf);

#[cfg(unix)]
impl ReadOnly {
    fn new(dir: PathBuf) -> ReadOnly {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        ReadOnly(dir)
    }

    /// Whether the folder really refuses new files; it does not for root.
    fn enforced(&self) -> bool {
        let probe = self.0.join("probe");
        let refused = std::fs::write(&probe, b"x").is_err();
        let _ = std::fs::remove_file(probe);
        refused
    }
}

#[cfg(unix)]
impl Drop for ReadOnly {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

#[cfg(unix)]
#[test]
fn a_failed_move_undoes_the_moves_already_made() {
    let f = Fixture::new();
    let before = prepare_rollback(&f);
    // acme.pdf moves into _matched first; hooli.png then cannot enter _unmatched.
    let locked = ReadOnly::new(f.paths.receipts.join("_unmatched"));
    if !locked.enforced() {
        eprintln!("skipped: folder permissions are not enforced for this user");
        return;
    }

    let error = f.finalize().unwrap_err();

    assert!(matches!(error, PipelineError::Io(_)), "{error:?}");
    assert!(f.listing("_matched").is_empty());
    assert_unchanged(&f, &before);
}

#[cfg(unix)]
#[test]
fn a_failure_after_the_files_are_replaced_restores_everything() {
    let f = Fixture::new();
    let before = prepare_rollback(&f);
    // The marker is written last; a folder in its place makes that step fail.
    std::fs::create_dir(f.paths.applied_marker()).unwrap();

    let error = f.finalize().unwrap_err();

    assert!(matches!(error, PipelineError::Io(_)), "{error:?}");
    assert!(f.listing("_matched").is_empty());
    assert!(f.listing("_unmatched").is_empty());
    assert_eq!(f.read("acme.pdf"), "acme.pdf");
    assert_eq!(f.read("hooli.png"), "hooli.png");
    assert_eq!(
        std::fs::read(f.paths.match_result()).unwrap(),
        before.result
    );
    assert_eq!(std::fs::read(f.paths.report()).unwrap(), before.report);
    assert!(f.paths.draft().is_file());
    assert!(f.temporary_files_in_docs().is_empty());
}

#[test]
fn an_invalid_draft_changes_nothing() {
    let f = Fixture::new();
    let before = prepare_rollback(&f);
    f.write_draft(json!({ ACME_ID: { "status": "DONE" } }));

    let error = f.finalize().unwrap_err();

    assert!(matches!(error, PipelineError::InvalidInput(_)), "{error:?}");
    assert_eq!(
        std::fs::read(f.paths.match_result()).unwrap(),
        before.result
    );
    assert!(f.exists("acme.pdf") && f.exists("hooli.png"));
    assert!(!f.paths.applied_marker().exists());
}

#[test]
fn finalizing_needs_a_match_result() {
    let f = Fixture::new();
    f.receipt("acme.pdf");

    let error = f.finalize().unwrap_err();

    assert!(
        matches!(
            &error,
            PipelineError::Coded {
                code: "not_reconciled",
                ..
            }
        ),
        "{error:?}"
    );
    assert!(f.exists("acme.pdf"));
    assert!(!f.paths.applied_marker().exists());
}
