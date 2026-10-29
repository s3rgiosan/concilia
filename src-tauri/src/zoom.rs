//! View › Actual Size, Zoom In and Zoom Out. Each window keeps its own zoom level; the webview has
//! no zoom getter, so the level kept here is the one on screen.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// The zoom factors Zoom In and Zoom Out step through.
pub const LEVELS: [f64; 8] = [0.75, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];
/// The index of 1.0 in `LEVELS`.
const ACTUAL: usize = 2;

/// Sent to a window after its zoom changes; the payload is `{ "factor": … }`.
pub const ZOOM_CHANGED_EVENT: &str = "zoom-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Actual,
    In,
    Out,
}

/// The level after `step` from `current`, held within `LEVELS`.
pub fn next_level(current: usize, step: Step) -> usize {
    match step {
        Step::Actual => ACTUAL,
        Step::In => (current + 1).min(LEVELS.len() - 1),
        Step::Out => current.saturating_sub(1),
    }
}

/// Each window's zoom level, as an index into `LEVELS`, by window label.
#[derive(Default)]
pub struct ZoomState(Mutex<HashMap<String, usize>>);

impl ZoomState {
    /// Drops the level of a closed window, so it opens again at actual size.
    pub fn forget(&self, label: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
}

/// Zooms the focused window by `step`.
pub fn apply(app: &AppHandle, step: Step) {
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    else {
        return;
    };
    let state = app.state::<ZoomState>();
    let mut levels = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let label = window.label().to_string();
    let current = levels.get(&label).copied().unwrap_or(ACTUAL);
    let next = next_level(current, step);
    if let Err(error) = window.set_zoom(LEVELS[next]) {
        log::warn!("could not zoom the window: {error}");
        return;
    }
    levels.insert(label.clone(), next);
    drop(levels);
    let _ = app.emit_to(
        label.as_str(),
        ZOOM_CHANGED_EVENT,
        serde_json::json!({ "factor": LEVELS[next] }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_size_is_one() {
        assert_eq!(LEVELS[ACTUAL], 1.0);
        assert_eq!(next_level(6, Step::Actual), ACTUAL);
    }

    #[test]
    fn steps_stop_at_the_ends() {
        assert_eq!(next_level(ACTUAL, Step::In), 3);
        assert_eq!(next_level(LEVELS.len() - 1, Step::In), LEVELS.len() - 1);
        assert_eq!(next_level(ACTUAL, Step::Out), 1);
        assert_eq!(next_level(0, Step::Out), 0);
    }
}
