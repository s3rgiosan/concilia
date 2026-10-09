// Fabricated backend data for tests.

import type { AppStateView, Rule, ServiceAccountInfo, Settings } from "../lib/tauri";

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
