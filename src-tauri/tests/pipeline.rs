//! The reconciliation jobs on a period folder: reconcile, scan, adding statements, rescan,
//! report export, review data, drafts and month folders. Statement text and receipt extraction
//! are fakes, so nothing here needs poppler or the network.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use calamine::Data;
use common::{
    read_json_file, receipt_meta, report_rows, report_sheet_names, write_file, write_json_file,
};
use concilia_lib::bank::Bank;
use concilia_lib::extract::{ExtractError, ExtractOptions, ReceiptExtractor};
use concilia_lib::locks::PeriodLocks;
use concilia_lib::model::{
    Draft, DroppedDecision, Language, MatchResult, ReceiptMeta, StatementTransaction, Status,
    Summary,
};
use concilia_lib::period::{Period, PeriodPaths};
use concilia_lib::pipeline::{
    self, PipelineError, RescanKind, RunContext, RunEvent, StatementFile, StatementText,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

fn assert_code(error: &PipelineError, code: &str) {
    assert!(
        matches!(error, PipelineError::Coded { code: c, .. } if *c == code),
        "{error:?}"
    );
}

const ACME_ID: &str = "tx-001-2030-03-01--1000";
const FEE_ID: &str = "tx-002-2030-03-02--100";
const GLOBEX_ID: &str = "tx-003-2030-03-03--2000";

/// A statement with one receipt-backed purchase, one bank fee and one purchase without a
/// receipt.
const STATEMENT: &[&str] = &[
    "EXTRATO 2030-03",
    "  2030-03-01 2030-03-01 ACME CORP              -10,00      90,00",
    "  2030-03-02 2030-03-02 EXAMPLE FEE             -1,00      89,00",
    "  2030-03-03 2030-03-03 GLOBEX                 -20,00      69,00",
];

fn period() -> Period {
    Period::parse("2030", "03").unwrap()
}

/// Canned statement text per PDF path.
#[derive(Default)]
struct FakeStatements {
    texts: Mutex<HashMap<PathBuf, String>>,
    calls: AtomicUsize,
}

#[async_trait]
impl StatementText for FakeStatements {
    async fn text(&self, pdf: &Path) -> Result<String, PipelineError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let text = self.texts.lock().unwrap().get(pdf).cloned();
        text.ok_or_else(|| PipelineError::Parse(format!("no text for {}", pdf.display())))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Behaviour {
    Read,
    Fatal,
    Hang,
}

/// Returns canned metadata by file name and records every call. Unknown names come back
/// without an amount, as an unreadable receipt does.
struct FakeExtractor {
    known: Mutex<HashMap<String, ReceiptMeta>>,
    calls: Mutex<Vec<String>>,
    behaviour: Mutex<Behaviour>,
    delay: Duration,
    /// Refusal codes by file name, as a file check gives them.
    refusals: Mutex<HashMap<String, &'static str>>,
}

impl FakeExtractor {
    fn new() -> FakeExtractor {
        FakeExtractor::with_delay(Duration::ZERO)
    }

    fn with_delay(delay: Duration) -> FakeExtractor {
        FakeExtractor {
            known: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
            behaviour: Mutex::new(Behaviour::Read),
            delay,
            refusals: Mutex::new(HashMap::new()),
        }
    }

    /// Makes the named file come back refused with `code`.
    fn refuses(&self, name: &str, code: &'static str) {
        self.refusals.lock().unwrap().insert(name.to_string(), code);
    }

    fn accepts(&self, name: &str) {
        self.refusals.lock().unwrap().remove(name);
    }

    fn knows(&self, name: &str, amount_cents: i64, vendor: &str) {
        self.known
            .lock()
            .unwrap()
            .insert(name.to_string(), receipt_meta("", amount_cents, vendor));
    }

    fn set(&self, behaviour: Behaviour) {
        *self.behaviour.lock().unwrap() = behaviour;
    }

    /// File names extracted since the last call, sorted.
    fn take_calls(&self) -> Vec<String> {
        let mut calls = std::mem::take(&mut *self.calls.lock().unwrap());
        calls.sort();
        calls
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl ReceiptExtractor for FakeExtractor {
    async fn extract(&self, file: &Path) -> Result<ReceiptMeta, ExtractError> {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let refusal = self.refusals.lock().unwrap().get(&name).copied();
        if let Some(code) = refusal {
            return Err(ExtractError::Rejected {
                code,
                message: format!("{name} is refused"),
            });
        }
        self.calls.lock().unwrap().push(name.clone());
        let behaviour = *self.behaviour.lock().unwrap();
        match behaviour {
            Behaviour::Read => {}
            Behaviour::Fatal => return Err(ExtractError::Fatal("key rejected".into())),
            Behaviour::Hang => std::future::pending::<()>().await,
        }
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        let file = file.to_string_lossy().into_owned();
        let known = self.known.lock().unwrap().get(&name).cloned();
        Ok(match known {
            Some(meta) => ReceiptMeta { file, ..meta },
            None => ReceiptMeta {
                file,
                provider_used: Some("gemini".into()),
                ..Default::default()
            },
        })
    }
}

/// A receipts root with one period, the fakes and the events of the last runs.
struct Harness {
    dir: TempDir,
    paths: PeriodPaths,
    extractor: FakeExtractor,
    statements: FakeStatements,
    events: Arc<Mutex<Vec<RunEvent>>>,
    progress: Box<dyn Fn(RunEvent) + Send + Sync>,
    cancel: CancellationToken,
}

impl Harness {
    fn new() -> Harness {
        Harness::with_extractor(FakeExtractor::new())
    }

    fn with_extractor(extractor: FakeExtractor) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let paths = period().paths(dir.path());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        Harness {
            dir,
            paths,
            extractor,
            statements: FakeStatements::default(),
            events,
            progress: Box::new(move |event| sink.lock().unwrap().push(event)),
            cancel: CancellationToken::new(),
        }
    }

    fn ctx(&self) -> RunContext<'_> {
        RunContext {
            paths: self.paths.clone(),
            extractor: &self.extractor,
            statements: &self.statements,
            rules: Vec::new(),
            language: Language::En,
            options: ExtractOptions {
                backoff: vec![Duration::ZERO],
                attempt_timeout: Duration::from_secs(5),
                concurrency: 4,
            },
            progress: &*self.progress,
            cancel: self.cancel.clone(),
        }
    }

    /// A CGD statement PDF whose text is `lines`.
    fn statement(&self, name: &str, lines: &[&str]) -> StatementFile {
        let path = self.dir.path().join("statements").join(name);
        write_file(&path, b"%PDF-1.4\n");
        self.statements
            .texts
            .lock()
            .unwrap()
            .insert(path.clone(), lines.join("\n"));
        StatementFile {
            path,
            bank: Bank::Cgd,
        }
    }

    fn receipt(&self, relative: &str) -> String {
        let path = self.paths.receipts.join(relative);
        write_file(&path, relative.as_bytes());
        path.to_string_lossy().into_owned()
    }

    fn reimbursement(&self, relative: &str) -> String {
        let path = self.paths.reimbursements.join(relative);
        write_file(&path, relative.as_bytes());
        path.to_string_lossy().into_owned()
    }

    /// The standard statement plus a matching ACME receipt and an unrelated INITECH one.
    fn standard(&self) -> StatementFile {
        self.extractor.knows("acme.pdf", 1000, "ACME");
        self.extractor.knows("initech.png", 5000, "INITECH");
        self.receipt("acme.pdf");
        self.receipt("initech.png");
        self.statement("statement.pdf", STATEMENT)
    }

    fn take_events(&self) -> Vec<RunEvent> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    fn match_result(&self) -> MatchResult {
        read_json_file(&self.paths.match_result())
    }

    fn receipts_cache(&self) -> Vec<ReceiptMeta> {
        read_json_file(&self.paths.receipts_cache())
    }
}

fn files(receipts: &[ReceiptMeta]) -> Vec<String> {
    receipts.iter().map(|r| r.file.clone()).collect()
}

fn draft(value: Value) -> Draft {
    match value {
        Value::Object(map) => map,
        _ => panic!("a draft is an object"),
    }
}

fn extracting(total: usize) -> Vec<RunEvent> {
    (0..=total)
        .map(|current| RunEvent::Extracting { current, total })
        .collect()
}

/// Extraction progress when every receipt comes from the cache: one event for all of them.
fn extracting_from_cache(total: usize) -> Vec<RunEvent> {
    vec![
        RunEvent::Extracting { current: 0, total },
        RunEvent::Extracting {
            current: total,
            total,
        },
    ]
}

fn standard_summary() -> Summary {
    Summary {
        total_transactions: 3,
        matched: 2,
        review: 0,
        unmatched: 1,
        bank_fees: 1,
        total_receipts: 2,
        matched_receipts: 1,
        review_receipts: 0,
        unmatched_receipts: 1,
        match_rate: 67,
    }
}

// Reconcile.

#[tokio::test]
async fn reconciles_one_statement() {
    let h = Harness::new();
    let statement = h.standard();

    let summary = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();

    assert_eq!(summary, standard_summary());
    for file in [
        h.paths.transactions(),
        h.paths.receipts_cache(),
        h.paths.match_result(),
        h.paths.report(),
    ] {
        assert!(file.is_file(), "{} written", file.display());
    }
    assert!(!h.paths.reimbursements_cache().exists());

    let transactions: Vec<StatementTransaction> = read_json_file(&h.paths.transactions());
    let ids: Vec<&str> = transactions.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, [ACME_ID, FEE_ID, GLOBEX_ID]);

    let acme = h.paths.receipts.join("acme.pdf");
    let initech = h.paths.receipts.join("initech.png");
    assert_eq!(
        files(&h.receipts_cache()),
        [
            acme.to_string_lossy().into_owned(),
            initech.to_string_lossy().into_owned()
        ]
    );

    let result = h.match_result();
    let outcome: Vec<(Status, &str)> = result
        .transactions
        .iter()
        .map(|t| (t.status, t.notes.as_str()))
        .collect();
    assert_eq!(
        outcome,
        [
            (Status::Matched, "name_amount_match"),
            (Status::Matched, "bank_fee"),
            (Status::Unmatched, "")
        ]
    );
    assert_eq!(
        result.transactions[0].receipt_files,
        [acme.to_string_lossy()]
    );
    assert_eq!(
        files(&result.unmatched_receipts),
        [initech.to_string_lossy()]
    );
    assert!(report_sheet_names(&h.paths.report()).contains(&"All Transactions".to_string()));

    let mut expected = vec![
        RunEvent::Parsing { count: 1 },
        RunEvent::ReceiptsFound { count: 2 },
    ];
    expected.extend(extracting(2));
    expected.extend([
        RunEvent::Matching,
        RunEvent::ReimbursementsFound { count: 0 },
        RunEvent::Exporting,
    ]);
    assert_eq!(h.take_events(), expected);
}

#[tokio::test]
async fn drops_repeated_transaction_ids_across_statements() {
    let h = Harness::new();
    let first = h.statement(
        "first.pdf",
        &[
            "  2030-03-01 2030-03-01 ACME CORP              -10,00      90,00",
            "  2030-03-02 2030-03-02 EXAMPLE FEE             -1,00      89,00",
        ],
    );
    // Same date and amount as the first statement's first row, so the same ID.
    let second = h.statement(
        "second.pdf",
        &[
            "  2030-03-01 2030-03-01 ACME CORP ONLINE       -10,00     190,00",
            "  2030-03-05 2030-03-05 GLOBEX                 -20,00     170,00",
        ],
    );

    let summary = pipeline::reconcile(&h.ctx(), &[first, second], false)
        .await
        .unwrap();

    let transactions: Vec<StatementTransaction> = read_json_file(&h.paths.transactions());
    let rows: Vec<(&str, &str)> = transactions
        .iter()
        .map(|t| (t.id.as_str(), t.description.as_str()))
        .collect();
    assert_eq!(
        rows,
        [
            (ACME_ID, "ACME CORP"),
            (FEE_ID, "EXAMPLE FEE"),
            ("tx-002-2030-03-05--2000", "GLOBEX"),
        ]
    );
    assert_eq!(summary.total_transactions, 3);
    assert_eq!(h.take_events()[0], RunEvent::Parsing { count: 2 });
}

#[tokio::test]
async fn reconciling_without_statements_reuses_the_transactions() {
    let h = Harness::new();
    let statement = h.standard();
    let first = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    h.take_events();

    let again = pipeline::reconcile(&h.ctx(), &[], false).await.unwrap();

    assert_eq!(again, first);
    assert_eq!(h.statements.calls.load(Ordering::SeqCst), 1);
    assert_eq!(h.take_events()[0], RunEvent::Parsing { count: 0 });
}

#[tokio::test]
async fn reconciling_without_statements_or_transactions_is_invalid() {
    let h = Harness::new();
    h.receipt("acme.pdf");

    let error = pipeline::reconcile(&h.ctx(), &[], false).await.unwrap_err();

    assert_code(&error, "no_transactions");
    assert!(!h.paths.match_result().exists());
    assert_eq!(h.extractor.call_count(), 0);
}

#[tokio::test]
async fn statements_without_transactions_fail_to_parse() {
    let h = Harness::new();
    let statement = h.statement("empty.pdf", &["EXTRATO 2030-03", "SALDO FINAL 0,00"]);

    let error = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap_err();

    assert_code(&error, "no_bank_match");
    assert!(!h.paths.transactions().exists());
}

#[tokio::test]
async fn statements_must_be_existing_pdf_files() {
    let h = Harness::new();
    let text = h.dir.path().join("statements/statement.txt");
    write_file(&text, STATEMENT.join("\n").as_bytes());
    let missing = h.dir.path().join("statements/missing.pdf");

    for path in [text, missing] {
        let statement = StatementFile {
            path: path.clone(),
            bank: Bank::Cgd,
        };
        let error = pipeline::reconcile(&h.ctx(), &[statement], false)
            .await
            .unwrap_err();
        assert_code(&error, "not_pdf");
    }
    assert_eq!(h.statements.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn reuses_cached_high_confidence_receipts() {
    let h = Harness::new();
    let statement = h.standard();
    // Unknown to the extractor, so it comes back without an amount and is not cached.
    h.receipt("blurry.jpg");

    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    assert_eq!(
        h.extractor.take_calls(),
        ["acme.pdf", "blurry.jpg", "initech.png"]
    );

    pipeline::reconcile(&h.ctx(), &[], false).await.unwrap();
    assert_eq!(h.extractor.take_calls(), ["blurry.jpg"]);
    assert_eq!(h.receipts_cache().len(), 3);

    pipeline::reconcile(&h.ctx(), &[], true).await.unwrap();
    assert_eq!(
        h.extractor.take_calls(),
        ["acme.pdf", "blurry.jpg", "initech.png"]
    );
}

#[tokio::test]
async fn clearing_the_cache_restores_finalized_receipts() {
    let h = Harness::new();
    let statement = h.standard();
    let first = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    // Leave the period as Finalize would.
    let receipts = &h.paths.receipts;
    std::fs::create_dir_all(receipts.join("_matched")).unwrap();
    std::fs::create_dir_all(receipts.join("_unmatched")).unwrap();
    std::fs::rename(
        receipts.join("acme.pdf"),
        receipts.join("_matched/acme.pdf"),
    )
    .unwrap();
    std::fs::rename(
        receipts.join("initech.png"),
        receipts.join("_unmatched/initech.png"),
    )
    .unwrap();
    write_file(&h.paths.applied_marker(), b"2030-04-01T00:00:00Z");
    pipeline::save_draft(
        &h.paths,
        &draft(json!({ GLOBEX_ID: { "notes": "transfer" } })),
    )
    .unwrap();
    h.extractor.take_calls();

    let again = pipeline::reconcile(&h.ctx(), &[], true).await.unwrap();

    assert_eq!(again, first);
    assert!(receipts.join("acme.pdf").is_file());
    assert!(receipts.join("initech.png").is_file());
    assert!(!receipts.join("_matched/acme.pdf").exists());
    assert!(!h.paths.applied_marker().exists());
    assert!(h.paths.draft().is_file());
    assert_eq!(h.extractor.take_calls(), ["acme.pdf", "initech.png"]);
}

#[test]
fn resetting_a_period_moves_receipts_back_and_deletes_derived_files() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let receipts = &paths.receipts;
    write_file(&receipts.join("acme.pdf"), b"original");
    write_file(&receipts.join("_matched/acme.pdf"), b"matched");
    write_file(&receipts.join("_review/acme.pdf"), b"review");
    write_file(&receipts.join("_unmatched/globex.jpg"), b"unmatched");
    for file in [
        paths.receipts_cache(),
        paths.match_result(),
        paths.applied_marker(),
        paths.transactions(),
        paths.reimbursements_cache(),
        paths.draft(),
        paths.report(),
    ] {
        write_file(&file, b"[]");
    }

    let report = pipeline::reset_period(&paths);

    assert_eq!(report.restored, 3);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    let read = |name: &str| std::fs::read(receipts.join(name)).unwrap();
    assert_eq!(read("acme.pdf"), b"original");
    assert_eq!(read("acme-restored.pdf"), b"matched");
    assert_eq!(read("acme-restored-2.pdf"), b"review");
    assert_eq!(read("globex.jpg"), b"unmatched");
    for folder in ["_matched", "_review", "_unmatched"] {
        let left = std::fs::read_dir(receipts.join(folder)).unwrap().count();
        assert_eq!(left, 0, "{folder} emptied");
    }
    for gone in [
        paths.receipts_cache(),
        paths.match_result(),
        paths.applied_marker(),
    ] {
        assert!(!gone.exists(), "{} deleted", gone.display());
    }
    for kept in [
        paths.transactions(),
        paths.reimbursements_cache(),
        paths.draft(),
        paths.report(),
    ] {
        assert!(kept.exists(), "{} kept", kept.display());
    }
}

#[test]
fn resetting_an_empty_period_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let report = pipeline::reset_period(&period().paths(dir.path()));
    assert_eq!(report.restored, 0);
    assert!(report.warnings.is_empty());
}

#[tokio::test]
async fn extracts_reimbursements_into_their_own_file_and_the_report() {
    let h = Harness::new();
    let statement = h.standard();
    h.extractor.knows("taxi.jpg", 1500, "TAXI CO");
    let taxi = h.reimbursement("taxi.jpg");

    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();

    let reimbursements: Vec<ReceiptMeta> = read_json_file(&h.paths.reimbursements_cache());
    assert_eq!(files(&reimbursements), std::slice::from_ref(&taxi));
    assert_eq!(reimbursements[0].amount_cents, Some(1500));
    // Reimbursements never take part in matching.
    assert!(!files(&h.match_result().unmatched_receipts).contains(&taxi));
    let events = h.take_events();
    let tail = &events[events.len() - 4..];
    assert_eq!(
        tail,
        [
            RunEvent::ReimbursementsFound { count: 1 },
            RunEvent::ExtractingReimbursements {
                current: 0,
                total: 1
            },
            RunEvent::ExtractingReimbursements {
                current: 1,
                total: 1
            },
            RunEvent::Exporting,
        ]
    );
    assert!(report_sheet_names(&h.paths.report()).contains(&"Reimbursements".to_string()));
    let totals = report_rows(&h.paths.report(), "Totals");
    assert_eq!(
        totals[3],
        [
            Data::String("Reimbursements (paid personally)".into()),
            Data::Float(15.0)
        ]
    );

    std::fs::remove_file(&taxi).unwrap();
    pipeline::reconcile(&h.ctx(), &[], false).await.unwrap();

    let reimbursements: Vec<ReceiptMeta> = read_json_file(&h.paths.reimbursements_cache());
    assert!(reimbursements.is_empty());
    assert!(!report_sheet_names(&h.paths.report()).contains(&"Reimbursements".to_string()));
}

#[tokio::test]
async fn writes_no_reimbursements_file_without_reimbursements() {
    let h = Harness::new();
    let statement = h.standard();

    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();

    assert!(!h.paths.reimbursements_cache().exists());
}

#[tokio::test]
async fn fatal_extraction_errors_stop_the_run_as_unauthorized() {
    let h = Harness::new();
    let statement = h.standard();
    h.extractor.set(Behaviour::Fatal);

    let error = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap_err();

    assert_eq!(error, PipelineError::Unauthorized("key rejected".into()));
    assert!(!h.paths.match_result().exists());
    assert!(!h.paths.report().exists());
}

#[tokio::test]
async fn cancelling_stops_a_hanging_extraction() {
    let h = Harness::new();
    let statement = h.standard();
    h.extractor.set(Behaviour::Hang);
    let mut ctx = h.ctx();
    ctx.options.attempt_timeout = Duration::from_secs(60);
    let started = Instant::now();

    let cancel = async {
        while h.extractor.call_count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        h.cancel.cancel();
    };
    let run = tokio::time::timeout(
        Duration::from_secs(5),
        pipeline::reconcile(&ctx, std::slice::from_ref(&statement), false),
    );
    let (result, ()) = tokio::join!(run, cancel);

    let error = result.expect("cancel ends the run").unwrap_err();
    assert_eq!(error, PipelineError::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!h.paths.match_result().exists());
}

/// Reads every receipt as ACME 10,00 except the one named `slow`, which never answers.
struct HangsOn(&'static str);

#[async_trait]
impl ReceiptExtractor for HangsOn {
    async fn extract(&self, file: &Path) -> Result<ReceiptMeta, ExtractError> {
        let name = file.file_name().unwrap().to_string_lossy();
        if name == self.0 {
            std::future::pending::<()>().await;
        }
        Ok(receipt_meta(&file.to_string_lossy(), 1000, "ACME"))
    }
}

#[tokio::test]
async fn a_cancelled_extraction_keeps_the_receipts_already_read() {
    let h = Harness::new();
    let statement = h.standard();
    let slow = h.receipt("slow.pdf");
    let extractor = HangsOn("slow.pdf");
    let ctx = RunContext {
        extractor: &extractor,
        ..h.ctx()
    };
    let cancel = async {
        while !h.take_events().contains(&RunEvent::Extracting {
            current: 2,
            total: 3,
        }) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        h.cancel.cancel();
    };
    let run = tokio::time::timeout(
        Duration::from_secs(5),
        pipeline::reconcile(&ctx, std::slice::from_ref(&statement), false),
    );
    let (result, ()) = tokio::join!(run, cancel);

    assert_eq!(
        result.expect("cancel ends the run").unwrap_err(),
        PipelineError::Cancelled
    );
    let cached = files(&h.receipts_cache());
    assert_eq!(cached.len(), 2, "{cached:?}");
    assert!(!cached.contains(&slow));
}

#[tokio::test]
async fn statements_must_start_like_a_pdf() {
    let h = Harness::new();
    let statement = h.statement("fake.pdf", STATEMENT);
    write_file(&statement.path, b"#!/bin/sh\necho");

    let error = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap_err();

    assert_code(&error, "not_pdf");
    assert_eq!(h.statements.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn statements_over_the_size_limit_are_refused() {
    let h = Harness::new();
    let statement = h.statement("big.pdf", STATEMENT);
    std::fs::File::create(&statement.path)
        .unwrap()
        .set_len(concilia_lib::filecheck::MAX_INPUT_BYTES + 1)
        .unwrap();

    let error = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap_err();

    assert_code(&error, "file_too_large");
}

// Scan.

#[tokio::test]
async fn scanning_needs_a_reconciled_period() {
    let h = Harness::new();
    h.receipt("acme.pdf");

    let error = pipeline::scan_receipts(&h.ctx()).await.unwrap_err();

    assert_code(&error, "not_reconciled");
    assert_eq!(h.extractor.call_count(), 0);
}

#[tokio::test]
async fn scanning_a_finalized_period_is_refused() {
    let h = Harness::new();
    let statement = h.standard();
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    write_file(&h.paths.applied_marker(), b"2030-04-01T00:00:00Z");

    let error = pipeline::scan_receipts(&h.ctx()).await.unwrap_err();

    assert_eq!(error, PipelineError::Finalized);
}

#[tokio::test]
async fn scanning_drops_decisions_whose_receipts_disappeared() {
    let h = Harness::new();
    let statement = h.standard();
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    let acme = h
        .paths
        .receipts
        .join("acme.pdf")
        .to_string_lossy()
        .into_owned();
    let initech = h
        .paths
        .receipts
        .join("initech.png")
        .to_string_lossy()
        .into_owned();
    pipeline::save_draft(
        &h.paths,
        &draft(json!({
            ACME_ID: {
                "status": "MATCHED",
                "receipt_files": [acme],
                "receipt_meta": [receipt_meta(&acme, 1000, "ACME")],
                "notes": "manual_match"
            },
            GLOBEX_ID: {
                "status": "MATCHED",
                "receipt_files": [initech],
                "receipt_meta": [receipt_meta(&initech, 5000, "INITECH")],
                "notes": "manual_match"
            }
        })),
    )
    .unwrap();
    std::fs::remove_file(&initech).unwrap();
    std::fs::remove_file(h.paths.report()).unwrap();
    h.extractor.knows("hooli.pdf", 3000, "HOOLI");
    let hooli = h.receipt("hooli.pdf");
    h.extractor.take_calls();
    h.take_events();

    let outcome = pipeline::scan_receipts(&h.ctx()).await.unwrap();
    let (summary, dropped) = (outcome.summary, outcome.dropped_decisions);

    assert_eq!(outcome.new_receipts, 1);
    assert_eq!(
        dropped,
        [DroppedDecision {
            tx_id: GLOBEX_ID.into(),
            description: "GLOBEX".into(),
            removed_receipt_files: vec!["initech.png".into()],
        }]
    );
    let kept = pipeline::read_draft(&h.paths).unwrap();
    assert_eq!(kept.keys().collect::<Vec<_>>(), [ACME_ID]);
    assert_eq!(h.extractor.take_calls(), ["hooli.pdf"]);
    assert_eq!(files(&h.receipts_cache()), [acme, hooli.clone()]);
    assert_eq!(summary.total_receipts, 2);
    assert_eq!(files(&h.match_result().unmatched_receipts), [hooli]);
    assert!(!h.paths.report().exists(), "scan writes no report");

    let mut expected = vec![RunEvent::ReceiptsFound { count: 2 }];
    expected.extend(extracting(2));
    expected.extend([
        RunEvent::Matching,
        RunEvent::ReimbursementsFound { count: 0 },
    ]);
    assert_eq!(h.take_events(), expected);
}

#[tokio::test]
async fn scanning_counts_new_receipts_and_new_matches() {
    let h = Harness::new();
    let statement = h.standard();
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    h.extractor.knows("globex.pdf", 2000, "GLOBEX");
    h.receipt("globex.pdf");

    let outcome = pipeline::scan_receipts(&h.ctx()).await.unwrap();

    assert_eq!(outcome.new_receipts, 1);
    assert_eq!(outcome.newly_matched, 1);
    let globex = h
        .match_result()
        .transactions
        .into_iter()
        .find(|t| t.id == GLOBEX_ID)
        .unwrap();
    assert_eq!(globex.status, Status::Matched);

    let again = pipeline::scan_receipts(&h.ctx()).await.unwrap();

    assert_eq!((again.new_receipts, again.newly_matched), (0, 0));
}

// Adding statements.

const HOOLI_ID: &str = "tx-004-2030-03-04--3000";
const INITECH_ID: &str = "tx-005-2030-03-06--5000";

/// A second statement: the ACME purchase again, plus two new purchases.
const SECOND_STATEMENT: &[&str] = &[
    "EXTRATO 2030-03 (2)",
    "  2030-03-01 2030-03-01 ACME CORP              -10,00      90,00",
    "  2030-03-04 2030-03-04 HOOLI                  -30,00      60,00",
    "  2030-03-06 2030-03-06 INITECH                -50,00      10,00",
];

/// The standard period reconciled, with a review decision on GLOBEX, and the second
/// statement ready to add.
async fn reconciled_with_draft(h: &Harness) -> (StatementFile, Draft) {
    let statement = h.standard();
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    let decisions = draft(json!({
        GLOBEX_ID: { "status": "MATCHED", "receipt_files": [], "receipt_meta": [], "notes": "transfer" }
    }));
    pipeline::save_draft(&h.paths, &decisions).unwrap();
    h.extractor.take_calls();
    h.take_events();
    (h.statement("second.pdf", SECOND_STATEMENT), decisions)
}

fn transaction_ids(h: &Harness) -> Vec<String> {
    let transactions: Vec<StatementTransaction> = read_json_file(&h.paths.transactions());
    transactions.into_iter().map(|t| t.id).collect()
}

#[tokio::test]
async fn adding_statements_keeps_ids_and_the_draft() {
    let h = Harness::new();
    let (second, decisions) = reconciled_with_draft(&h).await;

    let added = pipeline::add_statements(&h.ctx(), &[second]).await.unwrap();

    assert_eq!(
        transaction_ids(&h),
        [ACME_ID, FEE_ID, GLOBEX_ID, HOOLI_ID, INITECH_ID]
    );
    assert_eq!(pipeline::read_draft(&h.paths).unwrap(), decisions);
    assert_eq!((added.added, added.duplicates_skipped), (2, 1));
    assert!(added.dropped_decisions.is_empty());
    assert_eq!(
        added.statements,
        [pipeline::StatementOutcome {
            file: "second.pdf".into(),
            bank: Bank::Cgd,
            added: 2,
            skipped: 1,
        }]
    );
    let result = h.match_result();
    let ids: Vec<&str> = result.transactions.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, [ACME_ID, FEE_ID, GLOBEX_ID, HOOLI_ID, INITECH_ID]);
    assert_eq!(result.transactions[0].status, Status::Matched);
    assert_eq!(added.summary.total_transactions, 5);

    let mut expected = vec![
        RunEvent::Parsing { count: 1 },
        RunEvent::ReceiptsFound { count: 2 },
    ];
    expected.extend(extracting_from_cache(2));
    expected.extend([
        RunEvent::Matching,
        RunEvent::ReimbursementsFound { count: 0 },
    ]);
    assert_eq!(h.take_events(), expected);
}

#[tokio::test]
async fn added_transactions_match_receipts_already_extracted() {
    let h = Harness::new();
    let (second, _) = reconciled_with_draft(&h).await;
    h.extractor.knows("hooli.pdf", 3000, "HOOLI");
    let hooli = h.receipt("hooli.pdf");

    let added = pipeline::add_statements(&h.ctx(), &[second]).await.unwrap();

    // Only the new file is read; the INITECH receipt comes from the cache.
    assert_eq!(h.extractor.take_calls(), ["hooli.pdf"]);
    assert_eq!(added.newly_matched, 2);
    let result = h.match_result();
    let by_id = |id: &str| {
        result
            .transactions
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .clone()
    };
    let initech = h
        .paths
        .receipts
        .join("initech.png")
        .to_string_lossy()
        .into_owned();
    assert_eq!(by_id(INITECH_ID).status, Status::Matched);
    assert_eq!(by_id(INITECH_ID).receipt_files, [initech]);
    assert_eq!(by_id(HOOLI_ID).receipt_files, [hooli]);
    assert!(result.unmatched_receipts.is_empty());
    assert_eq!(added.summary.total_receipts, 3);
}

#[tokio::test]
async fn adding_statements_drops_decisions_whose_receipts_disappeared() {
    let h = Harness::new();
    let (second, _) = reconciled_with_draft(&h).await;
    let initech = h.paths.receipts.join("initech.png");
    let stored = initech.to_string_lossy().into_owned();
    pipeline::save_draft(
        &h.paths,
        &draft(json!({
            GLOBEX_ID: {
                "status": "MATCHED",
                "receipt_files": [stored],
                "receipt_meta": [receipt_meta(&stored, 5000, "INITECH")],
                "notes": "manual_match"
            }
        })),
    )
    .unwrap();
    std::fs::remove_file(&initech).unwrap();

    let added = pipeline::add_statements(&h.ctx(), &[second]).await.unwrap();

    assert_eq!(
        added.dropped_decisions,
        [DroppedDecision {
            tx_id: GLOBEX_ID.into(),
            description: "GLOBEX".into(),
            removed_receipt_files: vec!["initech.png".into()],
        }]
    );
    assert!(pipeline::read_draft(&h.paths).unwrap().is_empty());
}

/// A decision assigning `file` to GLOBEX by hand.
fn assigned_to_globex(file: &str, cents: i64, vendor: &str) -> Draft {
    draft(json!({
        GLOBEX_ID: {
            "status": "MATCHED",
            "receipt_files": [file],
            "receipt_meta": [receipt_meta(file, cents, vendor)],
            "notes": "manual_match"
        }
    }))
}

/// The review pool and GLOBEX's receipts once the saved draft applies.
fn pool_and_globex(h: &Harness) -> (Vec<String>, Vec<String>) {
    let result = h.match_result();
    let decisions = pipeline::read_draft(&h.paths).unwrap();
    let merged = concilia_lib::review::merge_draft(&result, &decisions).unwrap();
    let globex = merged.iter().find(|t| t.id == GLOBEX_ID).unwrap();
    let pool = concilia_lib::review::effective_unmatched(&result, &merged);
    (files(&pool), globex.receipt_files.clone())
}

#[tokio::test]
async fn scanning_keeps_a_hand_assigned_receipt_from_other_transactions() {
    let h = Harness::new();
    h.extractor.knows("acme.pdf", 1000, "ACME");
    h.receipt("acme.pdf");
    // Unreadable at first, so the matcher leaves it alone and the user assigns it.
    let scan = h.receipt("scan.png");
    let mut lines = STATEMENT.to_vec();
    lines.push("  2030-03-08 2030-03-08 HOOLI                  -50,00      19,00");
    let statement = h.statement("statement.pdf", &lines);
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    let decisions = assigned_to_globex(&scan, 5000, "HOOLI");
    pipeline::save_draft(&h.paths, &decisions).unwrap();
    // Read again, it now has the HOOLI transaction's amount.
    h.extractor.knows("scan.png", 5000, "HOOLI");

    let dropped = pipeline::scan_receipts(&h.ctx())
        .await
        .unwrap()
        .dropped_decisions;

    assert!(dropped.is_empty());
    assert_eq!(pipeline::read_draft(&h.paths).unwrap(), decisions);
    let result = h.match_result();
    let hooli = result
        .transactions
        .iter()
        .find(|t| t.description == "HOOLI")
        .unwrap();
    assert_eq!(hooli.status, Status::Unmatched);
    assert!(hooli.receipt_files.is_empty());
    assert_eq!(
        files(&result.unmatched_receipts),
        std::slice::from_ref(&scan)
    );
    let (pool, globex) = pool_and_globex(&h);
    assert!(pool.is_empty(), "{pool:?}");
    assert_eq!(globex, std::slice::from_ref(&scan));

    // Undoing the decision returns the receipt to the pool.
    pipeline::delete_draft(&h.paths).unwrap();
    let (pool, _) = pool_and_globex(&h);
    assert_eq!(pool, [scan]);
}

#[tokio::test]
async fn added_transactions_leave_a_hand_assigned_receipt_alone() {
    let h = Harness::new();
    let (second, _) = reconciled_with_draft(&h).await;
    let initech = h
        .paths
        .receipts
        .join("initech.png")
        .to_string_lossy()
        .into_owned();
    let decisions = assigned_to_globex(&initech, 5000, "INITECH");
    pipeline::save_draft(&h.paths, &decisions).unwrap();

    let added = pipeline::add_statements(&h.ctx(), &[second]).await.unwrap();

    assert_eq!(added.newly_matched, 0);
    assert_eq!(pipeline::read_draft(&h.paths).unwrap(), decisions);
    let result = h.match_result();
    let new_initech = result
        .transactions
        .iter()
        .find(|t| t.id == INITECH_ID)
        .unwrap();
    assert_eq!(new_initech.status, Status::Unmatched);
    assert!(new_initech.receipt_files.is_empty());
    let (pool, globex) = pool_and_globex(&h);
    assert!(pool.is_empty(), "{pool:?}");
    assert_eq!(globex, [initech]);
    // The receipt matched automatically before stays with its transaction.
    assert_eq!(result.transactions[0].status, Status::Matched);
}

#[tokio::test]
async fn adding_a_statement_twice_skips_every_row() {
    let h = Harness::new();
    let (second, _) = reconciled_with_draft(&h).await;
    let first = h.statement("statement.pdf", STATEMENT);

    let again = pipeline::add_statements(&h.ctx(), &[first]).await.unwrap();
    assert_eq!((again.added, again.duplicates_skipped), (0, 3));
    assert_eq!(again.newly_matched, 0);

    let twice = pipeline::add_statements(&h.ctx(), &[second.clone(), second])
        .await
        .unwrap();
    assert_eq!((twice.added, twice.duplicates_skipped), (2, 4));
    let outcomes: Vec<(usize, usize)> = twice
        .statements
        .iter()
        .map(|s| (s.added, s.skipped))
        .collect();
    assert_eq!(outcomes, [(2, 1), (0, 3)]);
    assert_eq!(
        transaction_ids(&h),
        [ACME_ID, FEE_ID, GLOBEX_ID, HOOLI_ID, INITECH_ID]
    );
}

#[tokio::test]
async fn identical_rows_within_one_added_statement_stay_distinct() {
    let h = Harness::new();
    let (_, _) = reconciled_with_draft(&h).await;
    let repeated = h.statement(
        "repeated.pdf",
        &[
            "  2030-03-07 2030-03-07 EXAMPLE FEE             -1,00       9,00",
            "  2030-03-07 2030-03-07 EXAMPLE FEE             -1,00       8,00",
        ],
    );

    let added = pipeline::add_statements(&h.ctx(), &[repeated])
        .await
        .unwrap();

    assert_eq!((added.added, added.duplicates_skipped), (2, 0));
    assert_eq!(
        &transaction_ids(&h)[3..],
        ["tx-004-2030-03-07--100", "tx-005-2030-03-07--100"]
    );
}

#[tokio::test]
async fn adding_statements_to_a_finalized_period_is_refused() {
    let h = Harness::new();
    let (second, _) = reconciled_with_draft(&h).await;
    write_file(&h.paths.applied_marker(), b"2030-04-01T00:00:00Z");
    let before = std::fs::read(h.paths.transactions()).unwrap();

    let error = pipeline::add_statements(&h.ctx(), &[second])
        .await
        .unwrap_err();

    assert_eq!(error, PipelineError::Finalized);
    assert_eq!(std::fs::read(h.paths.transactions()).unwrap(), before);
    assert_eq!(h.statements.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn adding_statements_needs_a_reconciled_period() {
    let h = Harness::new();
    let second = h.statement("second.pdf", SECOND_STATEMENT);

    let error = pipeline::add_statements(&h.ctx(), &[second])
        .await
        .unwrap_err();

    assert_code(&error, "not_reconciled");
    assert!(!h.paths.transactions().exists());
}

#[tokio::test]
async fn added_statements_are_checked_like_reconcile_input() {
    let h = Harness::new();
    let _ = reconciled_with_draft(&h).await;
    let parsed_before = h.statements.calls.load(Ordering::SeqCst);

    let error = pipeline::add_statements(&h.ctx(), &[]).await.unwrap_err();
    assert_code(&error, "no_statements");

    let missing = StatementFile {
        path: h.dir.path().join("statements/missing.pdf"),
        bank: Bank::Cgd,
    };
    let good = h.statement("second.pdf", SECOND_STATEMENT);
    let error = pipeline::add_statements(&h.ctx(), &[good, missing])
        .await
        .unwrap_err();
    assert_code(&error, "not_pdf");
    assert_eq!(h.statements.calls.load(Ordering::SeqCst), parsed_before);

    let empty = h.statement("empty.pdf", &["EXTRATO 2030-03", "SALDO FINAL 0,00"]);
    let error = pipeline::add_statements(&h.ctx(), &[empty])
        .await
        .unwrap_err();
    assert_code(&error, "no_bank_match");
    assert_eq!(transaction_ids(&h), [ACME_ID, FEE_ID, GLOBEX_ID]);
}

#[tokio::test]
async fn cancelling_an_addition_leaves_the_period_as_it_was() {
    let h = Harness::new();
    let (second, decisions) = reconciled_with_draft(&h).await;
    h.receipt("hooli.pdf");
    h.extractor.set(Behaviour::Hang);
    let saved = |h: &Harness| {
        [
            h.paths.transactions(),
            h.paths.match_result(),
            h.paths.statements(),
        ]
        .map(|file| std::fs::read(file).unwrap())
    };
    let before = saved(&h);
    let mut ctx = h.ctx();
    ctx.options.attempt_timeout = Duration::from_secs(60);

    let cancel = async {
        while h.extractor.call_count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        h.cancel.cancel();
    };
    let run = tokio::time::timeout(
        Duration::from_secs(5),
        pipeline::add_statements(&ctx, std::slice::from_ref(&second)),
    );
    let (result, ()) = tokio::join!(run, cancel);

    let error = result.expect("cancel ends the run").unwrap_err();
    assert_eq!(error, PipelineError::Cancelled);
    assert_eq!(saved(&h), before);
    assert_eq!(pipeline::read_draft(&h.paths).unwrap(), decisions);
}

#[test]
fn adding_statements_takes_the_period_lock_reconcile_takes() {
    let locks = PeriodLocks::new();
    let reconciling = locks
        .try_exclusive(&period(), concilia_lib::locks::RunKind::Reconcile)
        .unwrap();
    assert_eq!(
        locks
            .try_exclusive(&period(), concilia_lib::locks::RunKind::AddStatements)
            .err(),
        Some(concilia_lib::locks::Busy::Running(
            concilia_lib::locks::RunKind::Reconcile
        ))
    );
    drop(reconciling);

    let adding = locks
        .try_exclusive(&period(), concilia_lib::locks::RunKind::AddStatements)
        .unwrap();
    assert!(locks
        .try_exclusive(&period(), concilia_lib::locks::RunKind::Reconcile)
        .is_err());
    assert!(locks.try_rescan(&period(), "/r/acme.pdf".into()).is_err());
    assert!(locks.cancel(&period()));
    assert!(adding.token().is_cancelled());
}

#[tokio::test]
async fn lists_the_statements_a_period_holds() {
    let h = Harness::new();
    assert!(pipeline::read_statements(&h.paths).is_empty());
    let (second, _) = reconciled_with_draft(&h).await;

    let listed = pipeline::read_statements(&h.paths);
    let rows: Vec<(&str, Bank, usize)> = listed
        .iter()
        .map(|s| (s.file.as_str(), s.bank, s.transactions))
        .collect();
    assert_eq!(rows, [("statement.pdf", Bank::Cgd, 3)]);

    let first = h.statement("statement.pdf", STATEMENT);
    pipeline::add_statements(&h.ctx(), &[second, first])
        .await
        .unwrap();

    let listed = pipeline::read_statements(&h.paths);
    let rows: Vec<(&str, usize)> = listed
        .iter()
        .map(|s| (s.file.as_str(), s.transactions))
        .collect();
    // The repeated statement added nothing, so it is not listed again.
    assert_eq!(rows, [("statement.pdf", 3), ("second.pdf", 2)]);
    assert_eq!(listed[1].added_at.len(), 20);

    let review = serde_json::to_value(pipeline::review_data(&h.paths).unwrap()).unwrap();
    assert_eq!(review["statements"][1]["file"], "second.pdf");
    assert_eq!(review["statements"][1]["bank"], "cgd");
    assert_eq!(review["statements"][1]["transactions"], 2);

    // Reconciling again from the saved transactions keeps the list.
    pipeline::reconcile(&h.ctx(), &[], false).await.unwrap();
    assert_eq!(pipeline::read_statements(&h.paths).len(), 2);
}

// Month folders.

#[test]
fn ensures_the_receipts_folder_of_a_month() {
    let dir = tempfile::tempdir().unwrap();

    let paths = pipeline::ensure_period_dirs(dir.path(), &period()).unwrap();

    assert_eq!(paths, period().paths(dir.path()));
    assert!(paths.receipts.is_dir());
    write_file(&paths.receipts.join("acme.pdf"), b"x");
    pipeline::ensure_period_dirs(dir.path(), &period()).unwrap();
    assert!(paths.receipts.join("acme.pdf").is_file());

    let summary = pipeline::period_summary(dir.path(), &Period::parse("2030", "04").unwrap());
    assert_eq!(summary.status, pipeline::PeriodState::Empty);
    pipeline::ensure_period_dirs(dir.path(), &Period::parse("2030", "04").unwrap()).unwrap();
    let months: Vec<String> = pipeline::list_periods(dir.path())
        .iter()
        .map(|p| format!("{}-{}", p.year, p.month))
        .collect();
    assert_eq!(months, ["2030-04", "2030-03"]);
}

#[test]
fn creates_no_folders_without_the_receipts_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("missing-root");

    assert!(pipeline::ensure_period_dirs(&root, &period()).is_err());
    assert!(!root.exists());
}

#[cfg(unix)]
#[test]
fn creates_no_folders_through_a_symlink_out_of_the_root() {
    let outside = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("2030")).unwrap();

    let error = pipeline::ensure_period_dirs(&root, &period()).unwrap_err();

    assert_code(&error, "outside_root");
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);

    std::fs::remove_file(root.join("2030")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("gone"), root.join("2030")).unwrap();
    let error = pipeline::ensure_period_dirs(&root, &period()).unwrap_err();
    assert_code(&error, "outside_root");
    assert!(!outside.path().join("gone").exists());
}

// Resolving files of a period.

#[test]
fn resolves_files_inside_the_right_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let acme = paths.receipts.join("sub/acme.pdf");
    let taxi = paths.reimbursements.join("taxi.jpg");
    write_file(&acme, b"acme");
    write_file(&taxi, b"taxi");

    let file =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/sub/acme.pdf")
            .unwrap();
    assert_eq!(file.stored, acme.to_string_lossy());
    assert_eq!(file.canonical, acme.canonicalize().unwrap());

    let file = pipeline::resolve_period_file(
        &paths,
        RescanKind::Reimbursement,
        "2030/03/reimbursements/taxi.jpg",
    )
    .unwrap();
    assert_eq!(file.stored, taxi.to_string_lossy());

    for (kind, relative) in [
        (RescanKind::Reimbursement, "2030/03/receipts/sub/acme.pdf"),
        (RescanKind::Receipt, "2030/03/reimbursements/taxi.jpg"),
    ] {
        let error = pipeline::resolve_period_file(&paths, kind, relative).unwrap_err();
        assert_code(&error, "receipt_outside_period");
    }
}

#[test]
fn refuses_files_outside_the_receipts_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    write_file(&paths.receipts.join("acme.pdf"), b"acme");
    write_file(&paths.receipts.join("notes.txt"), b"notes");
    write_file(&paths.docs.join("acme.pdf"), b"docs");
    write_file(&paths.docs.join("match-result.json"), b"{}");
    write_file(
        &period_paths(dir.path(), "04").receipts.join("acme.pdf"),
        b"april",
    );

    for relative in [
        "2030/04/receipts/acme.pdf",
        "2030/033/receipts/acme.pdf",
        "2031/03/receipts/acme.pdf",
        "receipts/acme.pdf",
        "2030/03/docs/acme.pdf",
        "2030/03/docs/match-result.json",
        "2030/03/receipts/../docs/acme.pdf",
        "2030/03/receipts/sub/../../docs/acme.pdf",
        "2030/03//receipts/acme.pdf",
        "2030/03/receipts/notes.txt",
        "2030/03/acme.pdf",
    ] {
        let error =
            pipeline::resolve_period_file(&paths, RescanKind::Receipt, relative).unwrap_err();
        assert_code(&error, "receipt_outside_period");
    }
}

