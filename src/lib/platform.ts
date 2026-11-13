// The Tauri CLI sets TAURI_ENV_PLATFORM for the frontend build: `darwin`, `linux` or `windows`.
// The browser preview and the tests have none and follow macOS.
const PLATFORM: string = import.meta.env.TAURI_ENV_PLATFORM ?? "darwin";

/** Whether this build runs on macOS. */
export const IS_MACOS = PLATFORM === "darwin";
