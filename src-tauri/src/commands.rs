//! Tauri commands used by the windows. They check their input, take the period's locks and
//! hand the work to `pipeline`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use crate::app::{AppState, AppStateView, SETTINGS_CHANGED_EVENT};
use crate::bank::Bank;
use crate::config::Settings;
use crate::error::{fail, CommandError, CommandResult, ErrorKind};
use crate::extract::{ExtractOptions, GeminiExtractor};
use crate::locks::{ExclusiveGuard, RunKind};
use crate::model::{Draft, DroppedDecision, Rule, Summary};
use crate::period::{Period, PeriodPaths};
use crate::pipeline::{self, RescanKind, RunContext, RunEvent, StatementFile};
use crate::poppler::PopplerStatus;
use crate::updates::{UpdateInfo, UpdateManager, UPDATE_PROGRESS_EVENT};
use crate::windows;

/// A reconcile or scan stops after this long.
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn period(year: &str, month: &str) -> CommandResult<Period> {
    Period::parse(year, month).map_err(fail)
}

fn changed(app: &AppHandle, view: AppStateView) -> AppStateView {
    let _ = app.emit(SETTINGS_CHANGED_EVENT, &view);
    view
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| fail(CommandError::internal(e)))
}

#[tauri::command]
pub fn get_app_state(state: State<'_, Arc<AppState>>) -> AppStateView {
    state.view()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> CommandResult<AppStateView> {
    let view = state.save_settings(settings).map_err(fail)?;
    Ok(changed(&app, view))
}

/// Asks for the receipts folder. Returns its path, or none when the dialog was cancelled.
#[tauri::command]
pub async fn pick_receipts_root(app: AppHandle) -> CommandResult<Option<String>> {
    let picked = blocking(move || app.dialog().file().blocking_pick_folder()).await?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Asks for a service account key file and stores it in the credential store. Returns none
/// when the dialog was cancelled.
#[tauri::command]
pub async fn import_service_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<AppStateView>> {
    let dialog_app = app.clone();
    let picked = blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
    })
    .await?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let json = std::fs::read_to_string(&path).map_err(|e| {
        fail(CommandError::new(
            ErrorKind::InvalidInput,
            format!("{}: {e}", path.display()),
        ))
    })?;
    let view = state.import_service_account(&json).map_err(fail)?;
    Ok(Some(changed(&app, view)))
}

#[tauri::command]
pub fn remove_service_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<AppStateView> {
    let view = state.remove_service_account().map_err(fail)?;
    Ok(changed(&app, view))
}

/// Fetches a Google access token with the stored key, to check the setup.
#[tauri::command]
pub async fn test_gemini_connection(state: State<'_, Arc<AppState>>) -> CommandResult<()> {
    let client = state.gemini().map_err(fail)?;
    client.check().await.map_err(fail)
}

#[tauri::command]
pub async fn poppler_status(state: State<'_, Arc<AppState>>) -> CommandResult<PopplerStatus> {
    let poppler = state.poppler.clone();
    blocking(move || poppler.status()).await?.map_err(fail)
}

#[tauri::command]
pub fn get_rules(state: State<'_, Arc<AppState>>) -> Vec<Rule> {
    state.rules()
}

#[tauri::command]
pub fn save_rules(state: State<'_, Arc<AppState>>, rules: Vec<Rule>) -> CommandResult<Vec<Rule>> {
    state.save_rules(rules).map_err(fail)
}

