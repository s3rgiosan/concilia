//! Tauri commands used by the windows. They check their input, take the period's locks and
//! hand the work to `pipeline`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde::Deserialize;
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
use crate::model::{Draft, Rule, Summary};
use crate::period::{Period, PeriodPaths};
use crate::pipeline::{
    self, AddStatementsResult, PipelineError, ReceiptView, RescanKind, ReviewData, RunContext,
    RunEvent, StatementFile,
};
use crate::poppler::PopplerStatus;
use crate::updates::{UpdateInfo, UpdateManager, UPDATE_PROGRESS_EVENT};
use crate::windows;

/// A reconcile or scan stops after this long.
const RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn period(year: &str, month: &str) -> CommandResult<Period> {
    Ok(Period::parse(year, month)?)
}

fn receipts_root(state: &AppState) -> CommandResult<PathBuf> {
    state.receipts_root().ok_or_else(|| {
        CommandError::new(
            ErrorKind::NotConfigured,
            "choose the receipts folder in Settings",
        )
    })
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
        .map_err(CommandError::internal)
}

/// The shared state, owned, for work moved off the command's thread.
fn shared(state: &State<'_, Arc<AppState>>) -> Arc<AppState> {
    Arc::clone(state.inner())
}

/// Reads the setup off the main thread: the first read may wait on the Keychain.
#[tauri::command]
pub async fn get_app_state(state: State<'_, Arc<AppState>>) -> CommandResult<AppStateView> {
    let state = shared(&state);
    blocking(move || state.view()).await.map_err(fail)
}

/// Saves the settings. A new receipts folder must come from `pick_receipts_root`.
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> CommandResult<AppStateView> {
    let state = shared(&state);
    let view = blocking(move || state.save_settings(settings))
        .await
        .and_then(|result| result)
        .map_err(fail)?;
    Ok(changed(&app, view))
}

