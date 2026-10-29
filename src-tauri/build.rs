/// The app's own commands. Each one is allowed only in the windows whose capability grants
/// its `allow-<command>` permission.
const COMMANDS: &[&str] = &[
    "get_app_state",
    "save_settings",
    "pick_receipts_root",
    "import_service_account",
    "remove_service_account",
    "test_gemini_connection",
    "poppler_status",
    "get_rules",
    "save_rules",
    "period_status",
    "list_periods",
    "create_period",
    "period_summary",
    "set_menu",
    "set_menu_state",
    "set_menu_item_text",
    "pick_statements",
    "reconcile",
    "scan_receipts",
    "add_statements",
    "cancel_run",
    "get_review",
    "get_draft",
    "save_draft",
    "finalize",
    "rescan_receipt",
    "rescan_reimbursement",
    "export_report",
    "open_report",
    "open_receipt",
    "reveal_period",
    "open_key_help",
    "open_settings",
    "check_for_updates",
    "pending_update",
    "install_update",
    "get_appearance",
    "show_alert",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build failed");
}
