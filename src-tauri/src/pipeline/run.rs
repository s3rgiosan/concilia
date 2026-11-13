//! Reconcile, scan and add statements: the jobs that read the statements and receipts and
//! write the match result.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::draft::{clean_saved_draft, match_keeping_draft, match_with_draft};
use super::journal::recover;
use super::report::write_report;
use super::stored::{read_stored_lenient, write_stored};
use super::{
    check_statement, create_dir, not_pdf, off_thread, read_cache, read_statements, readable,
    reset_period, PipelineError, RunContext, RunEvent, StatementFile,
};
use crate::bank::{append_statements, normalize_statements, Bank};
use crate::dates::time_now_iso;
use crate::error::ErrorKind;
use crate::extract::{extract_all_observed, ExtractProgress};
use crate::fsutil::{read_json_lenient, read_json_opt, write_json, FsError};
use crate::model::{
    Draft, DroppedDecision, FileIdentity, MatchResult, RawTransaction, ReceiptMeta, Rule,
    StatementRecord, StatementTransaction, Status, Summary,
};
use crate::period::PeriodPaths;
use crate::receipts::{is_pdf, walk};
use crate::review::summary;

/// The extraction cache is saved after this many newly read receipts…
const CACHE_SAVE_EVERY: usize = 10;
/// …or after this long, whichever comes first.
const CACHE_SAVE_INTERVAL: Duration = Duration::from_secs(2);

