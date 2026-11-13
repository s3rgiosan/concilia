//! The Settings window, created on demand and focused when it already exists.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::menu::MenuState;

pub const MAIN_LABEL: &str = "main";
pub const SETTINGS_LABEL: &str = "settings";
/// Fixed width of the Settings window; its height follows the active pane (see `useFitWindow`).
const SETTINGS_WIDTH: f64 = 640.0;
const SETTINGS_HEIGHT: f64 = 420.0;
/// Centres the traffic lights in the 62 px pane switcher; AppKit places their centre 3 pt above `y`.
#[cfg(target_os = "macos")]
const SETTINGS_LIGHTS: (f64, f64) = (20.0, 34.0);

/// Set while a Settings window is being built.
static BUILDING_SETTINGS: AtomicBool = AtomicBool::new(false);

/// Holds a build flag until it drops, so only one build runs at a time.
struct BuildGuard<'a>(&'a AtomicBool);

impl<'a> BuildGuard<'a> {
    /// Takes the flag, or returns None when a build already holds it.
    fn try_start(flag: &'a AtomicBool) -> Option<BuildGuard<'a>> {
        if flag.swap(true, Ordering::SeqCst) {
            None
        } else {
            Some(BuildGuard(flag))
        }
    }
}

impl Drop for BuildGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

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
    let Some(building) = BuildGuard::try_start(&BUILDING_SETTINGS) else {
        return;
    };
    // Windows must be built on the main thread. The guard moves into the closure and releases the
    // flag when the build ends.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _building = building;
        let builder = WebviewWindowBuilder::new(
            &handle,
            SETTINGS_LABEL,
            WebviewUrl::App("index.html?view=settings".into()),
        )
        .title("Settings")
        .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
        .center()
        .resizable(false)
        .minimizable(false)
        .maximizable(false);
        #[cfg(target_os = "macos")]
        let builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(
                SETTINGS_LIGHTS.0,
                SETTINGS_LIGHTS.1,
            ));
        let built = builder.build();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_build_runs_at_a_time() {
        let flag = AtomicBool::new(false);
        let first = BuildGuard::try_start(&flag);
        assert!(first.is_some());
        assert!(BuildGuard::try_start(&flag).is_none());
        drop(first);
        assert!(BuildGuard::try_start(&flag).is_some());
    }
}
