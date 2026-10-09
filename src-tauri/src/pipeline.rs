//! The reconciliation jobs on one period's files: reconcile, scan, rescan, Finalize, report
//! export and review data. Callers hold the period's locks; nothing here touches Tauri.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::bank::{normalize_statements, Bank};
use crate::excel;
use crate::extract::{
    extract_all, ExtractAllError, ExtractError, ExtractOptions, ReceiptExtractor,
};
use crate::finalize;
use crate::fsutil::{read_json_opt, write_atomic, write_json, FsError};
use crate::matcher::match_transactions;
use crate::model::{
    Draft, DroppedDecision, Language, MatchResult, ReceiptMeta, Rule, StatementTransaction, Summary,
};
use crate::period::PeriodPaths;
use crate::poppler::{Poppler, PopplerError};
use crate::receipts::{is_receipt_name, walk, STATUS_FOLDERS};
use crate::review::{clean_draft, effective_unmatched, merge_draft, summary};

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

/// Extracts the period's receipts, matches them and writes `match-result.json`.
async fn extract_and_match(
    ctx: &RunContext<'_>,
    transactions: &[StatementTransaction],
    force: bool,
) -> Result<(Vec<ReceiptMeta>, MatchResult), PipelineError> {
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
            PipelineError::InvalidInput(
                "add a bank statement; this period has no transactions yet".into(),
            )
        })?
    } else {
        (ctx.progress)(RunEvent::Parsing {
            count: statements.len(),
        });
        let mut parsed = Vec::new();
        for statement in statements {
            if !is_pdf(&statement.path) || !statement.path.is_file() {
                return Err(PipelineError::InvalidInput(format!(
                    "{} is not a PDF file",
                    statement.path.display()
                )));
            }
            let text = ctx.statements.text(&statement.path).await?;
            ctx.check_cancelled()?;
            parsed.push(statement.bank.parse_text(&text));
        }
        let transactions =
            normalize_statements(&parsed).map_err(|e| PipelineError::Parse(e.to_string()))?;
        if transactions.is_empty() {
            return Err(PipelineError::Parse(
                "no transactions found in the statements; check the bank selected for each file"
                    .into(),
            ));
        }
        write_json(&ctx.paths.transactions(), &transactions)?;
        transactions
    };

    let (receipts, result) = extract_and_match(ctx, &transactions, clear_cache).await?;
    let reimbursements = extract_reimbursements(ctx, clear_cache).await?;
    ctx.check_cancelled()?;

    (ctx.progress)(RunEvent::Exporting);
    write_report(&result, &reimbursements, ctx.language, &ctx.paths.report())?;
    Ok(summary(&result, receipts.len()))
}

/// Re-reads the receipts folder against the existing transactions, keeping review decisions
/// whose receipts still exist.
pub async fn scan_receipts(
    ctx: &RunContext<'_>,
) -> Result<(Summary, Vec<DroppedDecision>), PipelineError> {
    let transactions: Vec<StatementTransaction> = read_json_opt(&ctx.paths.transactions())?
        .ok_or_else(|| PipelineError::NotFound("this period has not been reconciled yet".into()))?;
    if ctx.paths.applied_marker().exists() {
        return Err(PipelineError::Finalized);
    }
    create_dir(&ctx.paths.receipts)?;
    let (receipts, result) = extract_and_match(ctx, &transactions, false).await?;
    extract_reimbursements(ctx, false).await?;

    let mut dropped = Vec::new();
    match read_json_opt::<Draft>(&ctx.paths.draft()) {
        Ok(Some(draft)) => {
            let present: HashSet<String> = receipts.iter().map(|r| r.file.clone()).collect();
            let (kept, removed) = clean_draft(&draft, &present, &result.transactions);
            if let Err(error) = write_json(&ctx.paths.draft(), &kept) {
                log::warn!("could not update the review draft: {error}");
            } else {
                dropped = removed;
            }
        }
        Ok(None) => {}
        Err(error) => log::warn!("could not read the review draft: {error}"),
    }
    Ok((summary(&result, receipts.len()), dropped))
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
    let outside = || PipelineError::InvalidInput("the file is not a receipt of this period".into());
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
    let canonical = stored_path
        .canonicalize()
        .map_err(|_| PipelineError::NotFound("the receipt file no longer exists".into()))?;
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
            .map_err(|_| PipelineError::Io("Gemini took too long to read the receipt".into()))?;
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
    let result: MatchResult = read_json_opt(&paths.match_result())?
        .ok_or_else(|| PipelineError::NotFound("this period has not been reconciled yet".into()))?;
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
    std::fs::rename(&result_tmp, paths.match_result()).map_err(|e| io(&paths.match_result(), e))?;
    std::fs::rename(&report_tmp, paths.report()).map_err(|e| io(&paths.report(), e))?;

    let now = time_now_iso();
    write_atomic(&paths.applied_marker(), now.as_bytes())?;
    match std::fs::remove_file(paths.draft()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            log::warn!("could not delete the review draft: {error}");
        }
        _ => {}
    }
    Ok(())
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
    let result: MatchResult = read_json_opt(&paths.match_result())?
        .ok_or_else(|| PipelineError::NotFound("this period has not been reconciled yet".into()))?;
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
    let result: MatchResult = read_json_opt(&paths.match_result())?
        .ok_or_else(|| PipelineError::NotFound("this period has not been reconciled yet".into()))?;
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
    }))
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
            if error.kind() != std::io::ErrorKind::NotFound {
                report.warnings.push(format!("{}: {error}", file.display()));
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

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