#[tauri::command]
pub fn period_status(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<pipeline::PeriodStatus> {
    let paths = state.period_paths(&period(&year, &month)?).map_err(fail)?;
    Ok(pipeline::period_status(&paths))
}

/// Asks for bank statement PDFs. Returns their paths; empty when the dialog was cancelled.
#[tauri::command]
pub async fn pick_statements(app: AppHandle) -> CommandResult<Vec<String>> {
    let picked = blocking(move || {
        app.dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .blocking_pick_files()
    })
    .await?;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct StatementInput {
    pub path: String,
    pub bank: String,
}

/// What a reconcile or scan holds while it runs: the period's exclusive lock and the
/// extractor built from the current setup.
struct Job {
    guard: ExclusiveGuard,
    extractor: GeminiExtractor,
    paths: PeriodPaths,
}

fn start_job(state: &AppState, period: &Period, kind: RunKind) -> CommandResult<Job> {
    let paths = state.period_paths(period)?;
    let client = state.gemini()?;
    let guard = state.locks.try_exclusive(period, kind)?;
    Ok(Job {
        guard,
        extractor: GeminiExtractor {
            client,
            poppler: state.poppler.clone(),
        },
        paths,
    })
}

/// Sends progress to the window. A window that went away cannot show the result, so the run
/// stops.
fn progress_sender(
    channel: Channel<RunEvent>,
    cancel: CancellationToken,
) -> impl Fn(RunEvent) + Send + Sync {
    move |event| {
        if channel.send(event).is_err() {
            cancel.cancel();
        }
    }
}

fn timed_out<T>(
    result: Result<Result<T, pipeline::PipelineError>, tokio::time::error::Elapsed>,
) -> CommandResult<T> {
    match result {
        Ok(outcome) => outcome.map_err(CommandError::from),
        Err(_) => Err(CommandError::new(
            ErrorKind::Timeout,
            "the run took longer than 30 minutes",
        )),
    }
}

#[tauri::command]
pub async fn reconcile(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    statements: Vec<StatementInput>,
    clear_cache: bool,
    on_event: Channel<RunEvent>,
) -> CommandResult<Summary> {
    let period = period(&year, &month)?;
    let files = statements
        .into_iter()
        .map(|s| {
            Ok(StatementFile {
                path: PathBuf::from(s.path),
                bank: s.bank.parse::<Bank>()?,
            })
        })
        .collect::<CommandResult<Vec<_>>>()
        .map_err(fail)?;
    let job = start_job(&state, &period, RunKind::Reconcile).map_err(fail)?;
    let token = job.guard.token().clone();
    let progress = progress_sender(on_event, token.clone());
    let ctx = RunContext {
        paths: job.paths.clone(),
        extractor: &job.extractor,
        statements: &state.poppler,
        rules: state.rules(),
        language: state.settings().report_language(),
        options: ExtractOptions::default(),
        progress: &progress,
        cancel: token,
    };
    let result =
        tokio::time::timeout(RUN_TIMEOUT, pipeline::reconcile(&ctx, &files, clear_cache)).await;
    drop(job);
    timed_out(result).map_err(fail)
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub summary: Summary,
    pub dropped_decisions: Vec<DroppedDecision>,
}

#[tauri::command]
pub async fn scan_receipts(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    on_event: Channel<RunEvent>,
) -> CommandResult<ScanResult> {
    let period = period(&year, &month)?;
    let job = start_job(&state, &period, RunKind::Scan).map_err(fail)?;
    let token = job.guard.token().clone();
    let progress = progress_sender(on_event, token.clone());
    let ctx = RunContext {
        paths: job.paths.clone(),
        extractor: &job.extractor,
        statements: &state.poppler,
        rules: state.rules(),
        language: state.settings().report_language(),
        options: ExtractOptions::default(),
        progress: &progress,
        cancel: token,
    };
    let result = tokio::time::timeout(RUN_TIMEOUT, pipeline::scan_receipts(&ctx)).await;
    drop(job);
    let (summary, dropped_decisions) = timed_out(result).map_err(fail)?;
    Ok(ScanResult {
        summary,
        dropped_decisions,
    })
}

/// Stops the period's running job. Returns whether one was running.
#[tauri::command]
pub fn cancel_run(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<bool> {
    Ok(state.locks.cancel(&period(&year, &month)?))
}

#[tauri::command]
pub fn get_review(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<Value> {
    let paths = state.period_paths(&period(&year, &month)?).map_err(fail)?;
    pipeline::review_data(&paths).map_err(fail)
}

#[tauri::command]
pub fn get_draft(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<Draft> {
    let paths = state.period_paths(&period(&year, &month)?).map_err(fail)?;
    pipeline::read_draft(&paths).map_err(fail)
}

fn ensure_not_finalizing(state: &AppState, period: &Period) -> CommandResult<()> {
    if state.locks.running(period) == Some(RunKind::Finalize) {
        return Err(fail(CommandError::new(
            ErrorKind::Busy,
            "the period is being finalized",
        )));
    }
    Ok(())
}

#[tauri::command]
pub fn save_draft(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    draft: Draft,
) -> CommandResult<()> {
    let period = period(&year, &month)?;
    ensure_not_finalizing(&state, &period)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    pipeline::save_draft(&paths, &draft).map_err(fail)
}

#[tauri::command]
pub fn delete_draft(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<()> {
    let period = period(&year, &month)?;
    ensure_not_finalizing(&state, &period)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    pipeline::delete_draft(&paths).map_err(fail)
}

#[tauri::command]
pub async fn finalize(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<()> {
    let period = period(&year, &month)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    let guard = state
        .locks
        .try_exclusive(&period, RunKind::Finalize)
        .map_err(fail)?;
    let language = state.settings().report_language();
    let result = blocking(move || pipeline::finalize(&paths, language)).await?;
    drop(guard);
    result.map_err(fail)
}

async fn rescan(
    state: &AppState,
    year: &str,
    month: &str,
    kind: RescanKind,
    rel_path: &str,
) -> CommandResult<Value> {
    let period = period(year, month)?;
    let paths = state.period_paths(&period)?;
    let file = pipeline::resolve_period_file(&paths, kind, rel_path)?;
    let client = state.gemini()?;
    let _guard = state.locks.try_rescan(&period, file.canonical.clone())?;
    let extractor = GeminiExtractor {
        client,
        poppler: state.poppler.clone(),
    };
    let write_lock = state.locks.write_lock(&period);
    let meta = pipeline::rescan(&paths, &extractor, kind, &file, &write_lock).await?;
    let mut value = serde_json::to_value(&meta).map_err(CommandError::internal)?;
    value["rel_path"] = paths
        .relative(&meta.file)
        .map_or(Value::Null, Value::String);
    Ok(value)
}

#[tauri::command]
pub async fn rescan_receipt(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    rel_path: String,
) -> CommandResult<Value> {
    rescan(&state, &year, &month, RescanKind::Receipt, &rel_path)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn rescan_reimbursement(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    rel_path: String,
) -> CommandResult<Value> {
    rescan(&state, &year, &month, RescanKind::Reimbursement, &rel_path)
        .await
        .map_err(fail)
}

/// Writes the report with pending decisions applied and returns its path.
async fn write_report(state: &AppState, period: &Period) -> CommandResult<PathBuf> {
    let paths = state.period_paths(period)?;
    let guard = state.locks.try_exclusive(period, RunKind::Report)?;
    let language = state.settings().report_language();
    let result = blocking(move || pipeline::export_report(&paths, language)).await?;
    drop(guard);
    Ok(result?)
}

/// Saves the report where the user chooses. Returns the saved path, or none when the dialog
/// was cancelled.
#[tauri::command]
pub async fn export_report(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<Option<String>> {
    let period = period(&year, &month)?;
    let report = write_report(&state, &period).await.map_err(fail)?;
    let name = format!("{year}-{month}.xlsx");
    let target = blocking(move || {
        app.dialog()
            .file()
            .add_filter("Excel", &["xlsx"])
            .set_file_name(name)
            .blocking_save_file()
    })
    .await?;
    let Some(target) = target.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::copy(&report, &target).map_err(|e| {
        fail(CommandError::new(
            ErrorKind::Io,
            format!("{}: {e}", target.display()),
        ))
    })?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

fn open(app: &AppHandle, path: &Path) -> CommandResult<()> {
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| fail(CommandError::new(ErrorKind::Io, e.to_string())))
}

/// Opens the report in the default spreadsheet app.
#[tauri::command]
pub async fn open_report(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<()> {
    let report = write_report(&state, &period(&year, &month)?)
        .await
        .map_err(fail)?;
    open(&app, &report)
}

/// Opens a receipt or reimbursement file in its default app.
#[tauri::command]
pub fn open_receipt(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    rel_path: String,
) -> CommandResult<()> {
    let paths = state.period_paths(&period(&year, &month)?).map_err(fail)?;
    let file = pipeline::resolve_period_file(&paths, RescanKind::Receipt, &rel_path)
        .or_else(|_| pipeline::resolve_period_file(&paths, RescanKind::Reimbursement, &rel_path))
        .map_err(fail)?;
    open(&app, &file.canonical)
}

/// Shows the period's folder in the file manager.
#[tauri::command]
pub fn reveal_period(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<()> {
    let paths = state.period_paths(&period(&year, &month)?).map_err(fail)?;
    if !paths.dir.is_dir() {
        return Err(fail(CommandError::new(
            ErrorKind::NotFound,
            "the period folder does not exist yet",
        )));
    }
    app.opener()
        .reveal_item_in_dir(&paths.dir)
        .map_err(|e| fail(CommandError::new(ErrorKind::Io, e.to_string())))
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    windows::open_settings(&app);
}

#[tauri::command]
pub async fn check_for_updates(
    updates: State<'_, Arc<UpdateManager>>,
) -> CommandResult<Option<UpdateInfo>> {
    updates.check_now().await.map_err(fail)
}

#[tauri::command]
pub fn pending_update(updates: State<'_, Arc<UpdateManager>>) -> Option<UpdateInfo> {
    updates.pending()
}

/// Downloads and installs the pending update, emitting `update-progress` along the way, then
/// relaunches the app.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    updates: State<'_, Arc<UpdateManager>>,
) -> CommandResult<()> {
    let emitter = app.clone();
    let progress = move |progress| {
        let _ = emitter.emit(UPDATE_PROGRESS_EVENT, progress);
    };
    updates.install(&progress).await.map_err(fail)?;
    log::info!("update installed, relaunching");
    app.request_restart();
    Ok(())
}
