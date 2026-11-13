// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAttention, setDockProgress, type RunEvent } from "../tauri";
import { useDockProgress } from "./useDockProgress";
import type { RunEvents, RunState } from "./useRun";

vi.mock("../tauri", () => ({
  setDockProgress: vi.fn(),
  requestAttention: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ preview: false }));
vi.mock("../preview", () => ({ isPreview: () => mocks.preview }));

type State = RunState<unknown>;

function running(): State {
  return { phase: "running", cancelling: false };
}

/** Run events the test changes by hand. */
function fakeEvents(initial: RunEvent[] = []): RunEvents & { set: (next: RunEvent[]) => void } {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      current = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function focus(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

const NO_EVENTS = fakeEvents();

beforeEach(() => {
  mocks.preview = false;
  vi.mocked(setDockProgress).mockResolvedValue(undefined);
  vi.mocked(requestAttention).mockResolvedValue(undefined);
  focus(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useDockProgress", () => {
  it("does nothing while idle", () => {
    renderHook(() => useDockProgress({ phase: "idle" }, fakeEvents()));
    expect(setDockProgress).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("is indeterminate before receipts are counted", () => {
    renderHook(() => useDockProgress(running(), fakeEvents([{ step: "parsing", count: 1 }])));
    expect(setDockProgress).toHaveBeenCalledExactlyOnceWith("indeterminate");
  });

  it("follows the extracting step's percentage", () => {
    const events = fakeEvents();
    renderHook(() => useDockProgress(running(), events));
    act(() => events.set([{ step: "extracting", current: 1, total: 4 }]));
    act(() => events.set([{ step: "extracting", current: 3, total: 4 }]));
    expect(vi.mocked(setDockProgress).mock.calls).toEqual([["indeterminate"], [25], [75]]);
  });

  it("does not repeat an unchanged value", () => {
    const events = fakeEvents([{ step: "extracting", current: 1, total: 2 }]);
    renderHook(() => useDockProgress(running(), events));
    act(() => events.set([{ step: "extracting", current: 1, total: 2 }, { step: "matching" }]));
    expect(setDockProgress).toHaveBeenCalledTimes(1);
  });

  it("clears the bar when the run ends", () => {
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state, NO_EVENTS), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", result: null } });
    expect(setDockProgress).toHaveBeenLastCalledWith(null);
  });

  it("clears the bar when the window closes mid-run", () => {
    const { unmount } = renderHook(() => useDockProgress(running(), fakeEvents()));
    unmount();
    expect(setDockProgress).toHaveBeenLastCalledWith(null);
  });

  it("requests attention when a run finishes in the background", () => {
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state, NO_EVENTS), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", result: null } });
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });

  it("requests attention when a run fails in the background", () => {
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state, NO_EVENTS), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "failed", error: { kind: "io", message: "x" } } });
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the window has focus", () => {
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state, NO_EVENTS), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", result: null } });
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("stays quiet when the run was cancelled", () => {
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state, NO_EVENTS), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "failed", error: { kind: "cancelled", message: "stopped" } } });
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("does nothing in the browser preview", () => {
    mocks.preview = true;
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state, NO_EVENTS), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", result: null } });
    expect(setDockProgress).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("survives a Dock call that throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(setDockProgress).mockImplementation(() => {
      throw new Error("no window");
    });
    renderHook(() => useDockProgress(running(), fakeEvents()));
    expect(error).toHaveBeenCalled();
  });
});
