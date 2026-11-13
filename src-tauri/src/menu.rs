//! The native menu bar. The frontend sends the localized labels and which items are enabled;
//! item clicks go back to the main window as `menu` events, except the few handled here.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Wry};

use crate::error::{fail, CommandError, CommandResult};
use crate::model::Language;
use crate::windows;
use crate::zoom;

/// Event sent to the main window when a menu item is chosen; the payload is `{ "id": … }`.
pub const MENU_EVENT: &str = "menu";

pub const HELP_URL: &str = "https://github.com/s3rgiosan/concilia#readme";

/// The About panel's copyright and credits lines: `bundle.copyright` and `bundle.shortDescription`
/// in tauri.conf.json, which the runtime config leaves out.
const COPYRIGHT: &str = "© 2026 Sérgio Santos";
const CREDITS: &str = "Bank statement reconciliation";

/// The README section on creating a Gemini service account key.
pub const KEY_HELP_URL: &str =
    "https://github.com/s3rgiosan/concilia#setting-up-google-gemini-agent-platform";

pub const SETTINGS: &str = "settings";
pub const CHECK_UPDATES: &str = "check_updates";
pub const NEW_MONTH: &str = "new_month";
pub const ADD_STATEMENTS: &str = "add_statements";
pub const EXPORT_REPORT: &str = "export_report";
pub const OPEN_REPORT: &str = "open_report";
pub const REVEAL_PERIOD: &str = "reveal_period";
pub const UNDO: &str = "undo";
pub const REDO: &str = "redo";
pub const DELETE: &str = "delete";
pub const FIND: &str = "find";
pub const FILTER_PENDING: &str = "filter_pending";
pub const FILTER_MATCHED: &str = "filter_matched";
pub const FILTER_ALL: &str = "filter_all";
pub const TOGGLE_SIDEBAR: &str = "toggle_sidebar";
pub const ACTUAL_SIZE: &str = "actual_size";
pub const ZOOM_IN: &str = "zoom_in";
pub const ZOOM_OUT: &str = "zoom_out";
pub const RECONCILE: &str = "reconcile";
pub const SCAN: &str = "scan";
pub const RERUN: &str = "rerun";
pub const REOPEN: &str = "reopen";
pub const FINALIZE: &str = "finalize";
pub const ACCEPT: &str = "accept";
pub const REJECT: &str = "reject";
pub const NO_RECEIPT: &str = "no_receipt";
pub const RESCAN: &str = "rescan";
pub const QUICK_LOOK: &str = "quick_look";
pub const OPEN_IN_PREVIEW: &str = "open_in_preview";
pub const NEXT_PENDING: &str = "next_pending";
pub const PREVIOUS_PENDING: &str = "previous_pending";
pub const HELP: &str = "help";

/// Menu titles and the labels of predefined items. `{app}` stands for the app name.
pub const MENU_FILE: &str = "menu_file";
pub const MENU_EDIT: &str = "menu_edit";
pub const MENU_VIEW: &str = "menu_view";
pub const MENU_MONTH: &str = "menu_month";
pub const MENU_TRANSACTION: &str = "menu_transaction";
pub const MENU_GO: &str = "menu_go";
pub const MENU_WINDOW: &str = "menu_window";
pub const MENU_HELP: &str = "menu_help";
pub const ABOUT: &str = "about";
pub const SERVICES: &str = "services";
pub const HIDE: &str = "hide";
pub const HIDE_OTHERS: &str = "hide_others";
pub const SHOW_ALL: &str = "show_all";
pub const QUIT: &str = "quit";
pub const CUT: &str = "cut";
pub const COPY: &str = "copy";
pub const PASTE: &str = "paste";
pub const SELECT_ALL: &str = "select_all";
pub const MINIMIZE: &str = "minimize";
pub const ZOOM: &str = "zoom";
pub const FULL_SCREEN: &str = "full_screen";
pub const BRING_ALL_TO_FRONT: &str = "bring_all_to_front";
pub const CLOSE_WINDOW: &str = "close_window";

