//! The Settings window, created on demand and focused when it already exists.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MAIN_LABEL: &str = "main";
pub const SETTINGS_LABEL: &str = "settings";
const SETTINGS_WIDTH: f64 = 640.0;
const SETTINGS_HEIGHT: f64 = 560.0;

pub fn focus(app: &AppHandle, label: &str) -> bool {
    match app.get_webview_window(label) {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            true
        }
        None => false,
    }
}

/// Opens the Settings window, or focuses it when it is open.
pub fn open_settings(app: &AppHandle) {
    if focus(app, SETTINGS_LABEL) {
        return;
    }
    // Windows must be built on the main thread.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(
            &handle,
            SETTINGS_LABEL,
            WebviewUrl::App("index.html?view=settings".into()),
        )
        .title("Settings")
        .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
        .min_inner_size(SETTINGS_WIDTH, 420.0)
        .resizable(true)
        .build();
        if let Err(error) = built {
            log::error!("could not open Settings: {error}");
        }
    });
}