#[test]
fn reports_missing_period_files_as_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    std::fs::create_dir_all(&paths.receipts).unwrap();

    let error =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/gone.pdf")
            .unwrap_err();

    assert_code(&error, "file_missing");
}

#[cfg(unix)]
#[test]
fn refuses_symlinks_leading_out_of_the_receipts_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let outside = dir.path().join("outside.pdf");
    write_file(&outside, b"outside");
    std::fs::create_dir_all(&paths.receipts).unwrap();
    std::os::unix::fs::symlink(&outside, paths.receipts.join("link.pdf")).unwrap();

    let error =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/link.pdf")
            .unwrap_err();

    assert_code(&error, "receipt_outside_period");
}

#[cfg(unix)]
#[test]
fn refuses_a_receipt_named_symlink_to_another_file_type() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let script = paths.receipts.join("run.command");
    write_file(&script, b"#!/bin/sh\n");
    std::os::unix::fs::symlink(&script, paths.receipts.join("invoice.pdf")).unwrap();

    let error =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/invoice.pdf")
            .unwrap_err();

    assert_code(&error, "receipt_outside_period");
}

#[cfg(unix)]
#[test]
fn resolves_a_symlink_to_its_target_inside_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let real = paths.receipts.join("real.pdf");
    write_file(&real, b"%PDF-1.4");
    std::os::unix::fs::symlink(&real, paths.receipts.join("alias.pdf")).unwrap();

    let file =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/alias.pdf")
            .unwrap();

    assert!(file.stored.ends_with("alias.pdf"));
    assert_eq!(file.canonical, real.canonicalize().unwrap());
}