/// Ids of the items and submenus the frontend can enable or disable and that send events.
pub const ITEM_IDS: &[&str] = &[
    SETTINGS,
    CHECK_UPDATES,
    NEW_MONTH,
    ADD_STATEMENTS,
    EXPORT_REPORT,
    OPEN_REPORT,
    REVEAL_PERIOD,
    UNDO,
    REDO,
    DELETE,
    FIND,
    FILTER_PENDING,
    FILTER_MATCHED,
    FILTER_ALL,
    TOGGLE_SIDEBAR,
    ACTUAL_SIZE,
    ZOOM_IN,
    ZOOM_OUT,
    RECONCILE,
    SCAN,
    RERUN,
    REOPEN,
    FINALIZE,
    ACCEPT,
    REJECT,
    NO_RECEIPT,
    RESCAN,
    QUICK_LOOK,
    OPEN_IN_PREVIEW,
    NEXT_PENDING,
    PREVIOUS_PENDING,
    HELP,
];

/// Keys of labels that are not item ids.
pub const EXTRA_LABEL_KEYS: &[&str] = &[
    MENU_FILE,
    MENU_EDIT,
    MENU_VIEW,
    MENU_MONTH,
    MENU_TRANSACTION,
    MENU_GO,
    MENU_WINDOW,
    MENU_HELP,
    ABOUT,
    SERVICES,
    HIDE,
    HIDE_OTHERS,
    SHOW_ALL,
    QUIT,
    CUT,
    COPY,
    PASTE,
    SELECT_ALL,
    MINIMIZE,
    ZOOM,
    FULL_SCREEN,
    BRING_ALL_TO_FRONT,
    CLOSE_WINDOW,
];

/// The English label for a key, or an empty string for an unknown key.
fn english(key: &str) -> &'static str {
    match key {
        SETTINGS => "Settings…",
        CHECK_UPDATES => "Check for Updates…",
        NEW_MONTH => "New Month…",
        ADD_STATEMENTS => "Add Statements…",
        EXPORT_REPORT => "Export Report…",
        OPEN_REPORT => "Open Report",
        REVEAL_PERIOD => "Show in Finder",
        UNDO => "Undo",
        REDO => "Redo",
        DELETE => "Delete",
        FIND => "Find",
        FILTER_PENDING => "To Decide",
        FILTER_MATCHED => "Matched",
        FILTER_ALL => "All",
        TOGGLE_SIDEBAR => "Show Sidebar",
        ACTUAL_SIZE => "Actual Size",
        ZOOM_IN => "Zoom In",
        ZOOM_OUT => "Zoom Out",
        RECONCILE => "Reconcile",
        SCAN => "Scan for New Receipts",
        RERUN => "Reconcile Again…",
        REOPEN => "Reopen Month…",
        FINALIZE => "Finalize…",
        ACCEPT => "Assign Receipt",
        REJECT => "Remove Match",
        NO_RECEIPT => "No Receipt Needed",
        RESCAN => "Read Receipt Again",
        QUICK_LOOK => "Quick Look",
        OPEN_IN_PREVIEW => "Open in Preview",
        NEXT_PENDING => "Next Undecided",
        PREVIOUS_PENDING => "Previous Undecided",
        HELP => "Concilia Help",
        MENU_FILE => "File",
        MENU_EDIT => "Edit",
        MENU_VIEW => "View",
        MENU_MONTH => "Month",
        MENU_TRANSACTION => "Transaction",
        MENU_GO => "Go",
        MENU_WINDOW => "Window",
        MENU_HELP => "Help",
        ABOUT => "About {app}",
        SERVICES => "Services",
        HIDE => "Hide {app}",
        HIDE_OTHERS => "Hide Others",
        SHOW_ALL => "Show All",
        QUIT => "Quit {app}",
        CUT => "Cut",
        COPY => "Copy",
        PASTE => "Paste",
        SELECT_ALL => "Select All",
        MINIMIZE => "Minimize",
        ZOOM => "Zoom",
        FULL_SCREEN => "Enter Full Screen",
        BRING_ALL_TO_FRONT => "Bring All to Front",
        CLOSE_WINDOW => "Close Window",
        _ => "",
    }
}

