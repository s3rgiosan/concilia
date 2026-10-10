//! The reconciliation jobs on one period's files: reconcile, scan, rescan, Finalize, report
//! export and review data. Callers hold the period's locks; nothing here touches Tauri.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::bank::{append_statements, normalize_statements, Bank};
use crate::error::ErrorKind;
use crate::excel;
use crate::extract::{
    extract_all, ExtractAllError, ExtractError, ExtractOptions, ReceiptExtractor,
};
use crate::finalize;
use crate::fsutil::{read_json_opt, write_atomic, write_json, FsError};
use crate::matcher::match_transactions;
use crate::model::{
    Draft, DroppedDecision, Language, MatchResult, RawTransaction, ReceiptMeta, Rule,
    StatementRecord, StatementTransaction, Status, Summary,
};
use crate::period::{Period, PeriodPaths};
use crate::poppler::{Poppler, PopplerError};
use crate::receipts::{is_receipt_name, walk, STATUS_FOLDERS};
use crate::review::{claimed_files, clean_draft, effective_unmatched, merge_draft, summary};

/// How long a single-receipt rescan may take.
const RESCAN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PipelineError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Parse(String),
    #[error("{0} not found; install poppler")]
    PopplerMissing(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("this period is finalized; re-run it to scan again")]
    Finalized,
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(String),
    /// A known case the frontend words by `code`.
    #[error("{message}")]
    Coded {
        kind: ErrorKind,
        code: &'static str,
        message: String,
    },
}

impl PipelineError {
    pub fn coded(kind: ErrorKind, code: &'static str, message: impl Into<String>) -> Self {
        PipelineError::Coded {
            kind,
            code,
            message: message.into(),
        }
    }

    fn not_reconciled() -> Self {
        PipelineError::coded(
            ErrorKind::NotFound,
            "not_reconciled",
            "this period has not been reconciled yet",
        )
    }
}

impl From<FsError> for PipelineError {
    fn from(error: FsError) -> PipelineError {
        PipelineError::Io(error.to_string())
    }
}

impl From<ExtractAllError> for PipelineError {
    fn from(error: ExtractAllError) -> PipelineError {
        match error {
            ExtractAllError::Fatal(message) => PipelineError::Unauthorized(message),
            ExtractAllError::Cancelled => PipelineError::Cancelled,
        }
    }
}

impl From<PopplerError> for PipelineError {
    fn from(error: PopplerError) -> PipelineError {
        match error {
            PopplerError::Missing(tool) => PipelineError::PopplerMissing(tool),
            PopplerError::Failed(message) => PipelineError::Parse(message),
        }
    }
}

fn io(path: &Path, error: impl std::fmt::Display) -> PipelineError {
    PipelineError::Io(format!("{}: {error}", path.display()))
}

/// Progress of a reconcile or scan, in the order the steps run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum RunEvent {
    Parsing { count: usize },
    ReceiptsFound { count: usize },
    Extracting { current: usize, total: usize },
    Matching,
    ReimbursementsFound { count: usize },
    ExtractingReimbursements { current: usize, total: usize },
    Exporting,
}

/// The text of a statement PDF.
#[async_trait]
pub trait StatementText: Send + Sync {
    async fn text(&self, pdf: &Path) -> Result<String, PipelineError>;
}

#[async_trait]
impl StatementText for Poppler {
    async fn text(&self, pdf: &Path) -> Result<String, PipelineError> {
        let bytes = tokio::fs::read(pdf).await.map_err(|e| io(pdf, e))?;
        Ok(Poppler::text(self, &bytes).await?)
    }
}

/// Everything a reconcile or scan needs besides the period's files.
pub struct RunContext<'a> {
    pub paths: PeriodPaths,
    pub extractor: &'a dyn ReceiptExtractor,
    pub statements: &'a dyn StatementText,
    pub rules: Vec<Rule>,
    pub language: Language,
    pub options: ExtractOptions,
    pub progress: &'a (dyn Fn(RunEvent) + Send + Sync),
    pub cancel: CancellationToken,
}