fn period_paths(root: &Path, month: &str) -> PeriodPaths {
    Period::parse("2030", month).unwrap().paths(root)
}

// Rescan.

/// A period whose stored receipt paths start at `stored_root`, with an old ACME reading.
fn rescan_fixture(stored_root: &Path) -> (PeriodPaths, String, String) {
    let paths = period().paths(stored_root);
    let acme = paths
        .receipts
        .join("acme.pdf")
        .to_string_lossy()
        .into_owned();
    let globex = paths
        .receipts
        .join("globex.jpg")
        .to_string_lossy()
        .into_owned();
    write_file(Path::new(&acme), b"acme");
    write_file(Path::new(&globex), b"globex");
    let old_acme = receipt_meta(&acme, 500, "OLD");
    let globex_meta = receipt_meta(&globex, 2000, "GLOBEX");
    write_json_file(
        &paths.receipts_cache(),
        &[old_acme.clone(), globex_meta.clone()],
    );
    write_json_file(
        &paths.match_result(),
        &json!({
            "transactions": [{
                "id": ACME_ID,
                "date": "2030-03-01",
                "description": "ACME CORP",
                "amount_cents": -1000,
                "abs_cents": 1000,
                "status": "REVIEW",
                "receipt_files": [acme, globex],
                "receipt_meta": [old_acme, globex_meta],
                "notes": "filename_match (acme.pdf)"
            }],
            "receiptsByStatus": { "matched": [], "review": [acme, globex], "unmatched": [acme] },
            "unmatchedReceipts": [old_acme]
        }),
    );
    (paths, acme, globex)
}

