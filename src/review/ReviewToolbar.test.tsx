// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewToolbar } from "./ReviewToolbar";

afterEach(cleanup);

function renderToolbar(patch: Partial<Parameters<typeof ReviewToolbar>[0]> = {}) {
  const props = {
    filter: "all" as const,
    counts: { all: 4, review: 1, unmatched: 1, matched: 2 },
    onFilter: vi.fn(),
    search: "",
    searchRef: { current: null },
    onSearch: vi.fn(),
    onSearchKeyDown: vi.fn(),
    busy: false,
    finalized: false,
    moreActions: [{ label: "Open Report", onSelect: vi.fn() }],
    inspectorShown: true,
    onScan: vi.fn(),
    onExport: vi.fn(),
    onFinalize: vi.fn(),
    onToggleInspector: vi.fn(),
    compact: false,
    ...patch,
  };
  render(<ReviewToolbar {...props} />);
  return props;
}

function menuItems(): string[] {
  const menu = screen.getByRole("combobox", { name: "More Actions" }) as HTMLSelectElement;
  return Array.from(menu.options)
    .filter((o) => !o.hidden)
    .map((o) => o.textContent ?? "");
}

describe("ReviewToolbar", () => {
  it("shows the filter with counts, search and every action", () => {
    const props = renderToolbar();
    const filter = screen.getByRole("group", { name: "Filter" });
    expect(within(filter).getAllByRole("button").map((b) => b.textContent)).toEqual(["All4", "Needs Review1", "Unmatched1", "Matched2"]);
    fireEvent.click(within(filter).getByRole("button", { name: /^Unmatched/ }));
    expect(props.onFilter).toHaveBeenCalledWith("unmatched");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "acme" } });
    expect(props.onSearch).toHaveBeenCalledWith("acme");
    fireEvent.click(screen.getByRole("button", { name: "Scan for New Receipts" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Report…" }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize…" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Inspector" }));
    for (const handler of [props.onScan, props.onExport, props.onFinalize, props.onToggleInspector]) {
      expect(handler).toHaveBeenCalledTimes(1);
    }
    expect(menuItems()).toEqual(["Open Report"]);
  });

  it("goes compact: no counts, Export Report… in the menu", () => {
    const props = renderToolbar({ compact: true });
    const filter = screen.getByRole("group", { name: "Filter" });
    expect(within(filter).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Needs Review", "Unmatched", "Matched"]);
    expect(screen.queryByRole("button", { name: "Export Report…" })).toBeNull();
    expect(menuItems()).toEqual(["Export Report…", "Open Report"]);
    const menu = screen.getByRole("combobox", { name: "More Actions" });
    fireEvent.change(menu, { target: { value: "0" } });
    expect(props.onExport).toHaveBeenCalledTimes(1);
  });

  it("disables the month's jobs while one runs and hides Finalize once finalized", () => {
    renderToolbar({ busy: true });
    expect((screen.getByRole("button", { name: "Scan for New Receipts" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Export Report…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Finalize…" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderToolbar({ finalized: true, inspectorShown: false });
    expect(screen.queryByRole("button", { name: "Finalize…" })).toBeNull();
    expect((screen.getByRole("button", { name: "Scan for New Receipts" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Show Inspector" }).getAttribute("aria-expanded")).toBe("false");
  });
});
