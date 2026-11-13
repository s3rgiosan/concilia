// Browser preview backend. Loaded only by `npm run dev` outside Tauri, so the windows can be
// designed and checked in a plain browser. All names and data here are fabricated.
//
// Pick a scenario with `?mock=<name>`: first-run (default), configured, resume, applied, busy,
// update, read-only, unreadable-files (rules.json does not parse), load-error, run-error, slow, refused (a month in review with two files Concilia
// can't read). run-error fails every reconcile, scan and added
// statement; slow reads one receipt every two seconds. `?lang=en|pt` saves that language in the
// settings. `?accent=<rrggbb>` and `?reduce-transparency=1` stand in for the system settings the
// app reads natively.

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type {
  AddStatementsResult,
  AlertChoice,
  AlertRequest,
  AppStateView,
  Draft,
  Missing,
  PeriodState,
  PeriodSummary,
  Reason,
  ReceiptMeta,
  RefusedFile,
  ReviewData,
  Rule,
  RunEvent,
  Settings,
  Summary,
  Transaction,
  UpdateInfo,
} from "../lib/tauri";
import { mergeDraft, relPaths } from "../review/effective";

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

const REFUSED_FILES: RefusedFile[] = [
  { file: `${ROOT}/2030/03/receipts/scan-archive.pdf`, rel_path: "2030/03/receipts/scan-archive.pdf", code: "file_too_large" },
  { file: `${ROOT}/2030/03/receipts/notes.pdf`, rel_path: "2030/03/receipts/notes.pdf", code: "unrecognized_file" },
];

/** The transactions an Add Statements run brings in: two matched and one that needs a decision. */
function addedTransactions(): Transaction[] {
  const globexC = receipt("globex-c.pdf", 1500, "Globex", "2030-03-20");
  const shop = receipt("example-shop.pdf", 900, "Example Shop", "2030-03-22");
  return [
    tx(8, "2030-03-20", "GLOBEX ONLINE", -1500, "MATCHED", [globexC], "name_amount_match"),
    tx(9, "2030-03-22", "EXAMPLE SHOP", -900, "MATCHED", [shop], "name_amount_match"),
    tx(10, "2030-03-25", "HOOLI CAFE", -1800, "UNMATCHED", [], ""),
  ];
}

/** The review data of the sample month; `withAdded` includes the transactions of an added statement. */
function reviewData(withAdded = false): ReviewData {
  const acme = receipt("acme-invoice.pdf", 1000, "ACME Corp", "2030-03-01");
  const globexA = receipt("globex-a.pdf", 2500, "Globex", "2030-03-03");
  const globexB = receipt("globex-b.pdf", 2500, "Globex", "2030-03-20");
  const hooli = receipt("hooli.jpg", 4000, "Hooli", "2030-03-09");
  const initech = receipt("initech-usd.pdf", 5200, "Initech", "2030-03-11", "USD");
  const unreadable = receipt("scan-0001.pdf", null, null, null, null);
  const contosoMeal = receipt("contoso-meal.pdf", 1950, "Contoso Kitchen", "2030-03-17");
  const contosoDelivery = receipt("contoso-delivery.pdf", 400, "Contoso Delivery", "2030-03-17");
  return {
    transactions: [
      tx(1, "2030-03-01", "ACME CORP", -1000, "MATCHED", [acme], "name_amount_match"),
      tx(2, "2030-03-04", "GLOBEX ONLINE", -2500, "REVIEW", [globexA, globexB], "2 receipts match amount"),
      tx(3, "2030-03-05", "EXAMPLE FEE", -100, "MATCHED", [], "bank_fee"),
      tx(4, "2030-03-10", "HOOLI SERVICES", -4000, "UNMATCHED", [], ""),
      tx(5, "2030-03-12", "INITECH", -4800, "REVIEW", [initech], "fx_match (USD ±10%)"),
      tx(6, "2030-03-15", "TRANSFER FROM ACME", 50000, "UNMATCHED", [], ""),
      tx(7, "2030-03-17", "CONTOSO DELIVERY", -2350, "MATCHED", [contosoMeal, contosoDelivery], "manual_match"),
      ...(withAdded ? addedTransactions() : []),
    ],
    unmatched_receipts: [hooli, unreadable],
    refused_files: [],
    reimbursements: [
      { ...receipt("taxi.pdf", 1250, "Taxi Co", "2030-03-07"), file: `${ROOT}/2030/03/reimbursements/taxi.pdf`, rel_path: "2030/03/reimbursements/taxi.pdf" },
    ],
  };
}

/** Transactions still needing a decision once `draft` applies, as the backend counts them. */
function pendingWith(draft: Draft, withAdded = false): number {
  return reviewData(withAdded).transactions.filter((t) => (draft[t.id]?.status ?? t.status) !== "MATCHED").length;
}