fn assert_rescanned(paths: &PeriodPaths, acme: &str, globex: &str) {
    let cache: Vec<ReceiptMeta> = read_json_file(&paths.receipts_cache());
    assert_eq!(cache.len(), 2);
    assert_eq!(cache[0], receipt_meta(acme, 1000, "ACME"));
    assert_eq!(cache[1], receipt_meta(globex, 2000, "GLOBEX"));

    let result: MatchResult = read_json_file(&paths.match_result());
    let tx = &result.transactions[0];
    assert_eq!(tx.receipt_files, [acme, globex]);
    assert_eq!(
        tx.receipt_meta,
        [
            receipt_meta(acme, 1000, "ACME"),
            receipt_meta(globex, 2000, "GLOBEX")
        ]
    );
    assert_eq!(
        result.unmatched_receipts,
        [receipt_meta(acme, 1000, "ACME")]
    );
}

#[tokio::test]
async fn rescanning_replaces_every_stored_reading_of_the_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let (paths, acme, globex) = rescan_fixture(dir.path());
    let extractor = FakeExtractor::new();
    extractor.knows("acme.pdf", 1000, "ACME");
    let file =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/acme.pdf")
            .unwrap();
    let locks = PeriodLocks::new();

    let meta = pipeline::rescan(
        &paths,
        &extractor,
        RescanKind::Receipt,
        &file,
        &locks.write_lock(&period()),
    )
    .await
    .unwrap();

    assert_eq!(meta, receipt_meta(&acme, 1000, "ACME"));
    assert_rescanned(&paths, &acme, &globex);
}

