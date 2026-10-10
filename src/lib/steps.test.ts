import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { buildSteps, type RunKind, type RunOutcome, type Step } from "./steps";
import type { RunEvent } from "./tauri";

function build(kind: RunKind, events: RunEvent[], outcome: RunOutcome = null): Step[] {
  return buildSteps(kind, events, outcome, i18n.t);
}

function statuses(steps: Step[]): Record<string, Step["status"]> {
  return Object.fromEntries(steps.map((s) => [s.id, s.status]));
}

function step(steps: Step[], id: Step["id"]): Step {
  const found = steps.find((s) => s.id === id);
  if (!found) {
    throw new Error(`no step ${id}`);
  }
  return found;
}

describe("buildSteps", () => {
  it("lists every reconcile step as pending before any event", () => {
    const steps = build("reconcile", []);
    expect(steps.map((s) => [s.id, s.label, s.status])).toEqual([
      ["parse", "Reading statements", "pending"],
      ["receipts", "Scanning receipts", "pending"],
      ["extract", "Extracting receipt data", "pending"],
      ["match", "Matching receipts", "pending"],
      ["reimbursements", "Reading reimbursements", "pending"],
      ["export", "Generating report", "pending"],
    ]);
  });

  it("leaves parsing and export out of a scan", () => {
    expect(build("scan", []).map((s) => s.id)).toEqual(["receipts", "extract", "match", "reimbursements"]);
  });

  it("counts the statements being parsed", () => {
    const two = build("reconcile", [{ step: "parsing", count: 2 }]);
    expect(step(two, "parse")).toMatchObject({ status: "running", detail: "2 files" });
    expect(statuses(two)).toMatchObject({ receipts: "pending", export: "pending" });
    expect(step(build("reconcile", [{ step: "parsing", count: 1 }]), "parse").detail).toBe("1 file");
  });

  it("notes the saved transactions when no statement is parsed", () => {
    expect(step(build("reconcile", [{ step: "parsing", count: 0 }]), "parse").detail).toBe("using the saved transactions");
  });

  it("has no parsing step to annotate in a scan", () => {
    const steps = build("scan", [{ step: "parsing", count: 2 }]);
    expect(steps.map((s) => s.id)).not.toContain("parse");
    expect(steps.every((s) => s.detail === undefined)).toBe(true);
  });

  it("counts the receipts found and moves on to extraction", () => {
    const steps = build("reconcile", [
      { step: "parsing", count: 2 },
      { step: "receipts_found", count: 38 },
    ]);
    expect(statuses(steps)).toMatchObject({ parse: "done", receipts: "done", extract: "running", match: "pending" });
    expect(step(steps, "receipts").detail).toBe("38 found");
  });

  it("shows extraction progress while extracting", () => {
    const steps = build("scan", [
      { step: "receipts_found", count: 38 },
      { step: "extracting", current: 4, total: 38 },
    ]);
    expect(step(steps, "extract")).toMatchObject({ status: "running", detail: "4 / 38", progress: { current: 4, total: 38 } });
  });

  it("drops the extraction progress once matching starts", () => {
    const steps = build("reconcile", [
      { step: "parsing", count: 1 },
      { step: "receipts_found", count: 10 },
      { step: "extracting", current: 10, total: 10 },
      { step: "matching" },
    ]);
    expect(statuses(steps)).toMatchObject({ extract: "done", match: "running", reimbursements: "pending" });
    expect(step(steps, "extract").progress).toBeUndefined();
    expect(step(steps, "extract").detail).toBe("10 / 10");
  });

  it("follows the reimbursements", () => {
    const found = build("reconcile", [{ step: "matching" }, { step: "reimbursements_found", count: 5 }]);
    expect(step(found, "reimbursements")).toMatchObject({ status: "running", detail: "5 found" });
    expect(step(found, "match").status).toBe("done");

    const reading = build("reconcile", [
      { step: "reimbursements_found", count: 5 },
      { step: "extracting_reimbursements", current: 2, total: 5 },
    ]);
    expect(step(reading, "reimbursements")).toMatchObject({ detail: "2 / 5", progress: { current: 2, total: 5 } });
  });

  it("reaches the export last", () => {
    const steps = build("reconcile", [{ step: "parsing", count: 1 }, { step: "exporting" }]);
    expect(statuses(steps)).toEqual({
      parse: "done",
      receipts: "done",
      extract: "done",
      match: "done",
      reimbursements: "done",
      export: "running",
    });
  });

  it("has no export step in a scan", () => {
    const steps = build("scan", [{ step: "matching" }, { step: "exporting" }]);
    expect(steps.map((s) => s.id)).not.toContain("export");
  });

  it("ignores an unknown event", () => {
    const steps = build("reconcile", [{ step: "unknown" } as unknown as RunEvent]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("marks every step done and clears progress when the run succeeds", () => {
    const steps = build("reconcile", [{ step: "extracting", current: 1, total: 4 }], "succeeded");
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(steps.every((s) => s.progress === undefined)).toBe(true);
  });

  it("marks the running step failed when the run fails", () => {
    const steps = build("reconcile", [{ step: "extracting", current: 1, total: 4 }], "failed");
    expect(statuses(steps)).toEqual({
      parse: "done",
      receipts: "done",
      extract: "failed",
      match: "pending",
      reimbursements: "pending",
      export: "pending",
    });
    expect(step(steps, "extract").progress).toBeUndefined();
  });
});