/// Menu labels by key (an item id or one of `EXTRA_LABEL_KEYS`). Missing or empty entries
/// fall back to English.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct MenuLabels(HashMap<String, String>);

impl MenuLabels {
    pub fn new(labels: HashMap<String, String>) -> MenuLabels {
        MenuLabels(labels)
    }

    /// The label for `key` with `{app}` replaced by `app_name`.
    pub fn label(&self, key: &str, app_name: &str) -> String {
        let text = self
            .0
            .get(key)
            .map(String::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| english(key));
        text.replace("{app}", app_name)
    }
}

/// One item of the No Receipt Needed submenu: a reason id and its name in the menu's language.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MenuReason {
    pub id: String,
    pub label: String,
}

/// The submenu items for `reasons`, named in `language`.
pub fn reason_items(reasons: &[crate::model::Reason], language: Language) -> Vec<MenuReason> {
    reasons
        .iter()
        .map(|reason| MenuReason {
            id: reason.id.clone(),
            label: reason.names.get(language).to_string(),
        })
        .collect()
}

/// The menu item id of the reason `id`: the No Receipt Needed id, `_`, then the reason id.
pub fn reason_item_id(id: &str) -> String {
    format!("{NO_RECEIPT}_{id}")
}

/// How a chosen menu item is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Settings,
    CheckUpdates,
    Help,
    Zoom(zoom::Step),
    /// Sent to the main window as a `menu` event.
    Frontend,
}

pub fn route(id: &str) -> Route {
    match id {
        SETTINGS => Route::Settings,
        CHECK_UPDATES => Route::CheckUpdates,
        HELP => Route::Help,
        ACTUAL_SIZE => Route::Zoom(zoom::Step::Actual),
        ZOOM_IN => Route::Zoom(zoom::Step::In),
        ZOOM_OUT => Route::Zoom(zoom::Step::Out),
        _ => Route::Frontend,
    }
}

/// The window that receives a `menu` event for `id`: Undo, Redo and Delete go to the Settings
/// window while it has focus, everything else to the main window.
pub fn event_target(id: &str, settings_focused: bool) -> &'static str {
    match id {
        UNDO | REDO | DELETE if settings_focused => windows::SETTINGS_LABEL,
        _ => windows::MAIN_LABEL,
    }
}

/// Whether Undo and Redo are enabled: always while the Settings window has focus, where text
/// fields and removed rules can be undone; otherwise as the main window asked.
fn undo_redo_enabled(settings_focused: bool, requested: Option<bool>) -> bool {
    settings_focused || requested.unwrap_or(true)
}

/// Keeps only the entries of `enabled` that name a known item.
fn known_states(enabled: HashMap<String, bool>) -> HashMap<String, bool> {
    enabled
        .into_iter()
        .filter(|(id, _)| ITEM_IDS.contains(&id.as_str()))
        .collect()
}

enum Handle {
    Item(MenuItem<Wry>),
    Submenu(Submenu<Wry>),
}

impl Handle {
    fn set_enabled(&self, enabled: bool) -> tauri::Result<()> {
        match self {
            Handle::Item(item) => item.set_enabled(enabled),
            Handle::Submenu(submenu) => submenu.set_enabled(enabled),
        }
    }

    fn set_text(&self, text: &str) -> tauri::Result<()> {
        match self {
            Handle::Item(item) => item.set_text(text),
            Handle::Submenu(submenu) => submenu.set_text(text),
        }
    }
}

/// The handles of the current menu's items and the enabled flags the frontend asked for.
#[derive(Default)]
pub struct MenuState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    handles: HashMap<String, Handle>,
    enabled: HashMap<String, bool>,
    settings_focused: bool,
}

