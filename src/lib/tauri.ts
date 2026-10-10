// Typed wrappers around the Tauri commands and events the windows use.

import { getVersion } from "@tauri-apps/api/app";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, ProgressBarStatus, UserAttentionType } from "@tauri-apps/api/window";
import { isAppStateView } from "./guards";

export type Language = "en" | "pt";

export interface GeminiSettings {
  /** Null uses the service account's own project. */
  project: string | null;
  location: string;
  model: string;
}

export interface Settings {
  /** Null follows the system language. */
  language: Language | null;
  receipts_root: string | null;
  gemini: GeminiSettings;
  check_for_updates: boolean;
}

export type Missing = "receipts_root" | "service_account" | "project";

export interface ServiceAccountInfo {
  client_email: string;
  project_id: string | null;
}

export interface AppStateView {
  settings: Settings;
  service_account: ServiceAccountInfo | null;
  /** Why the stored key cannot be read, when it cannot. */
  service_account_error: string | null;
  missing: Missing[];
  configured: boolean;
  busy: boolean;
  read_only: boolean;
}

export interface Rule {
  id: string;
  receiptVendor: string;
  transactionDescription: string;
}

export interface PopplerStatus {
  version: string;
  bundled: boolean;
}

export interface PeriodStatus {
  exists: boolean;
  applied: boolean;
  has_transactions: boolean;
  has_draft: boolean;
}

/** Where a month stands: no data, receipts or transactions found, matched, or finalized. */
export type PeriodState = "empty" | "ready" | "in_review" | "finalized";

/** A month folder under the receipts root, as `list_periods` reports it. */
export interface PeriodSummary {
  year: string;
  month: string;
  status: PeriodState;
  receipts: number;
  transactions: number;
  /** Transactions still needing a decision; only in review. */
  pending: number;
}

export type RunEvent =
  | { step: "parsing"; count: number }
  | { step: "receipts_found"; count: number }
  | { step: "extracting"; current: number; total: number }
  | { step: "matching" }
  | { step: "reimbursements_found"; count: number }
  | { step: "extracting_reimbursements"; current: number; total: number }
  | { step: "exporting" };

export interface Summary {
  totalTransactions: number;
  /** Matched transactions, bank fees included. */
  matched: number;
  review: number;
  unmatched: number;
  bankFees: number;
  totalReceipts: number;
  matchedReceipts: number;
  reviewReceipts: number;
  unmatchedReceipts: number;
  matchRate: number;
}

export interface DroppedDecision {
  txId: string;
  description: string;
  removedReceiptFiles: string[];
}

export interface ScanResult {
  summary: Summary;
  dropped_decisions: DroppedDecision[];
  /** Receipts read for the first time. */
  new_receipts: number;
  /** Transactions matched that were not before, bank fees included. */
  newly_matched: number;
}

export type Status = "MATCHED" | "REVIEW" | "UNMATCHED";

export interface ReceiptMeta {
  file: string;
  amount_cents: number | null;
  confidence: string | null;
  currency: string | null;
  vendor: string | null;
  date: string | null;
  provider_used: string | null;
  /** The file relative to the receipts root, for previews. Only in review data. */
  rel_path?: string | null;
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount_cents: number;
  abs_cents: number;
  status: Status;
  receipt_files: string[];
  receipt_meta: ReceiptMeta[];
  notes: string;
}

export type Bank = "cgd";

/** A bank statement whose transactions a month holds, oldest first. */
export interface StatementRecord {
  /** File name of the statement PDF. */
  file: string;
  bank: Bank;
  /** Transactions the statement added to the month. */
  transactions: number;
  /** ISO 8601 UTC timestamp. */
  added_at: string;
}

export interface ReviewData {
  transactions: Transaction[];
  unmatched_receipts: ReceiptMeta[];
  reimbursements: ReceiptMeta[];
  /** The statements the month holds; `get_review` always sends it. */
  statements?: StatementRecord[];
}

/** What one statement given to `add_statements` contributed. */
export interface StatementOutcome {
  file: string;
  bank: Bank;
  added: number;
  /** Rows skipped because the month already holds them. */
  skipped: number;
}

export interface AddStatementsResult {
  summary: Summary;
  /** New transactions added to the month. */
  added: number;
  duplicates_skipped: number;
  /** New transactions matched, bank fees included. */
  newly_matched: number;
  statements: StatementOutcome[];
  dropped_decisions: DroppedDecision[];
}

/** Pending review decisions: the transaction fields each decision overrides. */
export type Draft = Record<string, Partial<Transaction>>;

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** Download progress in bytes. `total` is null when the server sends no length. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateCheckResult {
  update: UpdateInfo | null;
  error: string | null;
}

