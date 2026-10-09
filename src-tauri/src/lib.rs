pub mod commands;
pub mod poppler;
pub mod protocol;

use tauri::Manager;

use crate::poppler::Poppler;
use crate::protocol::ReceiptsRoot;

/// Label of the main window, declared in `tauri.conf.json`.
pub const MAIN_LABEL: &str = "main";

fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
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
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .invoke_handler(tauri::generate_handler![commands::poppler_status])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let poppler = Poppler::resolve(resource_dir.as_deref());
            log::info!(
                "pdf tools: {} ({})",
                poppler.pdftotext.display(),
                if poppler.bundled { "bundled" } else { "PATH" }
            );
            app.manage(poppler);

            let root = ReceiptsRoot::default();
            // Debug builds can point the receipt viewer at a folder before settings exist.
            #[cfg(debug_assertions)]
            if let Some(dir) = std::env::var_os("CONCILIA_DEV_RECEIPTS_ROOT") {
                if let Ok(mut guard) = root.0.write() {
                    *guard = Some(dir.into());
                }
            }
            app.manage(root);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
