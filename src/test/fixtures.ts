// Fabricated backend data for tests.

import type { AppStateView, PeriodStatus, ReceiptMeta, ReviewData, Rule, ServiceAccountInfo, Settings, Transaction } from "../lib/tauri";

export const ACCOUNT: ServiceAccountInfo = {
  client_email: "reader@acme-test.iam.gserviceaccount.com",
  project_id: "acme-test",
};

export function makeSettings(patch: Partial<Settings> = {}): Settings {
  return {
    language: null,
    receipts_root: "/Users/example/Receipts",
    gemini: { project: null, location: "europe-west1", model: "gemini-2.5-flash" },
    check_for_updates: true,
    ...patch,
  };
}

export function makeView(patch: Partial<AppStateView> = {}): AppStateView {
  return {
    settings: makeSettings(),
    service_account: ACCOUNT,
    service_account_error: null,
    missing: [],
    configured: true,
    busy: false,
    read_only: false,
    ...patch,
  };
}

export function makeRule(patch: Partial<Rule> = {}): Rule {
  return { id: "rule-1", receiptVendor: "acme", transactionDescription: "acme corp", ...patch };
}

/** A promise with its settle functions exposed, for controlling when a mocked command finishes. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A receipt in March 2030, with its preview path. */
export function makeReceipt(name: string, patch: Partial<ReceiptMeta> = {}): ReceiptMeta {
  return {
    file: `/receipts/2030/03/receipts/${name}`,
    amount_cents: 1000,
    confidence: "high",
    currency: "EUR",
    vendor: null,
    date: "2030-03-05",
    provider_used: "gemini",
    rel_path: `2030/03/receipts/${name}`,
    ...patch,
  };
}

export function makeTransaction(id: string, patch: Partial<Transaction> = {}): Transaction {
  const amount = patch.amount_cents ?? -1000;
  const receipts = patch.receipt_meta ?? [];
  return {
    id,
    date: "2030-03-05",
    description: "ACME CORP",
    amount_cents: amount,
    abs_cents: Math.abs(amount),
    status: "UNMATCHED",
    receipt_files: receipts.map((r) => r.file),
    receipt_meta: receipts,
    notes: "",
    ...patch,
  };
}

export function makeReviewData(patch: Partial<ReviewData> = {}): ReviewData {
  return { transactions: [], unmatched_receipts: [], reimbursements: [], ...patch };
}

export function makePeriodStatus(patch: Partial<PeriodStatus> = {}): PeriodStatus {
  return { exists: true, applied: false, has_transactions: true, has_draft: false, ...patch };
}
