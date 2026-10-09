// Browser preview backend. Loaded only by `npm run dev` outside Tauri, so the windows can be
// designed and checked in a plain browser. All names and data here are fabricated.
//
// Pick a scenario with `?mock=<name>`: first-run (default), configured, busy, update, read-only,
// load-error.

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppStateView, Missing, Rule, Settings, UpdateInfo } from "../lib/tauri";

const AVAILABLE_UPDATE: UpdateInfo = { version: "2.1.0", notes: "Fabricated release notes." };

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function install(): void {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("mock") ?? "first-run";
  (window as unknown as Record<string, unknown>).__CONCILIA_PREVIEW__ = true;

  const configured = scenario !== "first-run" && scenario !== "load-error";
  let settings: Settings = {
    language: null,
    receipts_root: configured ? "/Users/example/Documents/Receipts" : null,
    gemini: { project: null, location: "europe-west1", model: "gemini-2.5-flash" },
    check_for_updates: true,
  };
  let account = configured ? { client_email: "reader@acme-test.iam.gserviceaccount.com", project_id: "acme-test" } : null;
  let rules: Rule[] = configured
    ? [
        { id: "rule-1", receiptVendor: "ACME", transactionDescription: "ACME CORP" },
        { id: "rule-2", receiptVendor: "globex", transactionDescription: "GLOBEX ONLINE" },
      ]
    : [];

  function view(): AppStateView {
    const missing: Missing[] = [];
    if (!settings.receipts_root) {
      missing.push("receipts_root");
    }
    if (!account) {
      missing.push("service_account");
    } else if (!settings.gemini.project && !account.project_id) {
      missing.push("project");
    }
    return {
      settings,
      service_account: account,
      service_account_error: null,
      missing,
      configured: missing.length === 0,
      busy: scenario === "busy",
      read_only: scenario === "read-only",
    };
  }

  function changed(): AppStateView {
    const next = view();
    emit("settings-changed", next);
    return next;
  }

  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "get_app_state":
          if (scenario === "load-error") {
            return Promise.reject({ kind: "io", message: "config.json: permission denied" });
          }
          return view();
        case "save_settings":
          settings = a.settings as Settings;
          return changed();
        case "pick_receipts_root":
          return delay(300, "/Users/example/Documents/Receipts");
        case "import_service_account":
          account = { client_email: "reader@acme-test.iam.gserviceaccount.com", project_id: "acme-test" };
          return delay(300, changed());
        case "remove_service_account":
          account = null;
          return delay(300, changed());
        case "test_gemini_connection":
          return delay(900, null);
        case "poppler_status":
          return { version: "26.04.0", bundled: true };
        case "get_rules":
          return rules;
        case "save_rules":
          rules = a.rules as Rule[];
          return delay(200, rules);
        case "open_settings":
          window.open(`${window.location.pathname}?view=settings&mock=${scenario}`, "settings", "width=640,height=560");
          return null;
        case "plugin:app|version":
          return "2.0.0";
        case "pending_update":
          return scenario === "update" ? AVAILABLE_UPDATE : null;
        case "check_for_updates":
          return delay(800, scenario === "update" ? AVAILABLE_UPDATE : null);
        case "install_update":
          return (async () => {
            const total = 1_000_000;
            for (let downloaded = 0; downloaded <= total; downloaded += 250_000) {
              await emit("update-progress", { downloaded, total });
              await delay(400, null);
            }
            return null;
          })();
        default:
          console.info("[mock] invoke", cmd, args);
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}