/// Asks for the receipts folder. Returns its path, or none when the dialog was cancelled.
/// The folder picked may then be saved in the settings.
#[tauri::command]
pub async fn pick_receipts_root(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<String>> {
    let picked = blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(fail)?;
    let Some(folder) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    state.grant_paths([folder.clone()]);
    Ok(Some(folder.to_string_lossy().into_owned()))
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
    .await
    .map_err(fail)?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let state = shared(&state);
    let view = blocking(move || {
        let json = std::fs::read_to_string(&path).map_err(|e| {
            CommandError::new(ErrorKind::InvalidInput, format!("{}: {e}", path.display()))
        })?;
        state.import_service_account(&json)
    })
    .await
    .and_then(|result| result)
    .map_err(fail)?;
    Ok(Some(changed(&app, view)))
}

#[tauri::command]
pub async fn remove_service_account(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<AppStateView> {
    let state = shared(&state);
    let view = blocking(move || state.remove_service_account())
        .await
        .and_then(|result| result)
        .map_err(fail)?;
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
    blocking(move || poppler.status())
        .await
        .map_err(fail)?
        .map_err(fail)
}

#[tauri::command]
pub fn get_rules(state: State<'_, Arc<AppState>>) -> Vec<Rule> {
    state.rules()
}

#[tauri::command]
pub async fn save_rules(
    state: State<'_, Arc<AppState>>,
    rules: Vec<Rule>,
) -> CommandResult<Vec<Rule>> {
    let state = shared(&state);
    blocking(move || state.save_rules(rules))
        .await
        .and_then(|result| result)
        .map_err(fail)
}

#[tauri::command]
pub async fn period_status(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<pipeline::PeriodStatus> {
    let period = period(&year, &month).map_err(fail)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    blocking(move || pipeline::period_status(&paths))
        .await
        .map_err(fail)
}

/// The month folders under the receipts root, newest first.
#[tauri::command]
pub async fn list_periods(
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Vec<pipeline::PeriodSummary>> {
    let root = receipts_root(&state).map_err(fail)?;
    blocking(move || pipeline::list_periods(&root))
        .await
        .map_err(fail)
}

/// One month's entry for the month list.
#[tauri::command]
pub async fn period_summary(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<pipeline::PeriodSummary> {
    let period = period(&year, &month).map_err(fail)?;
    let root = receipts_root(&state).map_err(fail)?;
    blocking(move || pipeline::period_summary(&root, &period))
        .await
        .map_err(fail)
}

/// Asks for bank statement PDFs. Returns their paths; empty when the dialog was cancelled.
/// The files picked may then be reconciled or added.
#[tauri::command]
pub async fn pick_statements(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Vec<String>> {
    let picked = blocking(move || {
        app.dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .blocking_pick_files()
    })
    .await
    .map_err(fail)?;
    let files: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect();
    state.grant_paths(files.iter().cloned());
    Ok(files
        .iter()
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

/// The statements to read, each one a file the user picked or dropped.
fn statement_files(
    state: &AppState,
    statements: Vec<StatementInput>,
) -> CommandResult<Vec<StatementFile>> {
    let files = statements
        .into_iter()
        .map(|s| {
            Ok(StatementFile {
                path: PathBuf::from(s.path),
                bank: s.bank.parse::<Bank>()?,
            })
        })
        .collect::<CommandResult<Vec<_>>>()?;
    state.ensure_granted(files.iter().map(|f| f.path.as_path()))?;
    Ok(files)
}

/// Runs `run` as the period's exclusive job of `kind`: takes the lock, builds the context from
/// the current setup, forwards progress to `on_event` and stops after `RUN_TIMEOUT`.
async fn run_job<T>(
    state: &AppState,
    period: &Period,
    kind: RunKind,
    on_event: Channel<RunEvent>,
    run: impl for<'a, 'b> FnOnce(&'a RunContext<'b>) -> BoxFuture<'a, Result<T, PipelineError>>,
) -> CommandResult<T> {
    let Job {
        guard,
        extractor,
        paths,
    } = start_job(state, period, kind)?;
    let token = guard.token().clone();
    let progress = progress_sender(on_event, token.clone());
    let ctx = RunContext {
        paths,
        extractor: &extractor,
        statements: &state.poppler,
        rules: state.rules(),
        language: state.settings().report_language(),
        options: ExtractOptions::default(),
        progress: &progress,
        cancel: token,
    };
    let result = tokio::time::timeout(RUN_TIMEOUT, run(&ctx)).await;
    drop(guard);
    timed_out(result)
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
    let period = period(&year, &month).map_err(fail)?;
    let files = statement_files(&state, statements).map_err(fail)?;
    run_job(&state, &period, RunKind::Reconcile, on_event, |ctx| {
        Box::pin(async move { pipeline::reconcile(ctx, &files, clear_cache).await })
    })
    .await
    .map_err(fail)
}

#[tauri::command]
pub async fn scan_receipts(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    on_event: Channel<RunEvent>,
) -> CommandResult<pipeline::ScanOutcome> {
    let period = period(&year, &month).map_err(fail)?;
    run_job(&state, &period, RunKind::Scan, on_event, |ctx| {
        Box::pin(pipeline::scan_receipts(ctx))
    })
    .await
    .map_err(fail)
}

/// Adds statements to a month in review, keeping its transaction IDs and review draft.
#[tauri::command]
pub async fn add_statements(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    statements: Vec<StatementInput>,
    on_event: Channel<RunEvent>,
) -> CommandResult<AddStatementsResult> {
    let period = period(&year, &month).map_err(fail)?;
    let files = statement_files(&state, statements).map_err(fail)?;
    run_job(&state, &period, RunKind::AddStatements, on_event, |ctx| {
        Box::pin(async move { pipeline::add_statements(ctx, &files).await })
    })
    .await
    .map_err(fail)
}

/// Stops the period's running job. Returns whether one was running.
#[tauri::command]
pub fn cancel_run(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<bool> {
    let period = period(&year, &month).map_err(fail)?;
    Ok(state.locks.cancel(&period))
}

#[tauri::command]
pub async fn get_review(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<ReviewData> {
    let period = period(&year, &month).map_err(fail)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    blocking(move || pipeline::review_data(&paths))
        .await
        .map_err(fail)?
        .map_err(fail)
}

#[tauri::command]
pub async fn get_draft(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<Draft> {
    let period = period(&year, &month).map_err(fail)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    blocking(move || pipeline::read_draft(&paths))
        .await
        .map_err(fail)?
        .map_err(fail)
}

fn ensure_not_finalizing(state: &AppState, period: &Period) -> CommandResult<()> {
    let running = state.locks.running(period);
    if running == Some(RunKind::Finalize) {
        return Err(CommandError::new(
            ErrorKind::Busy,
            "the period is being finalized",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    draft: Draft,
) -> CommandResult<()> {
    let period = period(&year, &month).map_err(fail)?;
    ensure_not_finalizing(&state, &period).map_err(fail)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    blocking(move || pipeline::save_draft(&paths, &draft))
        .await
        .map_err(fail)?
        .map_err(fail)
}

#[tauri::command]
pub async fn finalize(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<()> {
    let period = period(&year, &month).map_err(fail)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    let guard = state
        .locks
        .try_exclusive(&period, RunKind::Finalize)
        .map_err(fail)?;
    let language = state.settings().report_language();
    let result = blocking(move || pipeline::finalize(&paths, language))
        .await
        .map_err(fail)?;
    drop(guard);
    result.map_err(fail)
}

async fn rescan(
    state: &AppState,
    year: &str,
    month: &str,
    kind: RescanKind,
    rel_path: &str,
) -> CommandResult<ReceiptView> {
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
    Ok(ReceiptView::new(&paths, meta))
}

#[tauri::command]
pub async fn rescan_receipt(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    rel_path: String,
) -> CommandResult<ReceiptView> {
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
) -> CommandResult<ReceiptView> {
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
    let period = period(&year, &month).map_err(fail)?;
    let report = write_report(&state, &period).await.map_err(fail)?;
    let name = format!("{year}-{month}.xlsx");
    let target = blocking(move || {
        app.dialog()
            .file()
            .add_filter("Excel", &["xlsx"])
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(fail)?;
    let Some(target) = target.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let saved = target.to_string_lossy().into_owned();
    blocking(move || {
        std::fs::copy(&report, &target)
            .map(|_| ())
            .map_err(|e| CommandError::new(ErrorKind::Io, format!("{}: {e}", target.display())))
    })
    .await
    .and_then(|result| result)
    .map_err(fail)?;
    Ok(Some(saved))
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
    let period = period(&year, &month).map_err(fail)?;
    let report = write_report(&state, &period).await.map_err(fail)?;
    open(&app, &report)
}

/// Opens a receipt or reimbursement file in its default app, by its checked real path.
#[tauri::command]
pub async fn open_receipt(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
    rel_path: String,
) -> CommandResult<()> {
    let period = period(&year, &month).map_err(fail)?;
    let paths = state.period_paths(&period).map_err(fail)?;
    blocking(move || {
        let file = pipeline::resolve_period_file(&paths, RescanKind::Receipt, &rel_path)
            .or_else(|_| {
                pipeline::resolve_period_file(&paths, RescanKind::Reimbursement, &rel_path)
            })
            .map_err(fail)?;
        open(&app, &file.canonical)
    })
    .await
    .map_err(fail)?
}

/// Creates a month's folders and returns its entry for the month list.
#[tauri::command]
pub async fn create_period(
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<pipeline::PeriodSummary> {
    let period = period(&year, &month).map_err(fail)?;
    let root = receipts_root(&state).map_err(fail)?;
    blocking(move || {
        pipeline::ensure_period_dirs(&root, &period)?;
        Ok::<_, PipelineError>(pipeline::period_summary(&root, &period))
    })
    .await
    .map_err(fail)?
    .map_err(fail)
}

/// Shows the period's folder in the file manager, creating it first when it is missing.
#[tauri::command]
pub async fn reveal_period(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    year: String,
    month: String,
) -> CommandResult<()> {
    let root = receipts_root(&state).map_err(fail)?;
    let period = period(&year, &month).map_err(fail)?;
    blocking(move || {
        let paths = pipeline::ensure_period_dirs(&root, &period).map_err(fail)?;
        app.opener()
            .reveal_item_in_dir(&paths.dir)
            .map_err(|e| fail(CommandError::new(ErrorKind::Io, e.to_string())))
    })
    .await
    .map_err(fail)?
}

/// Opens the help on creating a service account key in the browser.
#[tauri::command]
pub fn open_key_help(app: AppHandle) -> CommandResult<()> {
    app.opener()
        .open_url(crate::menu::KEY_HELP_URL, None::<&str>)
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
