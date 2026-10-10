// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Step } from "../lib/steps";
import { RunProgress } from "./RunProgress";

afterEach(cleanup);

const STEPS: Step[] = [
  { id: "parse", label: "Parsing statements", status: "done", detail: "2 files" },
  { id: "receipts", label: "Scanning receipts", status: "done", detail: "40 found" },
  { id: "extract", label: "Extracting receipt data", status: "running", detail: "10 / 40", progress: { current: 10, total: 40 } },
  { id: "match", label: "Matching", status: "pending" },
  { id: "export", label: "Generating report", status: "failed" },
];

function renderProgress(patch: Partial<Parameters<typeof RunProgress>[0]> = {}) {
  return render(<RunProgress title="Reconciling March 2030" steps={STEPS} {...patch} />);
}

describe("RunProgress", () => {
  it("hides the separator before a detail from assistive technology", () => {
    const { container } = renderProgress();
    const separators = container.querySelectorAll(".step__detail > [aria-hidden=true]");
    expect(separators).toHaveLength(3);
    expect(separators[0].textContent).toBe(" · ");
  });

  it("lists each step with its status and detail", () => {
    const { container } = renderProgress();
    expect(screen.getByRole("heading", { name: "Reconciling March 2030" })).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Parsing statements · 2 files",
      "Scanning receipts · 40 found",
      "Extracting receipt data · 10 / 40",
      "Matching",
      "Generating report",
    ]);
    expect(items.map((li) => li.className)).toEqual([
      "step step--done",
      "step step--done",
      "step step--running",
      "step step--pending",
      "step step--failed",
    ]);
    expect(container.querySelectorAll(".step__icon--done")).toHaveLength(2);
    expect(container.querySelectorAll(".step__spinner")).toHaveLength(1);
    expect(container.querySelectorAll(".step__dot")).toHaveLength(1);
    expect(container.querySelectorAll(".step__icon--failed")).toHaveLength(1);
  });

  it("shows a progress bar for a step with a total", () => {
    renderProgress();
    const bar = screen.getByRole("progressbar", { name: "Extracting receipt data" }) as HTMLProgressElement;
    expect(bar.value).toBe(10);
    expect(bar.max).toBe(40);
  });

  it("shows no progress bar for an empty total", () => {
    renderProgress({ steps: [{ id: "extract", label: "Extracting receipt data", status: "running", progress: { current: 0, total: 0 } }] });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("names the steps after the title, and leaves the title out when there is none", () => {
    const { rerender } = renderProgress();
    expect(screen.getByRole("region", { name: "Reconciling March 2030" })).toBeTruthy();
    rerender(<RunProgress steps={STEPS} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("has no Cancel button: the toolbar or the sheet around it stops the run", () => {
    renderProgress();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("describes the progress bar with the step's detail", () => {
    renderProgress();
    expect(screen.getByRole("progressbar", { name: "Extracting receipt data" }).getAttribute("aria-valuetext")).toBe("10 / 40");
  });
});