export const SETTINGS_CHANGED_EVENT = "settings-changed";
export const BUSY_CHANGED_EVENT = "busy-changed";
export const MENU_EVENT = "menu";
export const UPDATE_PROGRESS_EVENT = "update-progress";
export const UPDATE_CHECK_RESULT_EVENT = "update-check-result";

export function getAppState(): Promise<AppStateView> {
  return invoke<AppStateView>("get_app_state");
}

export function saveSettings(settings: Settings): Promise<AppStateView> {
  return invoke<AppStateView>("save_settings", { settings });
}

/** The folder picked, or null when the dialog was cancelled. */
export function pickReceiptsRoot(): Promise<string | null> {
  return invoke<string | null>("pick_receipts_root");
}

/** The new state, or null when the dialog was cancelled. */
export function importServiceAccount(): Promise<AppStateView | null> {
  return invoke<AppStateView | null>("import_service_account");
}

export function removeServiceAccount(): Promise<AppStateView> {
  return invoke<AppStateView>("remove_service_account");
}

export function testGeminiConnection(): Promise<void> {
  return invoke("test_gemini_connection");
}

export function popplerStatus(): Promise<PopplerStatus> {
  return invoke<PopplerStatus>("poppler_status");
}

export function getRules(): Promise<Rule[]> {
  return invoke<Rule[]>("get_rules");
}

export function saveRules(rules: Rule[]): Promise<Rule[]> {
  return invoke<Rule[]>("save_rules", { rules });
}

export function periodStatus(year: string, month: string): Promise<PeriodStatus> {
  return invoke<PeriodStatus>("period_status", { year, month });
}

/** The month folders under the receipts root, newest first. */
export function listPeriods(): Promise<PeriodSummary[]> {
  return invoke<PeriodSummary[]>("list_periods");
}

/** Creates the month's folders and returns its entry for the month list. */
export function createPeriod(year: string, month: string): Promise<PeriodSummary> {
  return invoke<PeriodSummary>("create_period", { year, month });
}

/** The statement PDFs picked; empty when the dialog was cancelled. */
export function pickStatements(): Promise<string[]> {
  return invoke<string[]>("pick_statements");
}

export interface StatementInput {
  path: string;
  bank: string;
}

/** A reconcile or scan in progress: its result, and a way to stop it. */
export interface RunHandle<T> {
  promise: Promise<T>;
  cancel: () => Promise<boolean>;
}

function run<T>(command: string, year: string, month: string, args: Record<string, unknown>, onEvent: (event: RunEvent) => void): RunHandle<T> {
  const channel = new Channel<RunEvent>();
  channel.onmessage = onEvent;
  return {
    promise: invoke<T>(command, { year, month, ...args, onEvent: channel }),
    cancel: () => cancelRun(year, month),
  };
}

export function startReconcile(
  year: string,
  month: string,
  statements: StatementInput[],
  clearCache: boolean,
  onEvent: (event: RunEvent) => void,
): RunHandle<Summary> {
  return run<Summary>("reconcile", year, month, { statements, clearCache }, onEvent);
}

export function startScan(year: string, month: string, onEvent: (event: RunEvent) => void): RunHandle<ScanResult> {
  return run<ScanResult>("scan_receipts", year, month, {}, onEvent);
}

/** Adds statements to a month in review, keeping its transaction IDs and review draft. */
export function startAddStatements(
  year: string,
  month: string,
  statements: StatementInput[],
  onEvent: (event: RunEvent) => void,
): RunHandle<AddStatementsResult> {
  return run<AddStatementsResult>("add_statements", year, month, { statements }, onEvent);
}

/** Stops the month's running job. Resolves to whether one was running. */
export function cancelRun(year: string, month: string): Promise<boolean> {
  return invoke<boolean>("cancel_run", { year, month });
}

export function getReview(year: string, month: string): Promise<ReviewData> {
  return invoke<ReviewData>("get_review", { year, month });
}

export function getDraft(year: string, month: string): Promise<Draft> {
  return invoke<Draft>("get_draft", { year, month });
}

export function saveDraft(year: string, month: string, draft: Draft): Promise<void> {
  return invoke("save_draft", { year, month, draft });
}

export function deleteDraft(year: string, month: string): Promise<void> {
  return invoke("delete_draft", { year, month });
}

export function finalize(year: string, month: string): Promise<void> {
  return invoke("finalize", { year, month });
}

export function rescanReceipt(year: string, month: string, relPath: string): Promise<ReceiptMeta> {
  return invoke<ReceiptMeta>("rescan_receipt", { year, month, relPath });
}

