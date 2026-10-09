// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DroppedDecision, Summary } from "../lib/tauri";
import { RunSummary } from "./RunSummary";

afterEach(cleanup);

const SUMMARY: Summary = {
  totalTransactions: 40,
  matched: 30,
  review: 6,
  unmatched: 4,
  bankFees: 2,
  totalReceipts: 36,
  matchedReceipts: 28,
  reviewReceipts: 6,
  unmatchedReceipts: 2,
  matchRate: 75,
};

const DROPPED: DroppedDecision[] = [
  { txId: "tx-001", description: "ACME CORP", removedReceiptFiles: ["acme.pdf"] },
  { txId: "tx-002", description: "GLOBEX", removedReceiptFiles: ["globex-1.pdf", "globex-2.pdf"] },
];

function renderSummary(patch: Partial<Parameters<typeof RunSummary>[0]> = {}) {
  const callbacks = {
    onReview: vi.fn(),
    onSaveReport: vi.fn(),
    onOpenReport: vi.fn(),
    onReveal: vi.fn(),
    onNew: vi.fn(),
  };
  const result = render(
    <RunSummary title="March 2030 reconciled" summary={SUMMARY} dropped={[]} hasReport={true} {...callbacks} {...patch} />,
  );
  return { ...result, ...callbacks };
}

function stats(container: HTMLElement): string[][] {
  return [...container.querySelectorAll(".stat")].map((stat) => [...stat.children].map((child) => child.textContent ?? ""));
}

describe("RunSummary", () => {
  it("shows the counts with bank fees", () => {
    const { container } = renderSummary();
    expect(screen.getByRole("heading", { name: "March 2030 reconciled" })).toBeTruthy();
    expect(screen.getByText("40 transactions · 36 receipts")).toBeTruthy();
    expect(stats(container)).toEqual([
      ["Matched", "30", "75% match rate"],
      ["Review", "6", "needs attention"],
      ["Unmatched", "4", "no receipt"],
      ["Bank fees", "2", "auto-detected"],
    ]);
  });

  it("leaves bank fees out when there are none", () => {
    const { container } = renderSummary({ summary: { ...SUMMARY, bankFees: 0 } });
    expect(stats(container).map(([label]) => label)).toEqual(["Matched", "Review", "Unmatched"]);
  });

  it("lists the review decisions a scan dropped", () => {
    renderSummary({ dropped: DROPPED });
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Some review decisions were removed because their receipts are gone:");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "ACME CORP (acme.pdf)",
      "GLOBEX (globex-1.pdf, globex-2.pdf)",
    ]);
  });

  it("shows no dropped decisions when there are none", () => {
    renderSummary();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("runs each action", () => {
    const { onReview, onSaveReport, onOpenReport, onReveal, onNew } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "Review & Validate" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save Report…" }));
    expect(onSaveReport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open Report" }));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(onReveal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "New Reconciliation" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("hides the report actions without a report", () => {
    renderSummary({ hasReport: false });
    expect(screen.queryByRole("button", { name: "Save Report…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Report" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review & Validate" })).toBeTruthy();
  });
});