impl RunContext<'_> {
    fn check_cancelled(&self) -> Result<(), PipelineError> {
        if self.cancel.is_cancelled() {
            Err(PipelineError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// A statement to parse: its PDF and the bank that issued it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementFile {
    pub path: PathBuf,
    pub bank: Bank,
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

fn create_dir(dir: &Path) -> Result<(), PipelineError> {
    std::fs::create_dir_all(dir).map_err(|e| io(dir, e))
}

/// Reads a cache file, treating an unreadable one as empty so extraction starts over.
fn read_cache(path: &Path) -> Vec<ReceiptMeta> {
    match read_json_opt(path) {
        Ok(cache) => cache.unwrap_or_default(),
        Err(error) => {
            log::warn!("ignoring unreadable cache: {error}");
            Vec::new()
        }
    }
}

async fn extract_to_cache(
    ctx: &RunContext<'_>,
    files: &[String],
    cache_path: &Path,
    force: bool,
    event: fn(usize, usize) -> RunEvent,
) -> Result<Vec<ReceiptMeta>, PipelineError> {
    let total = files.len();
    (ctx.progress)(event(0, total));
    let cache = if force {
        Vec::new()
    } else {
        read_cache(cache_path)
    };
    let progress = |current| (ctx.progress)(event(current, total));
    let receipts = extract_all(
        files,
        &cache,
        force,
        ctx.extractor,
        &ctx.options,
        &progress,
        &ctx.cancel,
    )
    .await?;
    write_json(cache_path, &receipts)?;
    Ok(receipts)
}

/// Extracts the receipts in the period's `receipts/` folder, through the cache.
async fn extract_receipts(
    ctx: &RunContext<'_>,
    force: bool,
) -> Result<Vec<ReceiptMeta>, PipelineError> {
    let files = walk(&ctx.paths.receipts);
    (ctx.progress)(RunEvent::ReceiptsFound { count: files.len() });
    let receipts = extract_to_cache(
        ctx,
        &files,
        &ctx.paths.receipts_cache(),
        force,
        |current, total| RunEvent::Extracting { current, total },
    )
    .await?;
    ctx.check_cancelled()?;
    Ok(receipts)
}

/// Extracts the period's receipts, matches them and writes `match-result.json`.
async fn extract_and_match(
    ctx: &RunContext<'_>,
    transactions: &[StatementTransaction],
    force: bool,
) -> Result<(Vec<ReceiptMeta>, MatchResult), PipelineError> {
    let receipts = extract_receipts(ctx, force).await?;
    (ctx.progress)(RunEvent::Matching);
    let result = match_transactions(transactions, &receipts, &ctx.rules);
    write_json(&ctx.paths.match_result(), &result)?;
    Ok((receipts, result))
}

/// Extracts the receipts in `reimbursements/`, which no transaction matches.
async fn extract_reimbursements(
    ctx: &RunContext<'_>,
    force: bool,
) -> Result<Vec<ReceiptMeta>, PipelineError> {
    let files = walk(&ctx.paths.reimbursements);
    (ctx.progress)(RunEvent::ReimbursementsFound { count: files.len() });
    let cache_path = ctx.paths.reimbursements_cache();
    if files.is_empty() {
        // An emptied folder must not leave stale entries behind.
        if cache_path.exists() {
            write_json(&cache_path, &Vec::<ReceiptMeta>::new())?;
        }
        return Ok(Vec::new());
    }
    extract_to_cache(ctx, &files, &cache_path, force, |current, total| {
        RunEvent::ExtractingReimbursements { current, total }
    })
    .await
}

/// Writes the report through a temporary file next to `path`.
fn write_report(
    result: &MatchResult,
    reimbursements: &[ReceiptMeta],
    language: Language,
    path: &Path,
) -> Result<(), PipelineError> {
    let sheets = excel::build(result, reimbursements, language);
    let tmp = path.with_extension("xlsx.tmp");
    excel::write(&sheets, &tmp).map_err(|e| io(&tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| io(path, e))
}

fn no_bank_match() -> PipelineError {
    PipelineError::coded(
        ErrorKind::Parse,
        "no_bank_match",
        "no transactions found in the statements; check the bank selected for each file",
    )
}

/// Checks that every statement is an existing PDF, then reads each one with its bank's
/// parser.
async fn parse_statements(
    ctx: &RunContext<'_>,
    statements: &[StatementFile],
) -> Result<Vec<Vec<RawTransaction>>, PipelineError> {
    (ctx.progress)(RunEvent::Parsing {
        count: statements.len(),
    });
    if let Some(statement) = statements
        .iter()
        .find(|s| !is_pdf(&s.path) || !s.path.is_file())
    {
        return Err(PipelineError::coded(
            ErrorKind::InvalidInput,
            "not_pdf",
            format!("{} is not a PDF file", statement.path.display()),
        ));
    }
    let mut parsed = Vec::new();
    for statement in statements {
        let text = ctx.statements.text(&statement.path).await?;
        ctx.check_cancelled()?;
        parsed.push(statement.bank.parse_text(&text));
    }
    Ok(parsed)
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/// Records for the statements that added at least one transaction.
fn statement_records(statements: &[StatementFile], counts: &[usize]) -> Vec<StatementRecord> {
    let now = time_now_iso();
    statements
        .iter()
        .zip(counts)
        .filter(|(_, count)| **count > 0)
        .map(|(statement, count)| StatementRecord {
            file: file_name(&statement.path),
            bank: statement.bank,
            transactions: *count,
            added_at: now.clone(),
        })
        .collect()
}

/// Receipt files that saved draft decisions bind to their transactions, with the ID of the
/// transaction each one belongs to. A decision claims the receipts of a transaction it leaves
/// MATCHED, unless it marks the transaction as needing no receipt, as `claimed_files` counts
/// them for the review pool.
fn draft_claims(previous: &MatchResult, draft: &Draft) -> HashMap<String, String> {
    let merged = match merge_draft(previous, draft) {
        Ok(merged) => merged,
        Err(error) => {
            log::warn!("matching without the review draft: {error}");
            return HashMap::new();
        }
    };
    merged
        .into_iter()
        .filter(|tx| draft.contains_key(&tx.id))
        .flat_map(|tx| {
            let files = claimed_files(std::slice::from_ref(&tx));
            files.into_iter().map(move |file| (file, tx.id.clone()))
        })
        .collect()
}

/// Matches the transactions again without handing a receipt claimed by a draft decision to
/// any transaction. Claimed receipts stay out of the automatic pool and are listed among the
/// unmatched receipts unless their own transaction's previous entry lists them, so they return
/// to the review pool when the decision is undone.
fn match_keeping_draft(
    paths: &PeriodPaths,
    transactions: &[StatementTransaction],
    receipts: &[ReceiptMeta],
    rules: &[Rule],
) -> MatchResult {
    let previous: Option<MatchResult> = read_lenient(&paths.match_result());
    let draft: Draft = read_lenient(&paths.draft()).unwrap_or_default();
    let (Some(previous), false) = (previous, draft.is_empty()) else {
        return match_transactions(transactions, receipts, rules);
    };
    let present: HashSet<&str> = receipts.iter().map(|r| r.file.as_str()).collect();
    let claims: HashMap<String, String> = draft_claims(&previous, &draft)
        .into_iter()
        .filter(|(file, _)| present.contains(file.as_str()))
        .collect();
    if claims.is_empty() {
        return match_transactions(transactions, receipts, rules);
    }

    let pool: Vec<ReceiptMeta> = receipts
        .iter()
        .filter(|r| !claims.contains_key(&r.file))
        .cloned()
        .collect();
    let mut result = match_transactions(transactions, &pool, rules);

    // The transactions holding a claim keep the entry the user decided on, less receipts that
    // are gone.
    let owners: HashSet<&str> = claims.values().map(String::as_str).collect();
    for tx in &mut result.transactions {
        if !owners.contains(tx.id.as_str()) {
            continue;
        }
        if let Some(before) = previous.transactions.iter().find(|p| p.id == tx.id) {
            let mut kept = before.clone();
            kept.receipt_meta
                .retain(|m| present.contains(m.file.as_str()));
            kept.receipt_files.retain(|f| present.contains(f.as_str()));
            *tx = kept;
        }
    }

    let referenced: HashSet<String> = result
        .transactions
        .iter()
        .flat_map(|tx| tx.receipt_meta.iter().map(|m| m.file.clone()))
        .collect();
    for receipt in receipts {
        let unreferenced_claim =
            claims.contains_key(&receipt.file) && !referenced.contains(&receipt.file);
        if unreferenced_claim {
            result.unmatched_receipts.push(receipt.clone());
            result
                .receipts_by_status
                .unmatched
                .push(receipt.file.clone());
        }
    }
    result
}

/// Rewrites the saved review draft without the decisions whose receipts are gone, and returns
/// those decisions. A draft that cannot be read or written is left as it is.
fn clean_saved_draft(
    paths: &PeriodPaths,
    receipts: &[ReceiptMeta],
    result: &MatchResult,
) -> Vec<DroppedDecision> {
    match read_json_opt::<Draft>(&paths.draft()) {
        Ok(Some(draft)) => {
            let present: HashSet<String> = receipts.iter().map(|r| r.file.clone()).collect();
            let (kept, removed) = clean_draft(&draft, &present, &result.transactions);
            if let Err(error) = write_json(&paths.draft(), &kept) {
                log::warn!("could not update the review draft: {error}");
                Vec::new()
            } else {
                removed
            }
        }
        Ok(None) => Vec::new(),
        Err(error) => {
            log::warn!("could not read the review draft: {error}");
            Vec::new()
        }
    }
}

/// Parses the statements (or reuses `transactions.json` when there are none), extracts and
/// matches the receipts, extracts reimbursements and writes the report. `clear_cache` first
/// moves finalized receipts back and extracts everything again.
pub async fn reconcile(
    ctx: &RunContext<'_>,
    statements: &[StatementFile],
    clear_cache: bool,
) -> Result<Summary, PipelineError> {
    create_dir(&ctx.paths.docs)?;
    create_dir(&ctx.paths.receipts)?;
    if clear_cache {
        let report = reset_period(&ctx.paths);
        for warning in &report.warnings {
            log::warn!("reset {}: {warning}", ctx.paths.prefix);
        }
    }

    let transactions: Vec<StatementTransaction> = if statements.is_empty() {
        (ctx.progress)(RunEvent::Parsing { count: 0 });
        read_json_opt(&ctx.paths.transactions())?.ok_or_else(|| {
            PipelineError::coded(
                ErrorKind::InvalidInput,
                "no_transactions",
                "add a bank statement; this period has no transactions yet",
            )
        })?
    } else {
        let parsed = parse_statements(ctx, statements).await?;
        let normalized =
            normalize_statements(&parsed).map_err(|e| PipelineError::Parse(e.to_string()))?;
        if normalized.transactions.is_empty() {
            return Err(no_bank_match());
        }
        write_json(&ctx.paths.transactions(), &normalized.transactions)?;
        let records = statement_records(statements, &normalized.counts);
        write_json(&ctx.paths.statements(), &records)?;
        normalized.transactions
    };

    let (receipts, result) = extract_and_match(ctx, &transactions, clear_cache).await?;
    let reimbursements = extract_reimbursements(ctx, clear_cache).await?;
    ctx.check_cancelled()?;

    (ctx.progress)(RunEvent::Exporting);
    write_report(&result, &reimbursements, ctx.language, &ctx.paths.report())?;
    Ok(summary(&result, receipts.len()))
}

/// What a scan for new receipts changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanOutcome {
    pub summary: Summary,
    pub dropped_decisions: Vec<DroppedDecision>,
    /// Receipts read for the first time.
    pub new_receipts: usize,
    /// Transactions the matcher marked MATCHED that were not before, bank fees included.
    pub newly_matched: usize,
}

/// Re-reads the receipts folder against the existing transactions, keeping review decisions
/// whose receipts still exist.
pub async fn scan_receipts(ctx: &RunContext<'_>) -> Result<ScanOutcome, PipelineError> {
    let transactions: Vec<StatementTransaction> =
        read_json_opt(&ctx.paths.transactions())?.ok_or_else(PipelineError::not_reconciled)?;
    if ctx.paths.applied_marker().exists() {
        return Err(PipelineError::Finalized);
    }
    let known: HashSet<String> = read_cache(&ctx.paths.receipts_cache())
        .into_iter()
        .map(|r| r.file)
        .collect();
    let matched_before = matched_ids(&ctx.paths);
    create_dir(&ctx.paths.receipts)?;
    let receipts = extract_receipts(ctx, false).await?;
    (ctx.progress)(RunEvent::Matching);
    let result = match_keeping_draft(&ctx.paths, &transactions, &receipts, &ctx.rules);
    write_json(&ctx.paths.match_result(), &result)?;
    extract_reimbursements(ctx, false).await?;
    let dropped_decisions = clean_saved_draft(&ctx.paths, &receipts, &result);
    let new_receipts = receipts.iter().filter(|r| !known.contains(&r.file)).count();
    let newly_matched = result
        .transactions
        .iter()
        .filter(|tx| tx.status == Status::Matched && !matched_before.contains(&tx.id))
        .count();
    Ok(ScanOutcome {
        summary: summary(&result, receipts.len()),
        dropped_decisions,
        new_receipts,
        newly_matched,
    })
}

/// IDs of the transactions the saved match result marks MATCHED; none when it is unreadable.
fn matched_ids(paths: &PeriodPaths) -> HashSet<String> {
    let previous: Option<MatchResult> = read_json_opt(&paths.match_result()).unwrap_or_else(|e| {
        log::warn!("ignoring unreadable match result: {e}");
        None
    });
    previous
        .map(|result| {
            result
                .transactions
                .into_iter()
                .filter(|tx| tx.status == Status::Matched)
                .map(|tx| tx.id)
                .collect()
        })
        .unwrap_or_default()
}

/// What one statement given to `add_statements` contributed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatementOutcome {
    pub file: String,
    pub bank: Bank,
    pub added: usize,
    /// Rows skipped because the period already holds them.
    pub skipped: usize,
}

/// The outcome of adding statements to a period in review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AddStatementsResult {
    pub summary: Summary,
    /// New transactions added to the period.
    pub added: usize,
    pub duplicates_skipped: usize,
    /// New transactions the matcher marked MATCHED, bank fees included.
    pub newly_matched: usize,
    pub statements: Vec<StatementOutcome>,
    pub dropped_decisions: Vec<DroppedDecision>,
}

/// Adds statements to a reconciled period that is not finalized. Existing transactions keep
/// their IDs, so the review draft still lines up; new ones are numbered after them and rows
/// already present are skipped. Receipts are scanned as `scan_receipts` does, everything is
/// matched again, and draft decisions whose receipts are gone are dropped.
pub async fn add_statements(
    ctx: &RunContext<'_>,
    statements: &[StatementFile],
) -> Result<AddStatementsResult, PipelineError> {
    if ctx.paths.applied_marker().exists() {
        return Err(PipelineError::Finalized);
    }
    let existing: Vec<StatementTransaction> =
        read_json_opt(&ctx.paths.transactions())?.ok_or_else(PipelineError::not_reconciled)?;
    if statements.is_empty() {
        return Err(PipelineError::coded(
            ErrorKind::InvalidInput,
            "no_statements",
            "choose at least one bank statement to add",
        ));
    }

    let parsed = parse_statements(ctx, statements).await?;
    if parsed.iter().all(Vec::is_empty) {
        return Err(no_bank_match());
    }
    let appended =
        append_statements(&existing, &parsed).map_err(|e| PipelineError::Parse(e.to_string()))?;
    let new_ids: HashSet<String> = appended
        .transactions
        .iter()
        .map(|tx| tx.id.clone())
        .collect();
    let mut transactions = existing;
    transactions.extend(appended.transactions);
    ctx.check_cancelled()?;

    // Only caches are written until the last cancellation point, so a cancelled run leaves
    // the period as it was.
    create_dir(&ctx.paths.receipts)?;
    let receipts = extract_receipts(ctx, false).await?;
    (ctx.progress)(RunEvent::Matching);
    let result = match_keeping_draft(&ctx.paths, &transactions, &receipts, &ctx.rules);
    extract_reimbursements(ctx, false).await?;
    ctx.check_cancelled()?;

    write_json(&ctx.paths.transactions(), &transactions)?;
    write_json(&ctx.paths.match_result(), &result)?;
    let added_counts: Vec<usize> = appended.counts.iter().map(|c| c.added).collect();
    let mut records = read_statements(&ctx.paths);
    records.extend(statement_records(statements, &added_counts));
    write_json(&ctx.paths.statements(), &records)?;
    let dropped_decisions = clean_saved_draft(&ctx.paths, &receipts, &result);

    let newly_matched = result
        .transactions
        .iter()
        .filter(|tx| tx.status == Status::Matched && new_ids.contains(&tx.id))
        .count();
    let outcomes: Vec<StatementOutcome> = statements
        .iter()
        .zip(&appended.counts)
        .map(|(statement, count)| StatementOutcome {
            file: file_name(&statement.path),
            bank: statement.bank,
            added: count.added,
            skipped: count.skipped,
        })
        .collect();
    Ok(AddStatementsResult {
        summary: summary(&result, receipts.len()),
        added: new_ids.len(),
        duplicates_skipped: appended.counts.iter().map(|c| c.skipped).sum(),
        newly_matched,
        statements: outcomes,
        dropped_decisions,
    })
}

/// Which folder a rescanned file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RescanKind {
    Receipt,
    Reimbursement,
}

/// A file inside the period, checked: its stored path, and its canonical path for locking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeriodFile {
    pub stored: String,
    pub canonical: PathBuf,
}

