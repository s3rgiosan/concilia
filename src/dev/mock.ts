// Browser preview backend. Loaded only by `npm run dev` outside Tauri, so the windows can be
// designed and checked in a plain browser. All names and data here are fabricated.
//
// Pick a scenario with `?mock=<name>`: first-run (default), configured, resume, applied, busy,
// update, read-only, load-error, run-error.

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { AppStateView, Draft, Missing, ReceiptMeta, ReviewData, Rule, RunEvent, Settings, Summary, Transaction, UpdateInfo } from "../lib/tauri";

const AVAILABLE_UPDATE: UpdateInfo = { version: "2.1.0", notes: "Fabricated release notes." };

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const SUMMARY: Summary = {
  totalTransactions: 42,
  matched: 31,
  review: 6,
  unmatched: 5,
  bankFees: 4,
  totalReceipts: 38,
  matchedReceipts: 27,
  reviewReceipts: 8,
  unmatchedReceipts: 3,
  matchRate: 74,
};

const ROOT = "/Users/example/Documents/Receipts";

function receipt(name: string, cents: number | null, vendor: string | null, date: string | null, currency: string | null = "EUR"): ReceiptMeta {
  return {
    file: `${ROOT}/2030/03/receipts/${name}`,
    amount_cents: cents,
    confidence: cents === null ? null : "high",
    currency,
    vendor,
    date,
    provider_used: cents === null ? "error" : "gemini",
    rel_path: `2030/03/receipts/${name}`,
  };
}

function tx(index: number, date: string, description: string, cents: number, status: Transaction["status"], meta: ReceiptMeta[], notes: string): Transaction {
  return {
    id: `tx-${String(index).padStart(3, "0")}-${date}-${cents}`,
    date,
    description,
    amount_cents: cents,
    abs_cents: Math.abs(cents),
    status,
    receipt_files: meta.map((m) => m.file),
    receipt_meta: meta,
    notes,
  };
}

function reviewData(): ReviewData {
  const acme = receipt("acme-invoice.pdf", 1000, "ACME Corp", "2030-03-01");
  const globexA = receipt("globex-a.pdf", 2500, "Globex", "2030-03-03");
  const globexB = receipt("globex-b.pdf", 2500, "Globex", "2030-03-20");
  const hooli = receipt("hooli.jpg", 4000, "Hooli", "2030-03-09");
  const initech = receipt("initech-usd.pdf", 5200, "Initech", "2030-03-11", "USD");
  const unreadable = receipt("scan-0001.pdf", null, null, null, null);
  return {
    transactions: [
      tx(1, "2030-03-01", "ACME CORP", -1000, "MATCHED", [acme], "name_amount_match"),
      tx(2, "2030-03-04", "GLOBEX ONLINE", -2500, "REVIEW", [globexA, globexB], "2 receipts match amount"),
      tx(3, "2030-03-05", "EXAMPLE FEE", -100, "MATCHED", [], "bank_fee"),
      tx(4, "2030-03-10", "HOOLI SERVICES", -4000, "UNMATCHED", [], ""),
      tx(5, "2030-03-12", "INITECH", -4800, "REVIEW", [initech], "fx_match (USD ±10%)"),
      tx(6, "2030-03-15", "TRANSFER FROM ACME", 50000, "UNMATCHED", [], ""),
    ],
    unmatched_receipts: [hooli, unreadable],
    reimbursements: [
      { ...receipt("taxi.pdf", 1250, "Taxi Co", "2030-03-07"), file: `${ROOT}/2030/03/reimbursements/taxi.pdf`, rel_path: "2030/03/reimbursements/taxi.pdf" },
    ],
  };
}

/** Replays a run's progress over a few seconds, stopping when `cancelled` turns true. */
async function replay(channel: Channel<RunEvent>, scan: boolean, cancelled: () => boolean): Promise<void> {
  const send = (event: RunEvent) => channel.onmessage(event);
  const steps: RunEvent[] = scan ? [] : [{ step: "parsing", count: 2 }];
  steps.push({ step: "receipts_found", count: 38 });
  for (let current = 0; current <= 38; current += 2) {
    steps.push({ step: "extracting", current, total: 38 });
  }
  steps.push({ step: "matching" }, { step: "reimbursements_found", count: 2 });
  steps.push({ step: "extracting_reimbursements", current: 0, total: 2 }, { step: "extracting_reimbursements", current: 2, total: 2 });
  if (!scan) {
    steps.push({ step: "exporting" });
  }
  for (const event of steps) {
    if (cancelled()) {
      throw { kind: "cancelled", message: "cancelled" };
    }
    send(event);
    await delay(event.step === "extracting" ? 120 : 400, null);
  }
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

  let cancelRequested = false;
  let draft: Draft = {};
  let finalized = scenario === "applied";
  mockConvertFileSrc("macos");

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
        case "period_status": {
          const exists = scenario === "resume" || scenario === "applied";
          return { exists, applied: finalized, has_transactions: exists, has_draft: Object.keys(draft).length > 0 };
        }
        case "get_review":
          return reviewData();
        case "get_draft":
          return draft;
        case "save_draft":
          draft = a.draft as Draft;
          return delay(150, null);
        case "delete_draft":
          draft = {};
          return null;
        case "finalize":
          draft = {};
          finalized = true;
          return delay(600, null);
        case "rescan_receipt":
        case "rescan_reimbursement": {
          const relPath = String(a.relPath);
          const all = [...reviewData().transactions.flatMap((t) => t.receipt_meta), ...reviewData().unmatched_receipts, ...reviewData().reimbursements];
          const found = all.find((r) => r.rel_path === relPath);
          return delay(900, found ? { ...found, amount_cents: found.amount_cents ?? 1500, confidence: "high", currency: found.currency ?? "EUR" } : null);
        }
        case "open_receipt":
          return null;
        case "pick_statements":
          return delay(300, ["/Users/example/Downloads/extrato-2030-03.pdf"]);
        case "reconcile":
        case "scan_receipts":
          cancelRequested = false;
          return (async () => {
            await replay(a.onEvent as Channel<RunEvent>, cmd === "scan_receipts", () => cancelRequested);
            if (scenario === "run-error") {
              throw { kind: "unauthorized", message: "token exchange failed (400)" };
            }
            return cmd === "scan_receipts"
              ? {
                  summary: SUMMARY,
                  dropped_decisions: [{ txId: "tx-003-2030-03-04--2500", description: "GLOBEX ONLINE", removedReceiptFiles: ["globex.pdf"] }],
                }
              : SUMMARY;
          })();
        case "cancel_run":
          cancelRequested = true;
          return true;
        case "export_report":
          return delay(300, "/Users/example/Documents/2030-03.xlsx");
        case "open_report":
        case "reveal_period":
          return null;
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
