//! The system appearance settings the webview can't read: the user's accent colour and Reduce
//! Transparency. Windows read them with `get_appearance` and receive `appearance-changed` when a
//! window gains focus or the theme changes after either setting changed.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const APPEARANCE_CHANGED_EVENT: &str = "appearance-changed";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Appearance {
    /// The accent colour as `#rrggbb` in sRGB, or None where the platform has no accent to read.
    pub accent: Option<String>,
    pub reduce_transparency: bool,
}

/// The appearance last sent to the windows.
#[derive(Default)]
pub struct AppearanceState(Mutex<Option<Appearance>>);

/// `#rrggbb` for sRGB components between 0 and 1.
fn hex(red: f64, green: f64, blue: f64) -> String {
    let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(red),
        channel(green),
        channel(blue)
    )
}

#[cfg(target_os = "macos")]
fn read() -> Appearance {
    use objc2_app_kit::{NSColor, NSColorSpace, NSWorkspace};

    let accent = NSColor::controlAccentColor()
        .colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())
        .map(|color| {
            hex(
                color.redComponent(),
                color.greenComponent(),
                color.blueComponent(),
            )
        });
    let reduce_transparency =
        NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency();
    Appearance {
        accent,
        reduce_transparency,
    }
}

#[cfg(not(target_os = "macos"))]
fn read() -> Appearance {
    let _ = hex;
    Appearance::default()
}

/// The current accent colour and Reduce Transparency setting.
#[tauri::command]
pub fn get_appearance(state: tauri::State<'_, AppearanceState>) -> Appearance {
    let current = read();
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(current.clone());
    current
}

/// Reads the settings again and tells every window when they changed.
pub fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<AppearanceState>() else {
        return;
    };
    let current = read();
    let mut last = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref() == Some(&current) {
        return;
    }
    *last = Some(current.clone());
    drop(last);
    let _ = app.emit(APPEARANCE_CHANGED_EVENT, current);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_rounds_and_clamps_components() {
        assert_eq!(hex(0.0, 0.478, 1.0), "#007aff");
        assert_eq!(hex(-0.2, 0.5, 1.4), "#0080ff");
    }
}