#[cfg(unix)]
#[tokio::test]
async fn rescanning_finds_receipts_stored_through_a_symlinked_root() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    std::fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // The JSON files hold paths under the symlink; the rescan resolves under the real root.
    let (_, acme, globex) = rescan_fixture(&link);
    let paths = period().paths(&real.canonicalize().unwrap());
    let extractor = FakeExtractor::new();
    extractor.knows("acme.pdf", 1000, "ACME");
    let file =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/acme.pdf")
            .unwrap();
    assert_ne!(file.stored, acme);
    let locks = PeriodLocks::new();

    pipeline::rescan(
        &paths,
        &extractor,
        RescanKind::Receipt,
        &file,
        &locks.write_lock(&period()),
    )
    .await
    .unwrap();

    assert_rescanned(&paths, &acme, &globex);
}

#[tokio::test]
async fn rescanning_an_uncached_receipt_appends_it() {
    let dir = tempfile::tempdir().unwrap();
    let (paths, _, _) = rescan_fixture(dir.path());
    let hooli = paths.receipts.join("hooli.pdf");
    write_file(&hooli, b"hooli");
    let result_before = std::fs::read(paths.match_result()).unwrap();
    let extractor = FakeExtractor::new();
    extractor.knows("hooli.pdf", 3000, "HOOLI");
    let file =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/hooli.pdf")
            .unwrap();
    let locks = PeriodLocks::new();

    pipeline::rescan(
        &paths,
        &extractor,
        RescanKind::Receipt,
        &file,
        &locks.write_lock(&period()),
    )
    .await
    .unwrap();

    let cache: Vec<ReceiptMeta> = read_json_file(&paths.receipts_cache());
    assert_eq!(cache.len(), 3);
    assert_eq!(
        cache[2],
        receipt_meta(&hooli.to_string_lossy(), 3000, "HOOLI")
    );
    let result_after: Value = read_json_file(&paths.match_result());
    let result_before: Value = serde_json::from_slice(&result_before).unwrap();
    assert_eq!(result_after, result_before);
}