/// Parses the statements (or reuses `transactions.json` when there are none), extracts and
/// matches the receipts, extracts reimbursements and writes the report. `clear_cache` first
/// moves finalized receipts back and extracts everything again. Without `clear_cache`, a
/// finalized period is refused, because its receipts are in the status folders.
pub async fn reconcile(
    ctx: &RunContext<'_>,
    statements: &[StatementFile],
    clear_cache: bool,
) -> Result<Summary, PipelineError> {
    let paths = ctx.paths.clone();
    let rules = ctx.rules.clone();
    // The previous result is read before the reset deletes it, so the draft's receipt claims
    // still apply to the new match.
    let previous = off_thread(move || {
        recover(&paths)?;
        if !clear_cache && paths.applied_marker().exists() {
            return Err(PipelineError::Finalized);
        }
        create_dir(&paths.docs)?;
        create_dir(&paths.receipts)?;
        let previous: Option<MatchResult> = read_stored_lenient(&paths.dir, &paths.match_result());
        if clear_cache {
            let report = reset_period(&paths, &rules)?;
            // A finalized period's decisions now hold the paths its receipts moved back to.
            if report.finalized.is_some() {
                return Ok(report.finalized);
            }
        }
        Ok::<_, PipelineError>(previous)
    })
    .await??;

    let transactions: Vec<StatementTransaction> = if statements.is_empty() {
        (ctx.progress)(RunEvent::Parsing { count: 0 });
        let path = ctx.paths.transactions();
        off_thread(move || read_json_opt(&path))
            .await??
            .ok_or_else(|| {
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
        let records = statement_records(statements, &normalized.counts);
        let paths = ctx.paths.clone();
        let transactions = normalized.transactions;
        off_thread(move || {
            write_json(&paths.transactions(), &transactions)?;
            write_json(&paths.statements(), &records)?;
            Ok::<_, FsError>(transactions)
        })
        .await??
    };

    let (receipt_count, result) =
        extract_and_match(ctx, transactions, previous, clear_cache).await?;
    let reimbursements = extract_reimbursements(ctx, clear_cache).await?;
    ctx.check_cancelled()?;

    (ctx.progress)(RunEvent::Exporting);
    let language = ctx.language;
    let reasons = ctx.reasons.clone();
    let report = ctx.paths.report();
    off_thread(move || {
        write_report(&result, &reimbursements, language, &reasons, &report)?;
        Ok::<_, PipelineError>(summary(&result, receipt_count))
    })
    .await?
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
    let paths = ctx.paths.clone();
    let (transactions, known, matched_before) = off_thread(move || {
        recover(&paths)?;
        let transactions: Vec<StatementTransaction> =
            read_json_opt(&paths.transactions())?.ok_or_else(PipelineError::not_reconciled)?;
        if paths.applied_marker().exists() {
            return Err(PipelineError::Finalized);
        }
        let known: HashSet<String> = read_cache(&paths.dir, &paths.receipts_cache())
            .into_iter()
            .map(|r| r.file)
            .collect();
        let matched_before = matched_ids(&paths);
        create_dir(&paths.receipts)?;
        Ok((transactions, known, matched_before))
    })
    .await??;
    let receipts = extract_receipts(ctx, false).await?;
    (ctx.progress)(RunEvent::Matching);
    let (receipts, result) = match_and_store(ctx, transactions, receipts).await?;
    extract_reimbursements(ctx, false).await?;
    let paths = ctx.paths.clone();
    off_thread(move || {
        let dropped_decisions = clean_saved_draft(&paths, &receipts, &result);
        let new_receipts = receipts.iter().filter(|r| !known.contains(&r.file)).count();
        let newly_matched = result
            .transactions
            .iter()
            .filter(|tx| tx.status == Status::Matched && !matched_before.contains(&tx.id))
            .count();
        ScanOutcome {
            summary: summary(&result, receipts.len()),
            dropped_decisions,
            new_receipts,
            newly_matched,
        }
    })
    .await
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
    let paths = ctx.paths.clone();
    let existing: Vec<StatementTransaction> = off_thread(move || {
        recover(&paths)?;
        if paths.applied_marker().exists() {
            return Err(PipelineError::Finalized);
        }
        read_json_opt(&paths.transactions())?.ok_or_else(PipelineError::not_reconciled)
    })
    .await??;
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
    let new_ids: HashSet<String> = transactions[existing_count..]
        .iter()
        .map(|tx| tx.id.clone())
        .collect();
    ctx.check_cancelled()?;

    // Only caches are written until the last cancellation point, so a cancelled run leaves
    // the period as it was.
    let receipts_dir = ctx.paths.receipts.clone();
    off_thread(move || create_dir(&receipts_dir)).await??;
    let receipts = extract_receipts(ctx, false).await?;
    (ctx.progress)(RunEvent::Matching);
    let (paths, rules) = (ctx.paths.clone(), ctx.rules.clone());
    let (transactions, receipts, result) = off_thread(move || {
        let result = match_keeping_draft(&paths, &transactions, &receipts, &rules);
        (transactions, receipts, result)
    })
    .await?;
    extract_reimbursements(ctx, false).await?;
    ctx.check_cancelled()?;

    let added_counts: Vec<usize> = appended.counts.iter().map(|c| c.added).collect();
    let new_records = statement_records(statements, &added_counts);
    let paths = ctx.paths.clone();
    let (receipts, result, dropped_decisions) = off_thread(move || {
        write_json(&paths.transactions(), &transactions)?;
        write_stored(&paths.dir, &paths.match_result(), &result)?;
        let mut records = read_statements(&paths);
        records.extend(new_records);
        write_json(&paths.statements(), &records)?;
        let dropped_decisions = clean_saved_draft(&paths, &receipts, &result);
        Ok::<_, FsError>((receipts, result, dropped_decisions))
    })
    .await??;

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

/// Writes extraction results to the cache file while a run goes on. Each save holds the
/// receipts read so far plus the earlier cache entries of files still waiting, so a run that
/// stops keeps what it read.
struct CacheWriter {
    path: PathBuf,
    /// The period folder, which the saved paths are relative to.
    dir: PathBuf,
    entries: Mutex<CacheEntries>,
    /// The number of the newest snapshot written; older snapshots that finish later are
    /// dropped.
    written: Arc<Mutex<u64>>,
}

struct CacheEntries {
    entries: Vec<Option<ReceiptMeta>>,
    unsaved: usize,
    saved_at: Instant,
    snapshot: u64,
}

impl CacheWriter {
    fn new(path: PathBuf, dir: PathBuf, files: &[String], previous: &[ReceiptMeta]) -> CacheWriter {
        let entries = files
            .iter()
            .map(|file| previous.iter().find(|r| &r.file == file).cloned())
            .collect();
        CacheWriter {
            path,
            dir,
            entries: Mutex::new(CacheEntries {
                entries,
                unsaved: 0,
                saved_at: Instant::now(),
                snapshot: 0,
            }),
            written: Arc::new(Mutex::new(0)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheEntries> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Records a receipt just read, and saves when enough are waiting or enough time passed.
    fn record(&self, index: usize, meta: &ReceiptMeta) {
        let mut state = self.lock();
        if let Some(slot) = state.entries.get_mut(index) {
            *slot = Some(meta.clone());
        }
        state.unsaved += 1;
        let due =
            state.unsaved >= CACHE_SAVE_EVERY || state.saved_at.elapsed() >= CACHE_SAVE_INTERVAL;
        if due {
            let (snapshot, entries) = Self::take_snapshot(&mut state);
            drop(state);
            let task = self.save(snapshot, entries);
            tokio::task::spawn_blocking(move || {
                if let Err(error) = task() {
                    log::warn!("could not save the extraction cache: {error}");
                }
            });
        }
    }

    fn take_snapshot(state: &mut CacheEntries) -> (u64, Vec<ReceiptMeta>) {
        state.unsaved = 0;
        state.saved_at = Instant::now();
        state.snapshot += 1;
        (
            state.snapshot,
            state.entries.iter().flatten().cloned().collect(),
        )
    }

    /// A save of `entries` as snapshot number `snapshot`, skipped when a newer one is written.
    fn save(
        &self,
        snapshot: u64,
        entries: Vec<ReceiptMeta>,
    ) -> impl FnOnce() -> Result<(), FsError> + Send + 'static {
        let path = self.path.clone();
        let dir = self.dir.clone();
        let written = Arc::clone(&self.written);
        move || {
            let mut newest = written.lock().unwrap_or_else(|p| p.into_inner());
            if snapshot <= *newest {
                return Ok(());
            }
            write_stored(&dir, &path, &entries)?;
            *newest = snapshot;
            Ok(())
        }
    }

    /// Saves `entries` as the final cache, after every snapshot taken so far.
    async fn finish(&self, entries: Vec<ReceiptMeta>) -> Result<(), PipelineError> {
        let snapshot = {
            let mut state = self.lock();
            state.snapshot += 1;
            state.snapshot
        };
        let task = self.save(snapshot, entries);
        Ok(off_thread(task).await??)
    }

    /// Saves what was read so far, for a run that stops early.
    async fn flush(&self) {
        let (snapshot, entries) = Self::take_snapshot(&mut self.lock());
        let task = self.save(snapshot, entries);
        match off_thread(task).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!("could not save the extraction cache: {error}"),
            Err(error) => log::warn!("could not save the extraction cache: {error}"),
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
    let (cache, identities) = {
        let path = cache_path.to_path_buf();
        let dir = ctx.paths.dir.clone();
        let listed = files.to_vec();
        off_thread(move || {
            let identities: Vec<Option<FileIdentity>> = listed
                .iter()
                .map(|file| FileIdentity::of(Path::new(file)))
                .collect();
            let cache = if force {
                Vec::new()
            } else {
                unchanged(read_cache(&dir, &path), &listed, &identities)
            };
            (cache, identities)
        })
        .await?
    };
    let stamped = |index: usize, meta: &ReceiptMeta| ReceiptMeta {
        identity: identities.get(index).copied().flatten(),
        ..meta.clone()
    };
    let writer = CacheWriter::new(
        cache_path.to_path_buf(),
        ctx.paths.dir.clone(),
        files,
        &cache,
    );
    let progress = |progress: ExtractProgress<'_>| {
        if let Some((index, meta)) = progress.extracted {
            writer.record(index, &stamped(index, meta));
        }
        (ctx.progress)(event(progress.done, total));
    };
    let outcome = extract_all_observed(
        files,
        &cache,
        force,
        ctx.extractor,
        &ctx.options,
        &progress,
        &ctx.cancel,
    )
    .await;
    match outcome {
        Ok(receipts) => {
            let receipts: Vec<ReceiptMeta> = receipts
                .iter()
                .enumerate()
                .map(|(index, meta)| stamped(index, meta))
                .collect();
            writer.finish(receipts.clone()).await?;
            Ok(receipts)
        }
        Err(error) => {
            writer.flush().await;
            Err(error.into())
        }
    }
}

/// The entries of `cache` for files in `files` whose identity has not changed since they were
/// read. An entry without an identity, or for a file that cannot be read, is left out, so the
/// file is read again.
fn unchanged(
    cache: Vec<ReceiptMeta>,
    files: &[String],
    identities: &[Option<FileIdentity>],
) -> Vec<ReceiptMeta> {
    let current: HashMap<&str, FileIdentity> = files
        .iter()
        .zip(identities)
        .filter_map(|(file, identity)| identity.map(|identity| (file.as_str(), identity)))
        .collect();
    cache
        .into_iter()
        .filter(|meta| {
            meta.identity
                .is_some_and(|identity| current.get(meta.file.as_str()) == Some(&identity))
        })
        .collect()
}

/// Extracts the receipts in the period's `receipts/` folder, through the cache. Files refused
/// before reading stay in the cache, where the review lists them, and are not returned.
async fn extract_receipts(
    ctx: &RunContext<'_>,
    force: bool,
) -> Result<Vec<ReceiptMeta>, PipelineError> {
    let dir = ctx.paths.receipts.clone();
    let files = off_thread(move || walk(&dir)).await?;
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
    Ok(readable(receipts))
}

/// Matches the receipts against the transactions, keeping draft decisions, and writes
/// `match-result.json`. Returns the receipts with the result.
async fn match_and_store(
    ctx: &RunContext<'_>,
    transactions: Vec<StatementTransaction>,
    receipts: Vec<ReceiptMeta>,
) -> Result<(Vec<ReceiptMeta>, MatchResult), PipelineError> {
    let (paths, rules) = (ctx.paths.clone(), ctx.rules.clone());
    off_thread(move || {
        let result = match_keeping_draft(&paths, &transactions, &receipts, &rules);
        write_stored(&paths.dir, &paths.match_result(), &result)?;
        Ok::<_, FsError>((receipts, result))
    })
    .await?
    .map_err(PipelineError::from)
}

/// Extracts the period's receipts, matches them and writes `match-result.json`. A receipt that
/// the saved draft claims through the `previous` result goes to no other transaction. Returns
/// the number of receipts and the result.
async fn extract_and_match(
    ctx: &RunContext<'_>,
    transactions: Vec<StatementTransaction>,
    previous: Option<MatchResult>,
    force: bool,
) -> Result<(usize, MatchResult), PipelineError> {
    let receipts = extract_receipts(ctx, force).await?;
    (ctx.progress)(RunEvent::Matching);
    let paths = ctx.paths.clone();
    let rules: Vec<Rule> = ctx.rules.clone();
    off_thread(move || {
        let draft: Draft = read_stored_lenient(&paths.dir, &paths.draft()).unwrap_or_default();
        let result = match_with_draft(previous.as_ref(), &draft, &transactions, &receipts, &rules);
        write_stored(&paths.dir, &paths.match_result(), &result)?;
        Ok::<_, FsError>((receipts.len(), result))
    })
    .await?
    .map_err(PipelineError::from)
}

/// Extracts the receipts in `reimbursements/`, which no transaction matches. Refused files
/// are not returned.
async fn extract_reimbursements(
    ctx: &RunContext<'_>,
    force: bool,
) -> Result<Vec<ReceiptMeta>, PipelineError> {
    let dir = ctx.paths.reimbursements.clone();
    let files = off_thread(move || walk(&dir)).await?;
    (ctx.progress)(RunEvent::ReimbursementsFound { count: files.len() });
    let cache_path = ctx.paths.reimbursements_cache();
    if files.is_empty() {
        // An emptied folder must not leave stale entries behind.
        off_thread(move || {
            if cache_path.exists() {
                write_json(&cache_path, &Vec::<ReceiptMeta>::new())?;
            }
            Ok::<_, FsError>(())
        })
        .await??;
        return Ok(Vec::new());
    }
    let reimbursements = extract_to_cache(ctx, &files, &cache_path, force, |current, total| {
        RunEvent::ExtractingReimbursements { current, total }
    })
    .await?;
    Ok(readable(reimbursements))
}

fn no_bank_match() -> PipelineError {
    PipelineError::coded(
        ErrorKind::Parse,
        "no_bank_match",
        "no transactions found in the statements; check the bank selected for each file",
    )
}

/// Checks that every statement is an existing PDF of at most 50 MB, then reads each one with its bank's
/// parser.
async fn parse_statements(
    ctx: &RunContext<'_>,
    statements: &[StatementFile],
) -> Result<Vec<Vec<RawTransaction>>, PipelineError> {
    (ctx.progress)(RunEvent::Parsing {
        count: statements.len(),
    });
    for statement in statements {
        if !is_pdf(&statement.path) || !statement.path.is_file() {
            return Err(not_pdf(&statement.path));
        }
        check_statement(&statement.path).await?;
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
