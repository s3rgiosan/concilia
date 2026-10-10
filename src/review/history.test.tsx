// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, mapHistory, record, redo, startHistory, undo, useHistory } from "./history";

describe("history", () => {
  it("records steps and undoes them in reverse order", () => {
    let h = startHistory("a");
    h = record(h, "b");
    h = record(h, "c");
    expect(h).toEqual({ past: ["a", "b"], present: "c", future: [] });
    h = undo(h);
    expect(h).toEqual({ past: ["a"], present: "b", future: ["c"] });
    h = undo(h);
    expect(h).toEqual({ past: [], present: "a", future: ["b", "c"] });
  });

  it("redoes undone steps", () => {
    let h = undo(undo(record(record(startHistory("a"), "b"), "c")));
    h = redo(h);
    expect(h).toEqual({ past: ["a"], present: "b", future: ["c"] });
    h = redo(h);
    expect(h).toEqual({ past: ["a", "b"], present: "c", future: [] });
  });

  it("does nothing with nothing to undo or redo", () => {
    const h = startHistory("a");
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("forgets undone steps when a new one is recorded", () => {
    const h = record(undo(record(startHistory("a"), "b")), "c");
    expect(h).toEqual({ past: ["a"], present: "c", future: [] });
  });

  it("ignores a step that changes nothing", () => {
    const h = record(startHistory("a"), "b");
    expect(record(h, "b")).toBe(h);
  });

  it("keeps the latest steps up to the limit", () => {
    let h = startHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 5; i += 1) {
      h = record(h, i);
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(5);
    expect(h.present).toBe(HISTORY_LIMIT + 5);
    expect(record(record(record(startHistory(0), 1, 2), 2, 2), 3, 2).past).toEqual([1, 2]);
  });

  it("maps every value", () => {
    const h = mapHistory({ past: ["a"], present: "b", future: ["c"] }, (v) => v.toUpperCase());
    expect(h).toEqual({ past: ["A"], present: "B", future: ["C"] });
  });
});

describe("useHistory", () => {
  it("records, undoes and redoes", () => {
    const { result } = renderHook(() => useHistory(1));
    expect(result.current).toMatchObject({ present: 1, canUndo: false, canRedo: false, previous: undefined, next: undefined });
    act(() => result.current.record(2));
    act(() => result.current.record((n) => n * 10));
    expect(result.current).toMatchObject({ present: 20, previous: 2, canUndo: true, canRedo: false });
    act(() => result.current.undo());
    expect(result.current).toMatchObject({ present: 2, previous: 1, next: 20, canUndo: true, canRedo: true });
    act(() => result.current.redo());
    expect(result.current.present).toBe(20);
  });

  it("resets and maps", () => {
    const { result } = renderHook(() => useHistory(1, 3));
    act(() => result.current.record(2));
    act(() => result.current.map((n) => n + 100));
    expect(result.current).toMatchObject({ present: 102, previous: 101 });
    act(() => result.current.reset(7));
    expect(result.current).toMatchObject({ present: 7, canUndo: false, canRedo: false });
  });
});
