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
    "save_reasons",
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
    "reopen",
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

/// The Windows application manifest. It asks for Common Controls v6, which the dialogs need.
const WINDOWS_MANIFEST: &str = "windows-app-manifest.xml";

fn main() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if windows_msvc {
        // tauri-build links its manifest into the app binary only. Without the manifest, a
        // test binary loads Common Controls v5 and stops with STATUS_ENTRYPOINT_NOT_FOUND.
        // The linker embeds the manifest into every binary, the test binaries included.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(WINDOWS_MANIFEST);
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("tauri build failed");
}
