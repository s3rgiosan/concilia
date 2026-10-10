//! Reconcile, scan and add statements: the jobs that read the statements and receipts and
//! write the match result.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::draft::{clean_saved_draft, match_keeping_draft};
use super::report::write_report;
use super::{
    create_dir, read_cache, read_statements, reset_period, PipelineError, RunContext, RunEvent,
    StatementFile,
};
use crate::bank::{append_statements, normalize_statements, Bank};
use crate::dates::time_now_iso;
use crate::error::ErrorKind;
use crate::extract::extract_all;
use crate::fsutil::{read_json_lenient, read_json_opt, write_json};
use crate::matcher::match_transactions;
use crate::model::{
    DroppedDecision, MatchResult, RawTransaction, ReceiptMeta, StatementRecord,
    StatementTransaction, Status, Summary,
};
use crate::period::PeriodPaths;
use crate::receipts::{is_pdf, walk};
use crate::review::summary;

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
    let existing_count = existing.len();
    let mut transactions = existing;
    transactions.extend(appended.transactions);
    let new_ids: HashSet<&str> = transactions[existing_count..]
        .iter()
        .map(|tx| tx.id.as_str())
        .collect();
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
        .filter(|tx| tx.status == Status::Matched && new_ids.contains(tx.id.as_str()))
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

/// IDs of the transactions the saved match result marks MATCHED; none when it is unreadable.
fn matched_ids(paths: &PeriodPaths) -> HashSet<String> {
    let previous: Option<MatchResult> = read_json_lenient(&paths.match_result());
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
