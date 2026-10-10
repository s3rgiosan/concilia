// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAttention, setDockProgress, type RunEvent } from "../tauri";
import { useDockProgress } from "./useDockProgress";
import type { RunState } from "./useRun";

vi.mock("../tauri", () => ({
  setDockProgress: vi.fn(),
  requestAttention: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ preview: false }));
vi.mock("../preview", () => ({ isPreview: () => mocks.preview }));

type State = RunState<unknown>;

function running(events: RunEvent[] = []): State {
  return { phase: "running", events, cancelling: false };
}

function focus(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

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
    renderHook(() => useDockProgress({ phase: "idle" }));
    expect(setDockProgress).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("is indeterminate before receipts are counted", () => {
    renderHook(() => useDockProgress(running([{ step: "parsing", count: 1 }])));
    expect(setDockProgress).toHaveBeenCalledExactlyOnceWith("indeterminate");
  });

  it("follows the extracting step's percentage", () => {
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: running([{ step: "extracting", current: 1, total: 4 }]) });
    rerender({ state: running([{ step: "extracting", current: 1, total: 4 }, { step: "extracting", current: 3, total: 4 }]) });
    expect(vi.mocked(setDockProgress).mock.calls).toEqual([["indeterminate"], [25], [75]]);
  });

  it("does not repeat an unchanged value", () => {
    const events: RunEvent[] = [{ step: "extracting", current: 1, total: 2 }];
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running(events) },
    });
    rerender({ state: running([...events, { step: "matching" }]) });
    expect(setDockProgress).toHaveBeenCalledTimes(1);
  });

  it("clears the bar when the run ends", () => {
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", events: [], result: null } });
    expect(setDockProgress).toHaveBeenLastCalledWith(null);
  });

  it("clears the bar when the window closes mid-run", () => {
    const { unmount } = renderHook(() => useDockProgress(running()));
    unmount();
    expect(setDockProgress).toHaveBeenLastCalledWith(null);
  });

  it("requests attention when a run finishes in the background", () => {
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", events: [], result: null } });
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });

  it("requests attention when a run fails in the background", () => {
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "failed", events: [], error: { kind: "io", message: "x" } } });
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the window has focus", () => {
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", events: [], result: null } });
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("stays quiet when the run was cancelled", () => {
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "failed", events: [], error: { kind: "cancelled", message: "stopped" } } });
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("does nothing in the browser preview", () => {
    mocks.preview = true;
    focus(false);
    const { rerender } = renderHook(({ state }: { state: State }) => useDockProgress(state), {
      initialProps: { state: running() },
    });
    rerender({ state: { phase: "succeeded", events: [], result: null } });
    expect(setDockProgress).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("survives a Dock call that throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(setDockProgress).mockImplementation(() => {
      throw new Error("no window");
    });
    renderHook(() => useDockProgress(running()));
    expect(error).toHaveBeenCalled();
  });
});
