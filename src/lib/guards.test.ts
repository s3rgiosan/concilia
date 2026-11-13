import { describe, expect, it } from "vitest";
import { makeView } from "../test/fixtures";
import { isAppStateView } from "./guards";

describe("isAppStateView", () => {
  it("accepts a full view", () => {
    expect(isAppStateView(makeView())).toBe(true);
  });

  it("accepts a view without a service account", () => {
    expect(isAppStateView(makeView({ service_account: null }))).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isAppStateView(null)).toBe(false);
    expect(isAppStateView(undefined)).toBe(false);
    expect(isAppStateView("view")).toBe(false);
    expect(isAppStateView([])).toBe(false);
  });

  it("rejects missing or malformed settings", () => {
    const view = makeView();
    expect(isAppStateView({ ...view, settings: undefined })).toBe(false);
    expect(isAppStateView({ ...view, settings: [] })).toBe(false);
    expect(isAppStateView({ ...view, settings: { ...view.settings, gemini: null } })).toBe(false);
  });

  it.each([
    ["missing", { missing: "receipts_root" }],
    ["configured", { configured: "yes" }],
    ["busy", { busy: 1 }],
    ["read_only", { read_only: null }],
    ["unreadable_files", { unreadable_files: "rules.json" }],
    ["service_account", { service_account: "reader@acme-test.iam.gserviceaccount.com" }],
    ["service_account (undefined)", { service_account: undefined }],
  ])("rejects a bad %s field", (_field, patch) => {
    expect(isAppStateView({ ...makeView(), ...patch })).toBe(false);
  });
});