#[tokio::test]
async fn rescanning_a_reimbursement_creates_its_file() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let taxi = paths.reimbursements.join("taxi.jpg");
    write_file(&taxi, b"taxi");
    // A reconciled period always has its docs folder.
    std::fs::create_dir_all(&paths.docs).unwrap();
    let extractor = FakeExtractor::new();
    extractor.knows("taxi.jpg", 1500, "TAXI CO");
    let file = pipeline::resolve_period_file(
        &paths,
        RescanKind::Reimbursement,
        "2030/03/reimbursements/taxi.jpg",
    )
    .unwrap();
    let locks = PeriodLocks::new();

    pipeline::rescan(
        &paths,
        &extractor,
        RescanKind::Reimbursement,
        &file,
        &locks.write_lock(&period()),
    )
    .await
    .unwrap();

    let reimbursements: Vec<ReceiptMeta> = read_json_file(&paths.reimbursements_cache());
    assert_eq!(
        reimbursements,
        [receipt_meta(&taxi.to_string_lossy(), 1500, "TAXI CO")]
    );
    assert!(!paths.receipts_cache().exists());
}

#[tokio::test]
async fn concurrent_rescans_of_one_period_both_land() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let acme = paths.receipts.join("acme.pdf");
    let globex = paths.receipts.join("globex.jpg");
    write_file(&acme, b"acme");
    write_file(&globex, b"globex");
    write_json_file(&paths.receipts_cache(), &Vec::<ReceiptMeta>::new());
    let extractor = FakeExtractor::with_delay(Duration::from_millis(20));
    extractor.knows("acme.pdf", 1000, "ACME");
    extractor.knows("globex.jpg", 2000, "GLOBEX");
    let resolve = |relative: &str| {
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, relative).unwrap()
    };
    let (acme_file, globex_file) = (
        resolve("2030/03/receipts/acme.pdf"),
        resolve("2030/03/receipts/globex.jpg"),
    );
    let locks = PeriodLocks::new();
    let (first_lock, second_lock) = (locks.write_lock(&period()), locks.write_lock(&period()));

    let (first, second) = tokio::join!(
        pipeline::rescan(
            &paths,
            &extractor,
            RescanKind::Receipt,
            &acme_file,
            &first_lock
        ),
        pipeline::rescan(
            &paths,
            &extractor,
            RescanKind::Receipt,
            &globex_file,
            &second_lock
        ),
    );
    first.unwrap();
    second.unwrap();

    let mut cached = files(&read_json_file::<Vec<ReceiptMeta>>(&paths.receipts_cache()));
    cached.sort();
    assert_eq!(
        cached,
        [
            acme.to_string_lossy().into_owned(),
            globex.to_string_lossy().into_owned()
        ]
    );
}