export function rescanReimbursement(year: string, month: string, relPath: string): Promise<ReceiptMeta> {
  return invoke<ReceiptMeta>("rescan_reimbursement", { year, month, relPath });
}

/** The path the report was saved to, or null when the dialog was cancelled. */
export function exportReport(year: string, month: string): Promise<string | null> {
  return invoke<string | null>("export_report", { year, month });
}

export function openReport(year: string, month: string): Promise<void> {
  return invoke("open_report", { year, month });
}

export function openReceipt(year: string, month: string, relPath: string): Promise<void> {
  return invoke("open_receipt", { year, month, relPath });
}

export function revealPeriod(year: string, month: string): Promise<void> {
  return invoke("reveal_period", { year, month });
}

/** Opens the help on creating a Gemini service account key in the browser. */
export function openKeyHelp(): Promise<void> {
  return invoke("open_key_help");
}

export function openSettings(): Promise<void> {
  return invoke("open_settings");
}

export function checkForUpdates(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_for_updates");
}

export function pendingUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("pending_update");
}

/** Downloads and installs the pending update; the app relaunches when it succeeds. */
export function installUpdate(): Promise<void> {
  return invoke("install_update");
}

/** Sets the title of the window this page runs in, as the Window menu and Mission Control show it. */
export function setWindowTitle(title: string): Promise<void> {
  return getCurrentWindow().setTitle(title);
}

/** Resizes the window this page runs in to a content size in logical pixels. */
export function setWindowSize(width: number, height: number): Promise<void> {
  return getCurrentWindow().setSize(new LogicalSize(width, height));
}

/**
 * Shows a run's progress on the Dock icon: a percentage (0 to 100), "indeterminate" before the
 * first count is known, or null to clear it.
 */
export function setDockProgress(progress: number | "indeterminate" | null): Promise<void> {
  const window = getCurrentWindow();
  if (progress === null) {
    return window.setProgressBar({ status: ProgressBarStatus.None });
  }
  if (progress === "indeterminate") {
    return window.setProgressBar({ status: ProgressBarStatus.Indeterminate });
  }
  const percent = Math.min(100, Math.max(0, Math.round(progress)));
  return window.setProgressBar({ status: ProgressBarStatus.Normal, progress: percent });
}

/** Bounces the Dock icon once. */
export function requestAttention(): Promise<void> {
  return getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
}

/** Rebuilds the menu bar with these labels, by the keys in src-tauri/src/menu.rs. */
export function setMenu(labels: Record<string, string>): Promise<void> {
  return invoke("set_menu", { labels });
}

/** Enables or disables menu items by id; ids not in the map keep their state. */
export function setMenuState(enabled: Record<string, boolean>): Promise<void> {
  return invoke("set_menu_state", { enabled });
}

export function appVersion(): Promise<string> {
  return getVersion();
}

/** URL of a receipt file served by the `receipt://` scheme, from its path relative to the receipts root. */
export function receiptUrl(relativePath: string): string {
  return convertFileSrc(relativePath, "receipt");
}

export function onSettingsChanged(handler: (view: AppStateView) => void): Promise<UnlistenFn> {
  return listen<unknown>(SETTINGS_CHANGED_EVENT, (event) => {
    if (isAppStateView(event.payload)) {
      handler(event.payload);
    } else {
      console.error("ignoring malformed settings-changed payload");
    }
  });
}

export function onBusyChanged(handler: (busy: boolean) => void): Promise<UnlistenFn> {
  return listen<{ busy?: unknown }>(BUSY_CHANGED_EVENT, (event) => handler(event.payload?.busy === true));
}

/** Listens for menu items chosen in the menu bar; the handler receives the item's id. */
export function onMenu(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<{ id?: unknown }>(MENU_EVENT, (event) => {
    const id = event.payload?.id;
    if (typeof id === "string") {
      handler(id);
    } else {
      console.error("ignoring malformed menu payload");
    }
  });
}

export function onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (event) => handler(event.payload));
}

export function onUpdateCheckResult(handler: (result: UpdateCheckResult) => void): Promise<UnlistenFn> {
  return listen<UpdateCheckResult>(UPDATE_CHECK_RESULT_EVENT, (event) => handler(event.payload));
}

/**
 * Turns a pending listener registration into a cleanup function for `useEffect`. A listener
 * that registers after cleanup is removed at once.
 */
export function subscribe(registration: Promise<UnlistenFn>): () => void {
  let cancelled = false;
  let unlisten: UnlistenFn | undefined;
  registration
    .then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch((e) => console.error("could not register event listener", e));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
