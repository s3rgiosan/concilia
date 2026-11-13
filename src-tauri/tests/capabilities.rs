//! The command allowlist: every registered command is in the app manifest, every permission a
//! window holds names one of them, and every command the frontend invokes is granted to a
//! window.

use std::collections::BTreeSet;
use std::path::PathBuf;

use regex::Regex;
use serde_json::Value;

fn read(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The quoted names in `const COMMANDS` of `build.rs`.
fn manifest_commands() -> BTreeSet<String> {
    let build = read("build.rs");
    let start = build
        .find("const COMMANDS")
        .expect("build.rs lists COMMANDS");
    let end = start + build[start..].find("];").expect("COMMANDS ends");
    Regex::new(r#""([a-z_]+)""#)
        .unwrap()
        .captures_iter(&build[start..end])
        .map(|c| c[1].to_string())
        .collect()
}

/// The commands passed to `generate_handler!` in `lib.rs`.
fn registered_commands() -> BTreeSet<String> {
    let lib = read("src/lib.rs");
    let start = lib
        .find("generate_handler![")
        .expect("lib.rs registers commands");
    let end = start + lib[start..].find("])").expect("generate_handler ends");
    Regex::new(r"::([a-z_]+),")
        .unwrap()
        .captures_iter(&lib[start..end])
        .map(|c| c[1].to_string())
        .collect()
}

/// The app commands a capability file grants.
fn granted(capability: &str) -> BTreeSet<String> {
    let json: Value = serde_json::from_str(&read(capability)).unwrap();
    json["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|p| p.strip_prefix("allow-"))
        .map(|p| p.replace('-', "_"))
        .collect()
}

/// The commands the frontend invokes by name.
fn invoked_commands() -> BTreeSet<String> {
    let tauri = read("../src/lib/tauri.ts");
    let direct = Regex::new(r#"invoke(?:<[^>]*>)?\("([a-z_]+)""#).unwrap();
    let runs = Regex::new(r#"run<[^>]*>\("([a-z_]+)""#).unwrap();
    direct
        .captures_iter(&tauri)
        .chain(runs.captures_iter(&tauri))
        .map(|c| c[1].to_string())
        .collect()
}

#[test]
fn every_registered_command_is_in_the_manifest() {
    assert_eq!(registered_commands(), manifest_commands());
}

#[test]
fn windows_are_granted_only_known_commands() {
    let known = manifest_commands();
    for capability in ["capabilities/main.json", "capabilities/settings.json"] {
        let unknown: Vec<String> = granted(capability).difference(&known).cloned().collect();
        assert!(unknown.is_empty(), "{capability}: {unknown:?}");
    }
}

#[test]
fn every_invoked_command_is_granted_to_a_window() {
    let invoked = invoked_commands();
    assert!(invoked.contains("reconcile"), "{invoked:?}");
    let mut granted_anywhere = granted("capabilities/main.json");
    granted_anywhere.extend(granted("capabilities/settings.json"));
    let missing: Vec<&String> = invoked.difference(&granted_anywhere).collect();
    assert!(missing.is_empty(), "invoked but never granted: {missing:?}");
}

#[test]
fn the_settings_window_cannot_run_jobs_or_open_files() {
    let settings = granted("capabilities/settings.json");
    for command in [
        "reconcile",
        "add_statements",
        "scan_receipts",
        "finalize",
        "reopen",
        "open_receipt",
        "open_report",
        "export_report",
        "save_draft",
        "pick_statements",
    ] {
        assert!(!settings.contains(command), "{command}");
    }
}

/// The `core:` permissions a capability file grants.
fn core_granted(capability: &str) -> BTreeSet<String> {
    let json: Value = serde_json::from_str(&read(capability)).unwrap();
    json["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter(|p| p.starts_with("core:"))
        .map(str::to_string)
        .collect()
}

/// Whether any source file under `dir` (relative to the manifest) contains one of `needles`.
fn source_uses(dir: &str, needles: &[&str]) -> bool {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(dir);
    let mut pending = vec![root];
    while let Some(path) = pending.pop() {
        let entries =
            std::fs::read_dir(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let name = path.to_string_lossy();
            let is_source =
                (name.ends_with(".ts") || name.ends_with(".tsx")) && !name.contains(".test.");
            if !is_source {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            if needles.iter().any(|needle| text.contains(needle)) {
                return true;
            }
        }
    }
    false
}

#[test]
fn each_window_holds_the_menu_permissions_its_code_needs() {
    let needed = [
        "core:menu:allow-new",
        "core:menu:allow-popup",
        "core:resources:allow-close",
    ];
    let windows = [
        ("capabilities/settings.json", vec!["../src/settings"]),
        (
            "capabilities/main.json",
            vec!["../src/main", "../src/review"],
        ),
    ];
    for (capability, dirs) in windows {
        let uses_menus = dirs
            .iter()
            .any(|dir| source_uses(dir, &["PopUpButton", "popUpMenu"]));
        assert!(
            uses_menus,
            "{capability}: expected pop-up menu use in {dirs:?}"
        );
        let held = core_granted(capability);
        let missing: Vec<&str> = needed
            .iter()
            .copied()
            .filter(|permission| !held.contains(*permission))
            .collect();
        assert!(missing.is_empty(), "{capability} lacks {missing:?}");
    }
}