/** An SVG page standing in for a receipt file, titled with its file name. */
function placeholderPage(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lines = Array.from({ length: 6 }, (_, i) => `<rect x="60" y="${200 + i * 36}" width="${380 - (i % 3) * 70}" height="12" rx="6" fill="#d8d8dc"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842"><rect width="595" height="842" fill="#fff"/><text x="60" y="120" font-family="-apple-system, sans-serif" font-size="28" font-weight="600" fill="#1d1d1f">${name}</text><text x="60" y="160" font-family="-apple-system, sans-serif" font-size="16" fill="#8e8e93">Sample receipt</text>${lines}<rect x="60" y="460" width="475" height="1" fill="#c7c7cc"/><text x="60" y="500" font-family="-apple-system, sans-serif" font-size="18" fill="#1d1d1f">Total</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** "2030-03" for the month `offset` months before `now`. */
function monthKey(now: Date, offset: number): string {
  const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month folders the receipts root holds, keyed "YYYY-MM", relative to today so the previous
 * month is always the first. `resume` and `applied` put the previous month in review or
 * finalized; the other configured scenarios leave it with receipts waiting for statements.
 */
function initialPeriods(scenario: string, now: Date): Map<string, PeriodSummary> {
  const first: Record<string, PeriodState> = { resume: "in_review", refused: "in_review", applied: "finalized" };
  const rows: [number, PeriodState, number, number, number][] = [
    [1, first[scenario] ?? "ready", 38, first[scenario] ? reviewData().transactions.length : 0, scenario === "resume" ? pendingWith({}) : 0],
    [2, "in_review", 31, 40, 4],
    [3, "finalized", 27, 35, 0],
    [4, "finalized", 22, 30, 0],
    [10, "finalized", 19, 28, 0],
    [13, "empty", 0, 0, 0],
  ];
  const periods = new Map<string, PeriodSummary>();
  for (const [offset, status, receipts, transactions, pending] of rows) {
    const key = monthKey(now, offset);
    const [year, month] = key.split("-");
    periods.set(key, { year, month, status, receipts, transactions, pending });
  }
  return periods;
}

/**
 * Replays a run's progress over a few seconds, stopping when `cancelled` turns true. With
 * `failsAt` the run throws `error` as soon as that step is reported.
 */
async function replay(
  channel: Channel<RunEvent>,
  kind: "reconcile" | "scan" | "add",
  cancelled: () => boolean,
  options: { slow?: boolean; statements?: number; failsAt?: RunEvent["step"]; error?: unknown } = {},
): Promise<void> {
  const { slow = false, statements = 1, failsAt, error } = options;
  const send = (event: RunEvent) => channel.onmessage(event);
  const steps: RunEvent[] = kind === "scan" ? [] : [{ step: "parsing", count: statements }];
  steps.push({ step: "receipts_found", count: 38 });
  const stride = slow ? 1 : 2;
  for (let current = 0; current <= 38; current += stride) {
    steps.push({ step: "extracting", current, total: 38 });
  }
  steps.push({ step: "matching" }, { step: "reimbursements_found", count: 2 });
  steps.push({ step: "extracting_reimbursements", current: 0, total: 2 }, { step: "extracting_reimbursements", current: 2, total: 2 });
  if (kind === "reconcile") {
    steps.push({ step: "exporting" });
  }
  for (const event of steps) {
    if (cancelled()) {
      throw { kind: "cancelled", message: "cancelled" };
    }
    send(event);
    if (event.step === failsAt) {
      throw error;
    }
    const extractDelay = slow ? 2000 : 120;
    await delay(event.step === "extracting" ? extractDelay : 400, null);
  }
}

/**
 * Stands in for the native alert sheet: a modal dialog with the default button, the optional
 * alternate button and Cancel. Resolves with the button chosen.
 */
function inPageAlert(request: AlertRequest): Promise<AlertChoice> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("role", "alertdialog");
    dialog.style.cssText = "max-width:340px;padding:20px;border:0.5px solid rgb(128 128 128 / 40%);border-radius:12px;font:13px -apple-system,sans-serif;";
    const title = document.createElement("strong");
    title.textContent = request.title;
    const message = document.createElement("p");
    message.textContent = request.message;
    message.style.cssText = "white-space:pre-wrap;margin:8px 0 16px;";
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    const finish = (choice: AlertChoice) => {
      dialog.close();
      dialog.remove();
      resolve(choice);
    };
    const choices: [string | undefined, AlertChoice][] = [
      [request.confirm, "confirm"],
      [request.alternate ?? undefined, "alternate"],
      [request.cancel, "cancel"],
    ];
    for (const [label, choice] of choices) {
      if (label) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => finish(choice));
        buttons.append(button);
      }
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(request.cancel ? "cancel" : "confirm");
    });
    dialog.append(title, message, buttons);
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function install(): void {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("mock") ?? "first-run";
  (window as unknown as Record<string, unknown>).__CONCILIA_PREVIEW__ = true;

  const configured = scenario !== "first-run" && scenario !== "load-error";
  const lang = params.get("lang");
  let settings: Settings = {
    language: lang === "en" || lang === "pt" ? lang : null,
    receipts_root: configured ? "/Users/example/Documents/Receipts" : null,
    gemini: { project: null, location: "europe-west1", model: "gemini-2.5-flash" },
    check_for_updates: true,
  };
  let account = configured ? { client_email: "reader@acme-test.iam.gserviceaccount.com", project_id: "acme-test" } : null;
  let rules: Rule[] = configured
    ? [
        { id: "rule-1", receiptVendor: "ACME", transactionDescription: "ACME CORP" },
        { id: "rule-2", receiptVendor: "globex", transactionDescription: "GLOBEX ONLINE" },
        { id: "rule-3", receiptVendor: "", transactionDescription: "TRF MBWAY", noReceipt: "transfer" },
      ]
    : [];

  const reason = (id: string, en: string, pt: string): Reason => ({ id, names: { en, pt } });
  let reasons: Reason[] = [
    reason("bank_fee", "Bank Fee", "Comissão bancária"),
    reason("salary", "Salary", "Salário"),
    reason("transfer", "Transfer", "Transferência"),
    reason("refund", "Refund", "Reembolso"),
    reason("reason:sample-lunch", "Team Lunch", ""),
    reason("no_receipt", "Other", "Outro"),
  ];

  let cancelRequested = false;
  let draft: Draft = {};
  /** Whether Add Statements ran, so the review holds the added statement's transactions. */
  let withAdded = false;
  /** The transactions as finalized, with the decisions applied; null while the month is open. */
  let settled: Transaction[] | null = null;
  /** The decisions finalize applied, which reopen puts back. */
  let kept: Draft = {};
  const periods = initialPeriods(scenario, new Date());

  /** The review data as it stands: the original, or the finalized result. */
  function currentReview(): ReviewData {
    const data = reviewData(withAdded);
    return settled ? { ...data, transactions: settled } : data;
  }

  /** Sets the status of the month named by `args`, creating its entry when it has none. */
  function setPeriod(a: Record<string, unknown>, patch: Partial<PeriodSummary>) {
    const year = String(a.year);
    const month = String(a.month);
    const key = `${year}-${month}`;
    const current = periods.get(key) ?? { year, month, status: "empty", receipts: 0, transactions: 0, pending: 0 };
    periods.set(key, { ...current, ...patch });
  }
  mockConvertFileSrc("macos");
  // The browser has no receipt:// scheme, so previews there show a drawn placeholder page.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (path: string, protocol: string) => string } }).__TAURI_INTERNALS__;
  internals.convertFileSrc = (path, protocol) => (protocol === "receipt" ? placeholderPage(path) : `${protocol}://localhost/${path}`);

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
      unreadable_files: scenario === "unreadable-files" ? ["rules.json does not parse: expected value at line 1 column 2"] : [],
      reasons,
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
          emit("rules-changed");
          return delay(200, rules);
        case "save_reasons": {
          reasons = a.reasons as Reason[];
          const other = "no_receipt";
          rules = rules.map((r) => (r.noReceipt && !reasons.some((x) => x.id === r.noReceipt) ? { ...r, noReceipt: other } : r));
          emit("rules-changed");
          return delay(200, changed());
        }
        case "list_periods":
          return delay(150, [...periods.values()].sort((a, b) => `${b.year}${b.month}`.localeCompare(`${a.year}${a.month}`)));
        case "period_status": {
          const status = periods.get(`${String(a.year)}-${String(a.month)}`)?.status ?? "empty";
          const exists = status === "in_review" || status === "finalized";
          return { exists, applied: status === "finalized", has_transactions: exists, has_draft: Object.keys(draft).length > 0 };
        }
        case "get_review":
          return {
            ...currentReview(),
            statements: [
              { file: "extrato-2030-03.pdf", bank: "cgd", transactions: 7, added_at: "2030-04-01T09:00:00Z" },
              ...(withAdded ? [{ file: "extrato-2030-03-b.pdf", bank: "cgd" as const, transactions: addedTransactions().length, added_at: "2030-04-02T09:00:00Z" }] : []),
            ],
            refused_files: scenario === "refused" ? REFUSED_FILES : [],
          };
        case "get_draft":
          return draft;
        case "save_draft":
          draft = a.draft as Draft;
          setPeriod(a, { pending: pendingWith(draft, withAdded) });
          return delay(150, null);
        case "finalize": {
          const data = reviewData(withAdded);
          settled = mergeDraft(data.transactions, draft, relPaths(data));
          kept = draft;
          draft = {};
          setPeriod(a, { status: "finalized", pending: 0 });
          return delay(600, null);
        }
        case "reopen":
          draft = kept;
          kept = {};
          settled = null;
          setPeriod(a, { status: "in_review", pending: pendingWith(draft, withAdded) });
          return delay(400, { restored: 27, keptDecisions: Object.keys(draft).length });
        case "rescan_receipt":
        case "rescan_reimbursement": {
          const relPath = String(a.relPath);
          const data = reviewData(withAdded);
          const all = [...data.transactions.flatMap((t) => t.receipt_meta), ...data.unmatched_receipts, ...data.reimbursements];
          const found = all.find((r) => r.rel_path === relPath);
          return delay(900, found ? { ...found, amount_cents: found.amount_cents ?? 1500, confidence: "high", currency: found.currency ?? "EUR" } : null);
        }
        case "open_receipt":
          return null;
        case "pick_statements":
          return delay(300, ["/Users/example/Downloads/extrato-2030-03-b.pdf"]);
        case "reconcile":
        case "scan_receipts":
          cancelRequested = false;
          return (async () => {
            const runError = scenario === "run-error";
            await replay(a.onEvent as Channel<RunEvent>, cmd === "scan_receipts" ? "scan" : "reconcile", () => cancelRequested, {
              slow: scenario === "slow",
              statements: Array.isArray(a.statements) ? a.statements.length : 1,
              failsAt: runError ? "extracting" : undefined,
              error: { kind: "unauthorized", message: "token exchange failed (400)" },
            });
            const summary = { ...SUMMARY, totalTransactions: reviewData(withAdded).transactions.length };
            setPeriod(a, {
              status: "in_review",
              receipts: SUMMARY.totalReceipts,
              transactions: summary.totalTransactions,
              pending: pendingWith(draft, withAdded),
            });
            return cmd === "scan_receipts"
              ? {
                  summary,
                  dropped_decisions: [{ txId: "tx-003-2030-03-04--2500", description: "GLOBEX ONLINE", removedReceiptFiles: ["globex.pdf"] }],
                  new_receipts: 3,
                  newly_matched: 1,
                }
              : summary;
          })();
        case "add_statements":
          cancelRequested = false;
          return (async (): Promise<AddStatementsResult> => {
            await replay(a.onEvent as Channel<RunEvent>, "add", () => cancelRequested, {
              statements: Array.isArray(a.statements) ? a.statements.length : 1,
              failsAt: scenario === "run-error" ? "parsing" : undefined,
              error: { kind: "parse", message: "no rows match the CGD layout" },
            });
            withAdded = true;
            const total = reviewData(true).transactions.length;
            setPeriod(a, { transactions: total, pending: pendingWith(draft, true) });
            return {
              summary: { ...SUMMARY, totalTransactions: total, matched: SUMMARY.matched + 2, unmatched: SUMMARY.unmatched + 1 },
              added: 3,
              duplicates_skipped: 1,
              newly_matched: 2,
              statements: [{ file: "extrato-2030-03-b.pdf", bank: "cgd", added: 3, skipped: 1 }],
              dropped_decisions: [],
            };
          })();
        case "period_summary":
          return delay(100, periods.get(`${String(a.year)}-${String(a.month)}`) ?? { year: String(a.year), month: String(a.month), status: "empty", receipts: 0, transactions: 0, pending: 0 });
        case "set_menu":
        case "set_menu_state":
        case "set_menu_item_text":
          return null;
        case "create_period":
          setPeriod(a, {});
          return delay(150, periods.get(`${String(a.year)}-${String(a.month)}`));
        case "cancel_run":
          cancelRequested = true;
          return true;
        case "export_report":
          return delay(300, "/Users/example/Documents/2030-03.xlsx");
        case "open_report":
        case "reveal_period":
        case "open_key_help":
          return null;
        case "open_settings":
          window.open(`${window.location.pathname}?view=settings&mock=${scenario}`, "settings", "width=640,height=560");
          return null;
        case "get_appearance":
          return {
            accent: /^[0-9a-f]{6}$/i.test(params.get("accent") ?? "") ? `#${params.get("accent")}` : null,
            reduce_transparency: params.get("reduce-transparency") === "1",
          };
        case "show_alert": {
          return inPageAlert(a.request as AlertRequest);
        }
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

  // The mock event bus looks a listener up by `id`, but unlisten sends `eventId`, so a removed
  // listener would stay registered and its callback would be missing when the next event fires.
  const ipc = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const invokeMock = ipc.invoke;
  ipc.invoke = (cmd, args, options) =>
    invokeMock(cmd, cmd === "plugin:event|unlisten" && args ? { ...args, id: args.eventId } : args, options);
}
