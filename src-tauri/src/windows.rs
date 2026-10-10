//! The Settings window, created on demand and focused when it already exists.

use tauri::{AppHandle, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::menu::MenuState;

pub const MAIN_LABEL: &str = "main";
pub const SETTINGS_LABEL: &str = "settings";
/// Fixed width of the Settings window; its height follows the active pane (see `useFitWindow`).
const SETTINGS_WIDTH: f64 = 640.0;
const SETTINGS_HEIGHT: f64 = 420.0;
/// Centres the traffic lights in the 62 px pane switcher drawn under the title bar.
const SETTINGS_LIGHTS: (f64, f64) = (20.0, 29.0);

/// Whether the window `label` exists and has focus.
pub fn is_focused(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .is_some_and(|window| window.is_focused().unwrap_or(false))
}

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
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            SETTINGS_LIGHTS.0,
            SETTINGS_LIGHTS.1,
        ))
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .build();
        match built {
            Ok(window) => {
                // While Settings has focus, Edit › Undo and Redo stay enabled and reach it.
                let events = handle.clone();
                window.on_window_event(move |event| {
                    let focused = match event {
                        WindowEvent::Focused(focused) => *focused,
                        WindowEvent::Destroyed => false,
                        _ => return,
                    };
                    events.state::<MenuState>().set_settings_focused(focused);
                });
            }
            Err(error) => log::error!("could not open Settings: {error}"),
        }
    });
}
