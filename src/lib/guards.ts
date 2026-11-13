// Shape checks for event payloads, which arrive untyped.

import type { AppStateView } from "./tauri";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a payload has the fields the windows read from an `AppStateView`. */
export function isAppStateView(value: unknown): value is AppStateView {
  if (!isObject(value) || !isObject(value.settings) || !isObject(value.settings.gemini)) {
    return false;
  }
  return (
    Array.isArray(value.missing) &&
    typeof value.configured === "boolean" &&
    typeof value.busy === "boolean" &&
    typeof value.read_only === "boolean" &&
    Array.isArray(value.unreadable_files) &&
    Array.isArray(value.reasons) &&
    (value.service_account === null || isObject(value.service_account))
  );
}