impl Inner {
    /// The flag to apply to `id`, or None when the item keeps its current state.
    fn effective(&self, id: &str) -> Option<bool> {
        let requested = self.enabled.get(id).copied();
        match id {
            UNDO | REDO => Some(undo_redo_enabled(self.settings_focused, requested)),
            _ => requested,
        }
    }
}

impl MenuState {
    fn install(&self, handles: HashMap<String, Handle>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.handles = handles;
        for (id, handle) in &inner.handles {
            if let Some(enabled) = inner.effective(id) {
                let _ = handle.set_enabled(enabled);
            }
        }
    }

    /// Records whether the Settings window has focus, which keeps Undo and Redo enabled.
    pub fn set_settings_focused(&self, focused: bool) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.settings_focused = focused;
        for id in [UNDO, REDO] {
            if let (Some(handle), Some(enabled)) = (inner.handles.get(id), inner.effective(id)) {
                let _ = handle.set_enabled(enabled);
            }
        }
    }

    /// Sets the text of the item `id`. Returns false when the menu has no such item.
    fn set_text(&self, id: &str, text: &str) -> tauri::Result<bool> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(handle) = inner.handles.get(id) else {
            return Ok(false);
        };
        handle.set_text(text)?;
        Ok(true)
    }

    fn set_enabled(&self, enabled: HashMap<String, bool>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for (id, value) in known_states(enabled) {
            inner.enabled.insert(id.clone(), value);
            if let (Some(handle), Some(enabled)) = (inner.handles.get(&id), inner.effective(&id)) {
                let _ = handle.set_enabled(enabled);
            }
        }
    }
}

struct Builder<'a> {
    app: &'a AppHandle,
    labels: &'a MenuLabels,
    name: String,
    handles: HashMap<String, Handle>,
}

impl Builder<'_> {
    fn text(&self, key: &str) -> String {
        self.labels.label(key, &self.name)
    }

    fn item(&mut self, id: &str, accelerator: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
        let item = MenuItem::with_id(self.app, id, self.text(id), true, accelerator)?;
        self.handles
            .insert(id.to_string(), Handle::Item(item.clone()));
        Ok(item)
    }

    fn submenu(
        &self,
        key: &str,
        items: &[&dyn tauri::menu::IsMenuItem<Wry>],
    ) -> tauri::Result<Submenu<Wry>> {
        Submenu::with_items(self.app, self.text(key), true, items)
    }

    fn separator(&self) -> tauri::Result<PredefinedMenuItem<Wry>> {
        PredefinedMenuItem::separator(self.app)
    }
}

/// The About panel's icon. A debug build runs without an app bundle, so AppKit finds no icon
/// of its own and the build passes one.
#[cfg(debug_assertions)]
fn about_icon() -> Option<tauri::image::Image<'static>> {
    Some(tauri::include_image!("./icons/128x128@2x.png"))
}

/// The About panel's icon. A release build leaves it to AppKit, which shows the bundle's icon.
#[cfg(not(debug_assertions))]
fn about_icon() -> Option<tauri::image::Image<'static>> {
    None
}

