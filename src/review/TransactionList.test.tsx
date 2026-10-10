// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransaction } from "../test/fixtures";
import type { ListRow } from "./rows";
import { TransactionList } from "./TransactionList";

function row(id: string, description: string): ListRow {
  return { kind: "transaction", id, tx: makeTransaction(id, { description }) };
}

const ROWS = [row("a", "ACME CORP"), row("b", "EXAMPLE SHOP"), row("c", "SAMPLE CAFE")];

function renderList(rows: ListRow[], viewKey = "review|") {
  const props = {
    listId: "list",
    selectedId: null,
    reimbursementTotal: 0,
    listRef: { current: null },
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onContextMenu: vi.fn(),
    onKeyDown: vi.fn(),
  };
  const view = render(<TransactionList {...props} rows={rows} viewKey={viewKey} />);
  return { ...view, update: (next: ListRow[], key = viewKey) => view.rerender(<TransactionList {...props} rows={next} viewKey={key} />), props };
}

function leaving(): string[] {
  return Array.from(document.querySelectorAll(".list-row--leaving")).map((el) => el.querySelector(".list-row__description")?.textContent ?? "");
}

beforeEach(() => {
  Element.prototype.getAnimations = vi.fn(() => []);
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).getAnimations;
});

describe("TransactionList", () => {
  it("selects a row on press", () => {
    const { props } = renderList(ROWS);
    fireEvent.mouseDown(screen.getByText("EXAMPLE SHOP").closest("[role=option]")!);
    expect(props.onSelect).toHaveBeenCalledWith(ROWS[1]);
  });

  it("collapses a row that leaves while the view stays the same, in its place", () => {
    vi.useFakeTimers();
    const { update } = renderList(ROWS);
    update([ROWS[0], ROWS[2]]);
    expect(leaving()).toEqual(["EXAMPLE SHOP"]);
    const order = Array.from(document.querySelectorAll(".list-row__description")).map((el) => el.textContent);
    expect(order).toEqual(["ACME CORP", "EXAMPLE SHOP", "SAMPLE CAFE"]);
    const ghost = document.querySelector(".list-row--leaving")!;
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    act(() => vi.advanceTimersByTime(400));
    expect(leaving()).toEqual([]);
    vi.useRealTimers();
  });

  it("drops rows at once when the filter or search changes", () => {
    const { update } = renderList(ROWS);
    update([ROWS[0]], "matched|");
    expect(leaving()).toEqual([]);
  });

  it("drops rows at once when Reduce Motion is on", () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    const { update } = renderList(ROWS);
    update([ROWS[0], ROWS[2]]);
    expect(leaving()).toEqual([]);
    delete (window as Partial<Window>).matchMedia;
  });
});
