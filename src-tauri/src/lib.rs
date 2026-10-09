pub mod app;
pub mod bank;
pub mod bank_fees;
pub mod commands;
pub mod config;
pub mod error;
pub mod excel;
pub mod extract;
pub mod finalize;
pub mod fsutil;
pub mod gemini;
pub mod locks;
pub mod matcher;
pub mod model;
pub mod period;
pub mod pipeline;
pub mod poppler;
pub mod protocol;
pub mod receipts;
pub mod review;
pub mod schema;
pub mod secrets;
pub mod text;
pub mod updates;
pub mod windows;

use std::sync::Arc;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::app::{AppState, BUSY_CHANGED_EVENT};
use crate::config::{ConfigStore, RulesStore};
use crate::poppler::Poppler;
use crate::secrets::{SecretStore, ServiceAccountStore};
use crate::updates::{UpdateCheckResult, UpdateManager, UPDATE_CHECK_RESULT_EVENT};

const MENU_SETTINGS: &str = "settings";
const MENU_CHECK_UPDATES: &str = "check-updates";

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let name = app.package_info().name.clone();
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let check_updates = MenuItem::with_id(
        app,
        MENU_CHECK_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

/// Focuses the main window and sends it the outcome of a check run now.
fn check_for_updates_from_menu(app: &AppHandle) {
    windows::focus(app, windows::MAIN_LABEL);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updates = app.state::<Arc<UpdateManager>>().inner().clone();
        let result = updates.check_now().await;
        if let Err(e) = &result {
            log::debug!("update check failed: {e}");
        }
        let _ = app.emit_to(
            windows::MAIN_LABEL,
            UPDATE_CHECK_RESULT_EVENT,
            UpdateCheckResult::from(&result),
        );
    });
}

/// The Keychain in release builds. Debug builds use a file, because each rebuild gets a new
/// ad-hoc signature that the Keychain would ask about again.
fn secret_store(app: &AppHandle, config_dir: &std::path::Path) -> Box<dyn SecretStore> {
    if cfg!(debug_assertions) {
        Box::new(secrets::FileStore::new(
            config_dir.join(secrets::DEV_FILE_NAME),
        ))
    } else {
        Box::new(secrets::KeychainStore::new(&app.config().identifier))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // The updater logs an unreachable server as an error; Concilia logs the failure itself.
                .level_for("tauri_plugin_updater", log::LevelFilter::Off)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::focus(app, windows::MAIN_LABEL);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::save_settings,
            commands::pick_receipts_root,
            commands::import_service_account,
            commands::remove_service_account,
            commands::test_gemini_connection,
            commands::poppler_status,
            commands::get_rules,
            commands::save_rules,
            commands::period_status,
            commands::pick_statements,
            commands::reconcile,
            commands::scan_receipts,
            commands::cancel_run,
            commands::get_review,
            commands::get_draft,
            commands::save_draft,
            commands::delete_draft,
            commands::finalize,
            commands::rescan_receipt,
            commands::rescan_reimbursement,
            commands::export_report,
            commands::open_report,
            commands::open_receipt,
            commands::reveal_period,
            commands::open_settings,
            commands::check_for_updates,
            commands::pending_update,
            commands::install_update,
        ])
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SETTINGS => windows::open_settings(app),
            MENU_CHECK_UPDATES => check_for_updates_from_menu(app),
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let (config_name, rules_name) = if cfg!(debug_assertions) {
                (config::DEV_FILE_NAME, config::DEV_RULES_FILE_NAME)
            } else {
                (config::FILE_NAME, config::RULES_FILE_NAME)
            };
            let config = ConfigStore::load(&config_dir.join(config_name)).unwrap_or_else(|e| {
                log::error!("settings unavailable: {e}");
                ConfigStore::in_memory(Default::default())
            });
            let rules = RulesStore::load(&config_dir.join(rules_name)).unwrap_or_else(|e| {
                log::error!("rules unavailable: {e}");
                RulesStore::in_memory(Vec::new())
            });
            let accounts = ServiceAccountStore::new(secret_store(&handle, &config_dir));

            let poppler = Poppler::resolve(app.path().resource_dir().ok().as_deref());
            log::info!(
                "pdf tools: {} ({})",
                poppler.pdftotext.display(),
                if poppler.bundled { "bundled" } else { "PATH" }
            );

            let state = Arc::new(AppState::new(config, rules, accounts, poppler));
            let busy_handle = handle.clone();
            state.locks.on_busy_change(move |busy| {
                let _ = busy_handle.emit(BUSY_CHANGED_EVENT, serde_json::json!({ "busy": busy }));
            });

            let updates = Arc::new(UpdateManager::new(
                Arc::new(updates::PluginSource::new(handle.clone())),
                Arc::new(|_| {}),
            ));
            let schedule_state = Arc::clone(&state);
            tauri::async_runtime::spawn(updates::run_schedule(Arc::clone(&updates), move || {
                schedule_state.settings().check_for_updates
            }));

            app.manage(state);
            app.manage(updates);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
