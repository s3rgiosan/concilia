pub mod app;
pub mod bank;
pub mod bank_fees;
pub mod commands;
pub mod config;
pub mod dates;
pub mod error;
pub mod excel;
pub mod extract;
pub mod filecheck;
pub mod finalize;
pub mod fsutil;
pub mod gemini;
pub mod locks;
pub mod matcher;
pub mod menu;
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

use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::app::{AppState, BUSY_CHANGED_EVENT};
use crate::config::{ConfigStore, RulesStore};
use crate::menu::{MenuLabels, MenuState, Route};
use crate::poppler::Poppler;
use crate::secrets::{SecretStore, ServiceAccountStore};
use crate::updates::{UpdateCheckResult, UpdateManager, UPDATE_CHECK_RESULT_EVENT};

fn handle_menu_event(app: &AppHandle, id: &str) {
    match menu::route(id) {
        Route::Settings => windows::open_settings(app),
        Route::CheckUpdates => check_for_updates_from_menu(app),
        Route::Help => {
            if let Err(error) = app.opener().open_url(menu::HELP_URL, None::<&str>) {
                log::warn!("could not open the help page: {error}");
            }
        }
        Route::Frontend => {
            let settings_focused = windows::is_focused(app, windows::SETTINGS_LABEL);
            let _ = app.emit_to(
                menu::event_target(id, settings_focused),
                menu::MENU_EVENT,
                serde_json::json!({ "id": id }),
            );
        }
    }
}

/// Records files dropped on a window, so the commands that read them accept them.
fn grant_dropped(app: &AppHandle, event: &DragDropEvent) {
    if let DragDropEvent::Drop { paths, .. } = event {
        if let Some(state) = app.try_state::<Arc<AppState>>() {
            state.grant_paths(paths.iter().cloned());
        }
    }
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
            commands::list_periods,
            commands::create_period,
            commands::period_summary,
            menu::set_menu,
            menu::set_menu_state,
            menu::set_menu_item_text,
            commands::pick_statements,
            commands::reconcile,
            commands::scan_receipts,
            commands::add_statements,
            commands::cancel_run,
            commands::get_review,
            commands::get_draft,
            commands::save_draft,
            commands::finalize,
            commands::rescan_receipt,
            commands::rescan_reimbursement,
            commands::export_report,
            commands::open_report,
            commands::open_receipt,
            commands::reveal_period,
            commands::open_key_help,
            commands::open_settings,
            commands::check_for_updates,
            commands::pending_update,
            commands::install_update,
        ])
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(drop) = event {
                grant_dropped(window.app_handle(), drop);
            }
        })
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(drop) = event {
                grant_dropped(webview.app_handle(), drop);
            }
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
            // The first read of the service account may wait on a Keychain prompt; reading it
            // now keeps the windows' first `get_app_state` from waiting on it.
            let warm_state = Arc::clone(&state);
            std::thread::spawn(move || {
                if let Err(error) = warm_state.accounts.get() {
                    log::warn!("service account unavailable: {error}");
                }
            });
            let busy_handle = handle.clone();
            state.locks.on_busy_change(move |busy| {
                let _ = busy_handle.emit(BUSY_CHANGED_EVENT, serde_json::json!({ "busy": busy }));
            });

            let updates = Arc::new(UpdateManager::new(Arc::new(updates::PluginSource::new(
                handle.clone(),
            ))));
            let schedule_state = Arc::clone(&state);
            tauri::async_runtime::spawn(updates::run_schedule(Arc::clone(&updates), move || {
                schedule_state.settings().check_for_updates
            }));

            app.manage(state);
            app.manage(updates);

            let menu_state = MenuState::default();
            if let Err(error) = menu::apply(&handle, &menu_state, &MenuLabels::default()) {
                log::error!("menu unavailable: {error}");
            }
            app.manage(menu_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