#[tokio::test]
async fn rescan_errors_leave_the_stored_readings_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (paths, _, _) = rescan_fixture(dir.path());
    let cache_before = std::fs::read(paths.receipts_cache()).unwrap();
    let extractor = FakeExtractor::new();
    extractor.set(Behaviour::Fatal);
    let file =
        pipeline::resolve_period_file(&paths, RescanKind::Receipt, "2030/03/receipts/acme.pdf")
            .unwrap();
    let locks = PeriodLocks::new();

    let error = pipeline::rescan(
        &paths,
        &extractor,
        RescanKind::Receipt,
        &file,
        &locks.write_lock(&period()),
    )
    .await
    .unwrap_err();

    assert_eq!(error, PipelineError::Unauthorized("key rejected".into()));
    assert_eq!(std::fs::read(paths.receipts_cache()).unwrap(), cache_before);
}

// Report export.

fn without_receipt_total(report: &Path) -> Data {
    let totals = report_rows(report, "Totals");
    assert_eq!(
        totals[1][0],
        Data::String("Transactions without receipt".into())
    );
    totals[1][1].clone()
}

#[tokio::test]
async fn exports_the_report_with_pending_decisions() {
    let h = Harness::new();
    let statement = h.standard();
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    assert_eq!(without_receipt_total(&h.paths.report()), Data::Float(0.0));
    let result_before = std::fs::read(h.paths.match_result()).unwrap();
    pipeline::save_draft(
        &h.paths,
        &draft(json!({
            GLOBEX_ID: { "status": "MATCHED", "receipt_files": [], "receipt_meta": [], "notes": "no_receipt" }
        })),
    )
    .unwrap();

    let report = pipeline::export_report(&h.paths, Language::En).unwrap();

    assert_eq!(report, h.paths.report());
    assert_eq!(without_receipt_total(&report), Data::Float(-20.0));
    assert_eq!(
        std::fs::read(h.paths.match_result()).unwrap(),
        result_before
    );
    assert!(h.paths.draft().is_file());
}

#[tokio::test]
async fn exports_the_plain_result_when_the_draft_does_not_apply() {
    let h = Harness::new();
    let statement = h.standard();
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    pipeline::save_draft(
        &h.paths,
        &draft(json!({ GLOBEX_ID: { "status": "DONE", "notes": "no_receipt" } })),
    )
    .unwrap();

    let report = pipeline::export_report(&h.paths, Language::En).unwrap();

    assert_eq!(without_receipt_total(&report), Data::Float(0.0));
}

#[test]
fn exporting_needs_a_match_result() {
    let dir = tempfile::tempdir().unwrap();
    let error = pipeline::export_report(&period().paths(dir.path()), Language::En).unwrap_err();
    assert_code(&error, "not_reconciled");
}

// Review data, status and drafts.

#[tokio::test]
async fn review_data_adds_period_relative_paths() {
    let h = Harness::new();
    let statement = h.standard();
    h.extractor.knows("taxi.jpg", 1500, "TAXI CO");
    h.reimbursement("taxi.jpg");
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();

    let data = serde_json::to_value(pipeline::review_data(&h.paths).unwrap()).unwrap();

    assert_eq!(
        data["transactions"][0]["receipt_meta"][0]["rel_path"],
        "2030/03/receipts/acme.pdf"
    );
    assert_eq!(data["transactions"][0]["id"], ACME_ID);
    assert_eq!(
        data["unmatched_receipts"][0]["rel_path"],
        "2030/03/receipts/initech.png"
    );
    assert_eq!(
        data["reimbursements"][0]["rel_path"],
        "2030/03/reimbursements/taxi.jpg"
    );
    let every_receipt = data["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|tx| tx["receipt_meta"].as_array().unwrap())
        .chain(data["unmatched_receipts"].as_array().unwrap())
        .chain(data["reimbursements"].as_array().unwrap());
    for receipt in every_receipt {
        let relative = receipt["rel_path"].as_str().unwrap();
        assert!(relative.starts_with("2030/03/"), "{relative}");
        assert!(h
            .paths
            .dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(relative)
            .is_file());
    }
}

#[test]
fn review_data_has_a_stable_json_shape() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let inside = |name: &str| paths.receipts.join(name).to_string_lossy().into_owned();
    let reimbursed = paths
        .reimbursements
        .join("fare.jpg")
        .to_string_lossy()
        .into_owned();
    write_json_file(
        &paths.match_result(),
        &json!({
            "transactions": [
                {
                    "id": "tx-001",
                    "date": "2030-03-01",
                    "description": "ACME CORP",
                    "amount_cents": -1000,
                    "abs_cents": 1000,
                    "status": "MATCHED",
                    "receipt_files": [inside("acme.pdf")],
                    "receipt_meta": [{
                        "file": inside("acme.pdf"),
                        "amount_cents": 1000,
                        "confidence": "high",
                        "currency": "EUR",
                        "vendor": "ACME CORP",
                        "date": "2030-03-01",
                        "provider_used": "gemini",
                        "tag": "kept"
                    }],
                    "notes": "amount_match",
                    "flag": true
                },
                {
                    "id": "tx-002",
                    "date": "2030-03-02",
                    "description": "GLOBEX",
                    "amount_cents": -2000,
                    "abs_cents": 2000,
                    "status": "REVIEW",
                    "receipt_files": ["/elsewhere/globex.pdf"],
                    "receipt_meta": [{ "file": "/elsewhere/globex.pdf" }],
                    "notes": "1 receipts match amount"
                },
                {
                    "id": "tx-003",
                    "date": "2030-03-03",
                    "description": "HOOLI",
                    "amount_cents": -300,
                    "abs_cents": 300
                }
            ],
            "receiptsByStatus": { "matched": [], "review": [], "unmatched": [] },
            "unmatchedReceipts": [{
                "file": inside("initech.png"),
                "amount_cents": null,
                "vendor": "INITECH"
            }]
        }),
    );
    write_json_file(
        &paths.reimbursements_cache(),
        &json!([{ "file": reimbursed, "amount_cents": 1500, "vendor": "TAXI CO" }]),
    );
    write_json_file(
        &paths.statements(),
        &json!([{
            "file": "statement.pdf",
            "bank": "cgd",
            "transactions": 3,
            "added_at": "2030-04-01T00:00:00Z"
        }]),
    );

    let data = serde_json::to_value(pipeline::review_data(&paths).unwrap()).unwrap();

    assert_eq!(
        data,
        json!({
            "transactions": [
                {
                    "id": "tx-001",
                    "date": "2030-03-01",
                    "description": "ACME CORP",
                    "amount_cents": -1000,
                    "abs_cents": 1000,
                    "status": "MATCHED",
                    "receipt_files": [inside("acme.pdf")],
                    "receipt_meta": [{
                        "file": inside("acme.pdf"),
                        "amount_cents": 1000,
                        "confidence": "high",
                        "currency": "EUR",
                        "vendor": "ACME CORP",
                        "date": "2030-03-01",
                        "provider_used": "gemini",
                        "tag": "kept",
                        "rel_path": "2030/03/receipts/acme.pdf"
                    }],
                    "notes": "amount_match",
                    "flag": true
                },
                {
                    "id": "tx-002",
                    "date": "2030-03-02",
                    "description": "GLOBEX",
                    "amount_cents": -2000,
                    "abs_cents": 2000,
                    "status": "REVIEW",
                    "receipt_files": ["/elsewhere/globex.pdf"],
                    "receipt_meta": [{
                        "file": "/elsewhere/globex.pdf",
                        "amount_cents": null,
                        "confidence": null,
                        "currency": null,
                        "vendor": null,
                        "date": null,
                        "provider_used": null,
                        "rel_path": null
                    }],
                    "notes": "1 receipts match amount"
                },
                {
                    "id": "tx-003",
                    "date": "2030-03-03",
                    "description": "HOOLI",
                    "amount_cents": -300,
                    "abs_cents": 300,
                    "status": "UNMATCHED",
                    "receipt_files": [],
                    "receipt_meta": [],
                    "notes": ""
                }
            ],
            "unmatched_receipts": [{
                "file": inside("initech.png"),
                "amount_cents": null,
                "confidence": null,
                "currency": null,
                "vendor": "INITECH",
                "date": null,
                "provider_used": null,
                "rel_path": "2030/03/receipts/initech.png"
            }],
            "reimbursements": [{
                "file": reimbursed,
                "amount_cents": 1500,
                "confidence": null,
                "currency": null,
                "vendor": "TAXI CO",
                "date": null,
                "provider_used": null,
                "rel_path": "2030/03/reimbursements/fare.jpg"
            }],
            "statements": [{
                "file": "statement.pdf",
                "bank": "cgd",
                "transactions": 3,
                "added_at": "2030-04-01T00:00:00Z"
            }],
            "refused_files": []
        })
    );
}

