// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySummary, type Period } from "../lib/period";
import type { MenuEntry } from "../lib/popUpMenu";
import type { PeriodSummary } from "../lib/tauri";
import { Sidebar, type RunningMonth } from "./Sidebar";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function summary(year: string, month: string, patch: Partial<PeriodSummary> = {}): PeriodSummary {
  return { ...emptySummary({ year, month }), ...patch };
}

const PERIODS: PeriodSummary[] = [
  summary("2030", "03", { status: "ready", receipts: 38 }),
  summary("2030", "02", { status: "in_review", receipts: 30, transactions: 42, pending: 6 }),
  summary("2030", "01", { status: "finalized", receipts: 20, transactions: 25 }),
  summary("2029", "12"),
];

function renderSidebar({
  selected = "2030-03",
  running = null,
  error = null,
  loading = false,
}: { selected?: string; running?: RunningMonth | null; error?: unknown; loading?: boolean } = {}) {
  const onSelect = vi.fn<(period: Period) => void>();
  const onRetry = vi.fn();
  const onNewMonth = vi.fn();
  const reveal = vi.fn<(month: PeriodSummary) => void>();
  const menu = (month: PeriodSummary): MenuEntry[] => [{ label: "Show in Finder", onSelect: () => reveal(month) }];
  const props = { periods: PERIODS, selected, onSelect, running, loading, error, onRetry, onNewMonth, menu, width: 220 };
  const result = render(<Sidebar {...props} />);
  return { ...result, props, onSelect, onRetry, onNewMonth, reveal };
}

function rows(): string[] {
  return screen.getAllByRole("option").map((option) => option.textContent ?? "");
}

describe("Sidebar", () => {
  it("lists the months under their year with where each stands", () => {
    renderSidebar();
    expect(screen.getByRole("listbox", { name: "Months" })).toBeTruthy();
    const years = screen.getAllByRole("group").map((group) => [
      group.getAttribute("aria-labelledby"),
      within(group)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ]);
    expect(years).toEqual([
      ["year-2030", ["MarchReady · 38 receipts", "FebruaryIn review · 6 to decide", "JanuaryFinalized"]],
      ["year-2029", ["DecemberNo receipts"]],
    ]);
    expect(screen.getByRole("group", { name: "2030" })).toBeTruthy();
  });

  it("marks each status with a coloured dot", () => {
    const { container } = renderSidebar();
    const dots = [...container.querySelectorAll(".sidebar__status .dot")].map((dot) => dot.className);
    expect(dots).toEqual(["dot dot--blue", "dot dot--orange", "dot dot--green", "dot dot--gray"]);
  });

  it("selects the current month", () => {
    renderSidebar({ selected: "2030-02" });
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("month-2030-02");
    const selected = screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.id)).toEqual(["month-2030-02"]);
  });

  it("selects a month on click", () => {
    const { onSelect } = renderSidebar();
    fireEvent.click(screen.getByRole("option", { name: /January/ }));
    expect(onSelect).toHaveBeenCalledWith({ year: "2030", month: "01" });
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
  });

  it("moves the selection with the arrow keys, Home and End", () => {
    const { onSelect } = renderSidebar({ selected: "2030-02" });
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith({ year: "2030", month: "01" });
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith({ year: "2030", month: "03" });
    fireEvent.keyDown(listbox, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith({ year: "2029", month: "12" });
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith({ year: "2030", month: "03" });
    expect(onSelect).toHaveBeenCalledTimes(4);
  });

  it("stays put at either end of the list", () => {
    const { onSelect } = renderSidebar({ selected: "2030-03" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Home" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "x" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the month being reconciled with a spinner and its progress as a progress bar", () => {
    const { container, rerender, props } = renderSidebar({ running: { key: "2030-03", progress: { current: 4, total: 38 } } });
    expect(rows()[0]).toBe("MarchReading receipts: 4 of 38");
    expect(container.querySelectorAll(".sidebar__spinner")).toHaveLength(1);
    const bar = screen.getByRole("progressbar");
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax"), bar.getAttribute("aria-valuetext")]).toEqual([
      "4",
      "38",
      "Reading receipts: 4 of 38",
    ]);
    rerender(<Sidebar {...props} running={{ key: "2030-03", progress: null }} />);
    expect(rows()[0]).toBe("MarchReconciling…");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows no statuses while the months load", () => {
    const { container } = renderSidebar({ loading: true });
    expect(rows()[0]).toBe("March\u00a0");
    expect(container.querySelectorAll(".dot")).toHaveLength(0);
  });

  it("selects a month on a right click and shows its menu", () => {
    const { onSelect, reveal } = renderSidebar();
    fireEvent.contextMenu(screen.getAllByRole("option")[1], { clientX: 20, clientY: 40 });
    expect(onSelect).toHaveBeenCalledWith({ year: "2030", month: "02" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in Finder" }));
    expect(reveal).toHaveBeenCalledWith(PERIODS[1]);
  });

  it("explains a listing that failed and lists again on Try Again", () => {
    const { onRetry } = renderSidebar({ error: { kind: "io", message: "unreadable" } });
    expect(screen.getByRole("alert").textContent).toContain("Details: unreadable");
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("opens the New Month sheet from the add button", () => {
    const { onNewMonth } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "New Month…" }));
    expect(onNewMonth).toHaveBeenCalledTimes(1);
  });
});
