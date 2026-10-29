// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewToolbar } from "./ReviewToolbar";

afterEach(cleanup);

function renderToolbar(patch: Partial<Parameters<typeof ReviewToolbar>[0]> = {}) {
  const props = {
    filter: "all" as const,
    counts: { pending: 2, matched: 2, all: 4 },
    onFilter: vi.fn(),
    search: "",
    searchRef: { current: null },
    onSearch: vi.fn(),
    onSearchKeyDown: vi.fn(),
    onClearSearch: vi.fn(),
    busy: false,
    finalized: false,
    moreActions: [{ label: "Open Report", onSelect: vi.fn() }],
    onScan: vi.fn(),
    onAddStatements: vi.fn(),
    onExport: vi.fn(),
    onFinalize: vi.fn(),
    onOpenReport: vi.fn(),
    level: 0 as const,
    ...patch,
  };
  render(<ReviewToolbar {...props} />);
  return props;
}

/** Opens the `•••` menu and lists its items, disabled ones marked with "-". */
function menuItems(): string[] {
  fireEvent.click(screen.getByRole("button", { name: "More Actions" }));
  return within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => `${(item as HTMLButtonElement).disabled ? "-" : ""}${item.textContent}`);
}

function filter(): HTMLElement {
  return screen.getByRole("radiogroup", { name: "Filter" });
}

describe("ReviewToolbar", () => {
  it("shows the filter with counts, the actions in order and search", () => {
    const props = renderToolbar();
    expect(within(filter()).getAllByRole("radio").map((b) => b.textContent)).toEqual(["To Decide2", "Matched2", "All4"]);
    fireEvent.click(within(filter()).getByRole("radio", { name: /^To Decide/ }));
    expect(props.onFilter).toHaveBeenCalledWith("pending");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Transactions" }), { target: { value: "acme" } });
    expect(props.onSearch).toHaveBeenCalledWith("acme");
    fireEvent.click(screen.getByRole("button", { name: "Scan for New Receipts" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Report…" }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize…" }));
    for (const handler of [props.onScan, props.onExport, props.onFinalize]) {
      expect(handler).toHaveBeenCalledTimes(1);
    }
    const order = Array.from(document.querySelectorAll("[role=radiogroup], button, input")).map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(order.slice(4)).toEqual(["Scan for New Receipts", "Export Report…", "More Actions", "Finalize…", "Search Transactions"]);
    expect(menuItems()).toEqual(["Add Statements…", "Open Report"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Statements…" }));
    expect(props.onAddStatements).toHaveBeenCalledTimes(1);
  });

  it("makes Finalize… the default button only once nothing is left to decide", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: "Finalize…" }).classList.contains("default")).toBe(false);
    cleanup();
    renderToolbar({ counts: { pending: 0, matched: 4, all: 4 } });
    expect(screen.getByRole("button", { name: "Finalize…" }).classList.contains("default")).toBe(true);
  });

  it("offers Open Report as the primary button of a finalized month", () => {
    const props = renderToolbar({ finalized: true });
    expect(screen.queryByRole("button", { name: "Finalize…" })).toBeNull();
    const open = screen.getByRole("button", { name: "Open Report" });
    expect(open.classList.contains("default")).toBe(true);
    fireEvent.click(open);
    expect(props.onOpenReport).toHaveBeenCalledTimes(1);
  });

  it("checks one filter segment, keeps only it in the tab order and moves with the arrow keys", () => {
    const props = renderToolbar({ filter: "matched" });
    const radios = within(filter()).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(radios[1], { key: "ArrowRight" });
    expect(props.onFilter).toHaveBeenLastCalledWith("all");
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[1], { key: "ArrowLeft" });
    expect(props.onFilter).toHaveBeenLastCalledWith("pending");
    fireEvent.keyDown(radios[1], { key: "End" });
    expect(props.onFilter).toHaveBeenLastCalledWith("all");
  });

  it("wraps around at the ends of the filter", () => {
    const props = renderToolbar({ filter: "all" });
    fireEvent.keyDown(within(filter()).getByRole("radio", { name: /^All/ }), { key: "ArrowRight" });
    expect(props.onFilter).toHaveBeenLastCalledWith("pending");
  });

  it("clears the search from its button, which shows only with text", () => {
    const props = renderToolbar();
    expect(screen.queryByRole("button", { name: "Clear Search" })).toBeNull();
    cleanup();
    const filled = renderToolbar({ search: "acme" });
    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(filled.onClearSearch).toHaveBeenCalledTimes(1);
    expect(props.onClearSearch).not.toHaveBeenCalled();
  });

  it("first moves Scan and Export Report… into the menu and drops the counts", () => {
    const props = renderToolbar({ level: 1 });
    expect(within(filter()).getAllByRole("radio").map((b) => b.textContent)).toEqual(["To Decide", "Matched", "All"]);
    expect(screen.queryByRole("button", { name: "Export Report…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scan for New Receipts" })).toBeNull();
    expect(menuItems()).toEqual(["Add Statements…", "Scan for New Receipts", "Export Report…", "Open Report"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export Report…" }));
    expect(props.onExport).toHaveBeenCalledTimes(1);
  });

  it("then turns the filter into a pop-up button", () => {
    const props = renderToolbar({ level: 2 });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter" }), { target: { value: "matched" } });
    expect(props.onFilter).toHaveBeenCalledWith("matched");
  });

  it("disables the month's jobs while one runs and keeps Scan off once finalized", () => {
    renderToolbar({ busy: true });
    expect(menuItems()).toEqual(["-Add Statements…", "Open Report"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    cleanup();
    renderToolbar({ busy: true });
    expect((screen.getByRole("button", { name: "Scan for New Receipts" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Export Report…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Finalize…" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderToolbar({ finalized: true, level: 1 });
    expect(screen.queryByRole("button", { name: "Finalize…" })).toBeNull();
    expect(menuItems()).toEqual(["-Scan for New Receipts", "Export Report…", "Open Report"]);
  });
});