#[test]
fn review_data_needs_a_match_result() {
    let dir = tempfile::tempdir().unwrap();
    let error = pipeline::review_data(&period().paths(dir.path())).unwrap_err();
    assert_code(&error, "not_reconciled");
}

#[test]
fn reports_what_exists_for_a_period() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    let status = pipeline::period_status(&paths);
    assert!(!status.exists && !status.applied && !status.has_transactions && !status.has_draft);

    write_file(&paths.match_result(), b"{}");
    write_file(&paths.transactions(), b"[]");
    let status = pipeline::period_status(&paths);
    assert!(status.exists && status.has_transactions);
    assert!(!status.applied && !status.has_draft);

    write_file(&paths.applied_marker(), b"2030-04-01T00:00:00Z");
    write_file(&paths.draft(), b"{}");
    let status = pipeline::period_status(&paths);
    assert!(status.applied && status.has_draft);
}

#[test]
fn saves_reads_and_deletes_drafts() {
    let dir = tempfile::tempdir().unwrap();
    let paths = period().paths(dir.path());
    assert!(pipeline::read_draft(&paths).unwrap().is_empty());
    pipeline::delete_draft(&paths).unwrap();

    let decisions = draft(json!({
        GLOBEX_ID: { "status": "MATCHED", "receipt_files": [], "receipt_meta": [], "notes": "transfer" },
        ACME_ID: { "status": "UNMATCHED" }
    }));
    pipeline::save_draft(&paths, &decisions).unwrap();
    assert_eq!(pipeline::read_draft(&paths).unwrap(), decisions);
    assert!(pipeline::period_status(&paths).has_draft);

    pipeline::delete_draft(&paths).unwrap();
    assert!(!paths.draft().exists());
    assert!(pipeline::read_draft(&paths).unwrap().is_empty());
}

// Refused files.

/// The standard period plus a receipt the extractor refuses.
async fn reconciled_with_refused(h: &Harness, code: &'static str) -> String {
    let statement = h.standard();
    let refused = h.receipt("huge.pdf");
    h.extractor.refuses("huge.pdf", code);
    pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();
    refused
}

#[tokio::test]
async fn a_refused_file_takes_no_part_in_matching_or_counts() {
    let h = Harness::new();
    let refused = reconciled_with_refused(&h, "file_too_large").await;

    let result = h.match_result();
    assert!(!files(&result.unmatched_receipts).contains(&refused));
    assert!(!result.receipts_by_status.unmatched.contains(&refused));
    assert!(!result.receipts_by_status.review.contains(&refused));

    let rows = report_rows(&h.paths.report(), "Unmatched");
    let text = format!("{rows:?}");
    assert!(!text.contains("huge.pdf"), "{text}");
}

#[tokio::test]
async fn reconcile_reports_the_readable_receipts_only() {
    let h = Harness::new();
    let statement = h.standard();
    h.receipt("huge.pdf");
    h.extractor.refuses("huge.pdf", "file_too_large");

    let summary = pipeline::reconcile(&h.ctx(), &[statement], false)
        .await
        .unwrap();

    assert_eq!(summary, standard_summary());
}

#[tokio::test]
async fn refused_files_are_listed_in_the_review_data_with_their_code() {
    let h = Harness::new();
    let refused = reconciled_with_refused(&h, "unrecognized_file").await;

    let data = serde_json::to_value(pipeline::review_data(&h.paths).unwrap()).unwrap();

    assert_eq!(
        data["refused_files"],
        json!([{
            "file": refused,
            "rel_path": "2030/03/receipts/huge.pdf",
            "code": "unrecognized_file"
        }])
    );
    let rows = data["unmatched_receipts"].to_string();
    assert!(!rows.contains("huge.pdf"), "{rows}");
}

#[tokio::test]
async fn a_refused_file_is_not_cached_as_a_read() {
    let h = Harness::new();
    let refused = reconciled_with_refused(&h, "file_too_large").await;

    let cached = h.receipts_cache();
    let entry = cached.iter().find(|r| r.file == refused).unwrap();
    assert_eq!(entry.refused.as_deref(), Some("file_too_large"));
    assert_ne!(entry.confidence.as_deref(), Some("high"));
}

#[tokio::test]
async fn a_replaced_file_is_read_on_the_next_scan() {
    let h = Harness::new();
    let refused = reconciled_with_refused(&h, "file_too_large").await;
    h.extractor.take_calls();

    h.extractor.accepts("huge.pdf");
    h.extractor.knows("huge.pdf", 2000, "GLOBEX");
    let outcome = pipeline::scan_receipts(&h.ctx()).await.unwrap();

    assert_eq!(h.extractor.take_calls(), ["huge.pdf"]);
    assert_eq!(outcome.new_receipts, 0);
    let data = pipeline::review_data(&h.paths).unwrap();
    assert!(data.refused_files.is_empty());
    let result = h.match_result();
    let all: Vec<&str> = result
        .transactions
        .iter()
        .flat_map(|tx| tx.receipt_meta.iter())
        .chain(&result.unmatched_receipts)
        .map(|r| r.file.as_str())
        .collect();
    assert!(all.contains(&refused.as_str()), "{all:?}");
}

#[tokio::test]
async fn a_still_refused_file_is_checked_again_on_the_next_scan() {
    let h = Harness::new();
    reconciled_with_refused(&h, "file_too_large").await;

    pipeline::scan_receipts(&h.ctx()).await.unwrap();

    let data = pipeline::review_data(&h.paths).unwrap();
    assert_eq!(data.refused_files.len(), 1);
    assert_eq!(data.refused_files[0].code, "file_too_large");
}

#[tokio::test]
async fn a_refused_file_that_was_removed_is_no_longer_listed() {
    let h = Harness::new();
    let refused = reconciled_with_refused(&h, "file_too_large").await;

    std::fs::remove_file(&refused).unwrap();

    assert!(pipeline::review_data(&h.paths)
        .unwrap()
        .refused_files
        .is_empty());
}

#[tokio::test]
async fn finalizing_leaves_a_refused_file_in_place() {
    let h = Harness::new();
    let refused = reconciled_with_refused(&h, "file_too_large").await;

    pipeline::finalize(&h.paths, Language::En).unwrap();

    assert!(Path::new(&refused).is_file());
    assert!(!h.paths.receipts.join("_unmatched/huge.pdf").exists());
}

#[tokio::test]
async fn rescanning_a_refused_file_returns_its_code_without_calling_the_reader() {
    let h = Harness::new();
    reconciled_with_refused(&h, "unrecognized_file").await;
    h.extractor.take_calls();
    let file =
        pipeline::resolve_period_file(&h.paths, RescanKind::Receipt, "2030/03/receipts/huge.pdf")
            .unwrap();
    let locks = PeriodLocks::new();

    let error = pipeline::rescan(
        &h.paths,
        &h.extractor,
        RescanKind::Receipt,
        &file,
        &locks.write_lock(&period()),
    )
    .await
    .unwrap_err();

    assert_code(&error, "unrecognized_file");
    assert_eq!(h.extractor.call_count(), 0);
}