/// Resolves a period-relative path (`YYYY/MM/receipts/...`) to a receipt file of `kind`,
/// rejecting anything outside its folder, with another extension, or missing.
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
    if !canonical.starts_with(&folder_real) || !canonical.is_file() {
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
    let extracted =
        tokio::time::timeout(RESCAN_TIMEOUT, extractor.extract(Path::new(&file.stored)))
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
    };
    meta.file = file.stored.clone();

    let _writing = write_lock.lock().await;
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
    Ok(meta)
}

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
        let _ = std::fs::remove_file(&result_tmp);
        let _ = std::fs::remove_file(&report_tmp);
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
    if let Err(error) = finalize::execute(&plan.moves) {
        cleanup();
        return Err(io(&paths.receipts, error));
    }
    if let Err(error) = publish(paths, &result_tmp, &report_tmp) {
        finalize::undo(&plan.moves);
        cleanup();
        return Err(error);
    }
    match std::fs::remove_file(paths.draft()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            log::warn!("could not delete the review draft: {error}");
        }
        _ => {}
    }
    Ok(())
}

/// The contents of a file before Finalize replaces it, to put back if a later step fails.
struct Backup {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}

impl Backup {
    fn take(path: PathBuf) -> Result<Backup, PipelineError> {
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io(&path, error)),
        };
        Ok(Backup { path, bytes })
    }

    fn restore(&self) {
        let restored = match &self.bytes {
            Some(bytes) => write_atomic(&self.path, bytes).map_err(|e| e.to_string()),
            None => match std::fs::remove_file(&self.path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    Err(error.to_string())
                }
                _ => Ok(()),
            },
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
    let backups = [
        Backup::take(paths.match_result())?,
        Backup::take(paths.report())?,
    ];
    let outcome = std::fs::rename(result_tmp, paths.match_result())
        .map_err(|e| io(&paths.match_result(), e))
        .and_then(|_| {
            std::fs::rename(report_tmp, paths.report()).map_err(|e| io(&paths.report(), e))
        })
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

fn time_now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days, Howard Hinnant's algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Writes the report from the match result with pending review decisions applied, and
/// returns its path. Decisions that cannot be applied are left out.
pub fn export_report(paths: &PeriodPaths, language: Language) -> Result<PathBuf, PipelineError> {
    let result: MatchResult =
        read_json_opt(&paths.match_result())?.ok_or_else(PipelineError::not_reconciled)?;
    let draft: Draft = read_json_opt(&paths.draft())
        .unwrap_or_else(|error| {
            log::warn!("report without the review draft: {error}");
            None
        })
        .unwrap_or_default();
    let shown = match merge_draft(&result, &draft) {
        Ok(transactions) => MatchResult {
            transactions,
            ..result.clone()
        },
        Err(error) => {
            log::warn!("report without the review draft: {error}");
            result
        }
    };
    let reimbursements = read_cache(&paths.reimbursements_cache());
    write_report(&shown, &reimbursements, language, &paths.report())?;
    Ok(paths.report())
}

/// What the review screen loads: the match result and reimbursements, each receipt with its
/// period-relative `rel_path` for previews.
pub fn review_data(paths: &PeriodPaths) -> Result<Value, PipelineError> {
    let result: MatchResult =
        read_json_opt(&paths.match_result())?.ok_or_else(PipelineError::not_reconciled)?;
    let reimbursements = read_cache(&paths.reimbursements_cache());
    let with_path = |meta: &ReceiptMeta| -> Value {
        let mut value = serde_json::to_value(meta).unwrap_or(Value::Null);
        if let Value::Object(fields) = &mut value {
            fields.insert(
                "rel_path".into(),
                paths
                    .relative(&meta.file)
                    .map_or(Value::Null, Value::String),
            );
        }
        value
    };
    let transactions: Vec<Value> = result
        .transactions
        .iter()
        .map(|tx| {
            let mut value = serde_json::to_value(tx).unwrap_or(Value::Null);
            value["receipt_meta"] = Value::Array(tx.receipt_meta.iter().map(with_path).collect());
            value
        })
        .collect();
    Ok(serde_json::json!({
        "transactions": transactions,
        "unmatched_receipts": result.unmatched_receipts.iter().map(with_path).collect::<Vec<_>>(),
        "reimbursements": reimbursements.iter().map(with_path).collect::<Vec<_>>(),
        "statements": read_statements(paths),
    }))
}

/// The statements recorded for a period, oldest first; empty when none are recorded.
pub fn read_statements(paths: &PeriodPaths) -> Vec<StatementRecord> {
    read_lenient(&paths.statements()).unwrap_or_default()
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

pub fn read_draft(paths: &PeriodPaths) -> Result<Draft, PipelineError> {
    Ok(read_json_opt(&paths.draft())?.unwrap_or_default())
}

pub fn save_draft(paths: &PeriodPaths, draft: &Draft) -> Result<(), PipelineError> {
    create_dir(&paths.docs)?;
    Ok(write_json(&paths.draft(), draft)?)
}

pub fn delete_draft(paths: &PeriodPaths) -> Result<(), PipelineError> {
    match std::fs::remove_file(paths.draft()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(io(&paths.draft(), error))
        }
        _ => Ok(()),
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

/// Reads a JSON file for the summary; a damaged file counts as absent.
fn read_lenient<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    match read_json_opt(path) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("ignoring unreadable {}: {error}", path.display());
            None
        }
    }
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
    let result: Option<MatchResult> = if paths.match_result().exists() {
        read_lenient(&paths.match_result())
    } else {
        None
    };
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
        None => read_lenient::<Vec<Value>>(&paths.transactions()).map_or(0, |list| list.len()),
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
    let draft: Draft = read_lenient(&paths.draft()).unwrap_or_default();
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResetReport {
    pub restored: usize,
    pub warnings: Vec<String>,
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

/// Moves finalized receipts back into `receipts/` and deletes the extraction cache, the match
/// result and the finalized marker. Transactions, reimbursements, the draft and the report
/// stay. Name clashes get a `-restored` suffix.
pub fn reset_period(paths: &PeriodPaths) -> ResetReport {
    let mut report = ResetReport::default();
    for folder in STATUS_FOLDERS {
        let dir = paths.receipts.join(folder);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let mut target = paths.receipts.join(&name);
            let mut n = 1;
            while target.exists() && n <= 10_000 {
                target = paths.receipts.join(restored_name(&name, n));
                n += 1;
            }
            if target.exists() {
                report
                    .warnings
                    .push(format!("no free name to restore {name}"));
                continue;
            }
            match std::fs::rename(entry.path(), &target) {
                Ok(()) => report.restored += 1,
                Err(error) => report.warnings.push(format!("{name}: {error}")),
            }
        }
    }
    for file in [
        paths.receipts_cache(),
        paths.match_result(),
        paths.applied_marker(),
    ] {
        if let Err(error) = std::fs::remove_file(&file) {
            let kind = error.kind();
            if kind != std::io::ErrorKind::NotFound {
                report.warnings.push(format!("{}: {error}", file.display()));
            }
        }
    }
    report
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
    fn names_restored_files() {
        assert_eq!(restored_name("acme.pdf", 1), "acme-restored.pdf");
        assert_eq!(restored_name("acme.pdf", 2), "acme-restored-2.pdf");
        assert_eq!(restored_name("noext", 1), "noext-restored");
    }

    #[test]
    fn formats_the_current_time_as_iso() {
        let now = time_now_iso();
        assert_eq!(now.len(), 20);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
    }

    #[test]
    fn serializes_run_events_with_a_step_tag() {
        let event = serde_json::to_value(RunEvent::Extracting {
            current: 1,
            total: 3,
        })
        .unwrap();
        assert_eq!(
            event,
            serde_json::json!({ "step": "extracting", "current": 1, "total": 3 })
        );
        let event = serde_json::to_value(RunEvent::Matching).unwrap();
        assert_eq!(event, serde_json::json!({ "step": "matching" }));
    }
}