/// Builds the menu bar and the handles of its items.
fn build(
    app: &AppHandle,
    labels: &MenuLabels,
    reasons: &[MenuReason],
) -> tauri::Result<(Menu<Wry>, HashMap<String, Handle>)> {
    let name = app.package_info().name.clone();
    let mut b = Builder {
        app,
        labels,
        name: name.clone(),
        handles: HashMap::new(),
    };

    // An empty short version keeps AppKit from repeating the version in parentheses.
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        short_version: Some(String::new()),
        copyright: Some(COPYRIGHT.to_string()),
        credits: Some(CREDITS.to_string()),
        icon: about_icon(),
        ..Default::default()
    };
    let check_updates = b.item(CHECK_UPDATES, None)?;
    let settings = b.item(SETTINGS, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&b.text(ABOUT)), Some(about))?,
            &check_updates,
            &b.separator()?,
            &settings,
            &b.separator()?,
            &PredefinedMenuItem::services(app, Some(&b.text(SERVICES)))?,
            &b.separator()?,
            &PredefinedMenuItem::hide(app, Some(&b.text(HIDE)))?,
            &PredefinedMenuItem::hide_others(app, Some(&b.text(HIDE_OTHERS)))?,
            &PredefinedMenuItem::show_all(app, Some(&b.text(SHOW_ALL)))?,
            &b.separator()?,
            &PredefinedMenuItem::quit(app, Some(&b.text(QUIT)))?,
        ],
    )?;

    let new_month = b.item(NEW_MONTH, Some("CmdOrCtrl+N"))?;
    let add_statements = b.item(ADD_STATEMENTS, Some("CmdOrCtrl+O"))?;
    let reveal_period = b.item(REVEAL_PERIOD, None)?;
    let file_menu = b.submenu(
        MENU_FILE,
        &[
            &new_month,
            &b.separator()?,
            &reveal_period,
            &b.separator()?,
            &PredefinedMenuItem::close_window(app, Some(&b.text(CLOSE_WINDOW)))?,
        ],
    )?;

    let undo = b.item(UNDO, Some("CmdOrCtrl+Z"))?;
    let redo = b.item(REDO, Some("CmdOrCtrl+Shift+Z"))?;
    let delete = b.item(DELETE, None)?;
    let find = b.item(FIND, Some("CmdOrCtrl+F"))?;
    let edit_menu = b.submenu(
        MENU_EDIT,
        &[
            &undo,
            &redo,
            &b.separator()?,
            &PredefinedMenuItem::cut(app, Some(&b.text(CUT)))?,
            &PredefinedMenuItem::copy(app, Some(&b.text(COPY)))?,
            &PredefinedMenuItem::paste(app, Some(&b.text(PASTE)))?,
            &delete,
            &PredefinedMenuItem::select_all(app, Some(&b.text(SELECT_ALL)))?,
            &b.separator()?,
            &find,
        ],
    )?;

    let filter_pending = b.item(FILTER_PENDING, Some("CmdOrCtrl+1"))?;
    let filter_matched = b.item(FILTER_MATCHED, Some("CmdOrCtrl+2"))?;
    let filter_all = b.item(FILTER_ALL, Some("CmdOrCtrl+3"))?;
    let toggle_sidebar = b.item(TOGGLE_SIDEBAR, Some("Ctrl+Cmd+S"))?;
    let actual_size = b.item(ACTUAL_SIZE, Some("CmdOrCtrl+0"))?;
    let zoom_in = b.item(ZOOM_IN, Some("CmdOrCtrl+="))?;
    let zoom_out = b.item(ZOOM_OUT, Some("CmdOrCtrl+-"))?;
    let view_menu = b.submenu(
        MENU_VIEW,
        &[
            &filter_pending,
            &filter_matched,
            &filter_all,
            &b.separator()?,
            &toggle_sidebar,
            &PredefinedMenuItem::fullscreen(app, Some(&b.text(FULL_SCREEN)))?,
            &b.separator()?,
            &actual_size,
            &zoom_in,
            &zoom_out,
        ],
    )?;

    let reconcile = b.item(RECONCILE, Some("CmdOrCtrl+R"))?;
    let scan = b.item(SCAN, Some("CmdOrCtrl+Shift+R"))?;
    let rerun = b.item(RERUN, None)?;
    let reopen = b.item(REOPEN, None)?;
    let finalize = b.item(FINALIZE, None)?;
    let open_report = b.item(OPEN_REPORT, None)?;
    let export_report = b.item(EXPORT_REPORT, None)?;
    let month_menu = b.submenu(
        MENU_MONTH,
        &[
            &add_statements,
            &b.separator()?,
            &reconcile,
            &scan,
            &b.separator()?,
            &finalize,
            &reopen,
            &rerun,
            &b.separator()?,
            &open_report,
            &export_report,
        ],
    )?;

    let accept = b.item(ACCEPT, Some("CmdOrCtrl+Enter"))?;
    let reject = b.item(REJECT, Some("CmdOrCtrl+Backspace"))?;
    // The submenu is enabled as a whole, so its reason items need no handles.
    let no_receipt_items = reasons
        .iter()
        .map(|reason| {
            MenuItem::with_id(
                app,
                reason_item_id(&reason.id),
                &reason.label,
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let mut no_receipt = SubmenuBuilder::with_id(app, NO_RECEIPT, b.text(NO_RECEIPT));
    for item in &no_receipt_items {
        no_receipt = no_receipt.item(item);
    }
    let no_receipt = no_receipt.build()?;
    b.handles
        .insert(NO_RECEIPT.to_string(), Handle::Submenu(no_receipt.clone()));
    let rescan = b.item(RESCAN, Some("CmdOrCtrl+Alt+R"))?;
    let quick_look = b.item(QUICK_LOOK, Some("CmdOrCtrl+Y"))?;
    let open_in_preview = b.item(OPEN_IN_PREVIEW, Some("CmdOrCtrl+Alt+O"))?;
    let transaction_menu = b.submenu(
        MENU_TRANSACTION,
        &[
            &accept,
            &reject,
            &no_receipt,
            &b.separator()?,
            &rescan,
            &quick_look,
            &open_in_preview,
        ],
    )?;

    let next_pending = b.item(NEXT_PENDING, Some("CmdOrCtrl+]"))?;
    let previous_pending = b.item(PREVIOUS_PENDING, Some("CmdOrCtrl+["))?;
    let go_menu = b.submenu(MENU_GO, &[&next_pending, &previous_pending])?;

    // These ids make `set_menu` register the submenus with macOS: the Window menu then lists the
    // open windows and the tiling commands, and the Help menu gets its search field.
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        b.text(MENU_WINDOW),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&b.text(MINIMIZE)))?,
            &PredefinedMenuItem::maximize(app, Some(&b.text(ZOOM)))?,
            &b.separator()?,
            &PredefinedMenuItem::bring_all_to_front(app, Some(&b.text(BRING_ALL_TO_FRONT)))?,
        ],
    )?;

    let help = b.item(HELP, None)?;
    let help_menu =
        Submenu::with_id_and_items(app, HELP_SUBMENU_ID, b.text(MENU_HELP), true, &[&help])?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &month_menu,
            &transaction_menu,
            &go_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    Ok((menu, b.handles))
}

/// Sets the menu bar with the given labels and no-receipt reasons, and keeps the item handles
/// in `MenuState`.
pub fn apply(
    app: &AppHandle,
    state: &MenuState,
    labels: &MenuLabels,
    reasons: &[MenuReason],
) -> tauri::Result<()> {
    let (menu, handles) = build(app, labels, reasons)?;
    app.set_menu(menu)?;
    state.install(handles);
    Ok(())
}

/// Rebuilds the menu bar with labels and no-receipt reasons from the frontend.
#[tauri::command]
pub fn set_menu(
    app: AppHandle,
    state: tauri::State<'_, MenuState>,
    labels: MenuLabels,
    reasons: Vec<MenuReason>,
) -> CommandResult<()> {
    apply(&app, &state, &labels, &reasons).map_err(|e| fail(CommandError::internal(e)))
}

/// Changes the text of one menu item without rebuilding the menu; unknown ids are ignored.
#[tauri::command]
pub fn set_menu_item_text(
    state: tauri::State<'_, MenuState>,
    id: String,
    text: String,
) -> CommandResult<()> {
    state
        .set_text(&id, &text)
        .map(|_| ())
        .map_err(|e| fail(CommandError::internal(e)))
}

/// Enables or disables items by id; unknown ids are ignored.
#[tauri::command]
pub fn set_menu_state(
    state: tauri::State<'_, MenuState>,
    enabled: HashMap<String, bool>,
) -> CommandResult<()> {
    state.set_enabled(enabled);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_id_and_key_has_an_english_label() {
        for key in ITEM_IDS.iter().chain(EXTRA_LABEL_KEYS) {
            assert!(!english(key).is_empty(), "{key}");
        }
    }

    #[test]
    fn ids_and_keys_are_unique() {
        let all: Vec<&&str> = ITEM_IDS.iter().chain(EXTRA_LABEL_KEYS).collect();
        let unique: HashSet<&&str> = all.iter().copied().collect();
        assert_eq!(all.len(), unique.len());
    }

    #[test]
    fn missing_or_empty_labels_fall_back_to_english() {
        let labels = MenuLabels::new(HashMap::from([
            (RECONCILE.to_string(), "Conciliar".to_string()),
            (SCAN.to_string(), String::new()),
        ]));
        assert_eq!(labels.label(RECONCILE, "Concilia"), "Conciliar");
        assert_eq!(labels.label(SCAN, "Concilia"), "Scan for New Receipts");
        assert_eq!(labels.label(FINALIZE, "Concilia"), "Finalize…");
    }

    #[test]
    fn reason_items_carry_the_reason_id_and_name() {
        let items = reason_items(&crate::model::default_reasons(), Language::Pt);
        assert_eq!(
            items.first(),
            Some(&MenuReason {
                id: "bank_fee".into(),
                label: "Comissão bancária".into()
            })
        );
        assert_eq!(reason_item_id("reason:a"), "no_receipt_reason:a");
    }

    #[test]
    fn labels_insert_the_app_name() {
        let labels = MenuLabels::default();
        assert_eq!(labels.label(QUIT, "Concilia"), "Quit Concilia");
        assert_eq!(labels.label(ABOUT, "Concilia"), "About Concilia");
    }

    #[test]
    fn labels_deserialize_from_a_flat_map() {
        let labels: MenuLabels = serde_json::from_str(r#"{"menu_file":"Ficheiro"}"#).unwrap();
        assert_eq!(labels.label(MENU_FILE, "Concilia"), "Ficheiro");
        assert_eq!(labels.label(MENU_EDIT, "Concilia"), "Edit");
    }

    #[test]
    fn state_map_ignores_unknown_ids() {
        let known = known_states(HashMap::from([
            (RECONCILE.to_string(), false),
            ("bogus".to_string(), true),
        ]));
        assert_eq!(known, HashMap::from([(RECONCILE.to_string(), false)]));
    }

    #[test]
    fn undo_and_redo_go_to_the_focused_settings_window() {
        assert_eq!(event_target(UNDO, true), windows::SETTINGS_LABEL);
        assert_eq!(event_target(REDO, true), windows::SETTINGS_LABEL);
        assert_eq!(event_target(DELETE, true), windows::SETTINGS_LABEL);
        assert_eq!(event_target(DELETE, false), windows::MAIN_LABEL);
        assert_eq!(event_target(UNDO, false), windows::MAIN_LABEL);
        assert_eq!(event_target(RECONCILE, true), windows::MAIN_LABEL);
    }

    #[test]
    fn undo_and_redo_stay_enabled_while_settings_has_focus() {
        assert!(undo_redo_enabled(true, Some(false)));
        assert!(!undo_redo_enabled(false, Some(false)));
        assert!(undo_redo_enabled(false, None));
    }

    #[test]
    fn about_lines_match_the_bundle_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["bundle"]["copyright"], COPYRIGHT);
        assert_eq!(config["bundle"]["shortDescription"], CREDITS);
    }

    #[test]
    fn routes_rust_handled_ids() {
        assert_eq!(route(SETTINGS), Route::Settings);
        assert_eq!(route(CHECK_UPDATES), Route::CheckUpdates);
        assert_eq!(route(HELP), Route::Help);
        assert_eq!(route(ACTUAL_SIZE), Route::Zoom(zoom::Step::Actual));
        assert_eq!(route(ZOOM_IN), Route::Zoom(zoom::Step::In));
        assert_eq!(route(ZOOM_OUT), Route::Zoom(zoom::Step::Out));
        assert_eq!(route(RECONCILE), Route::Frontend);
        assert_eq!(route("anything"), Route::Frontend);
    }
}
