// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../test/fixtures";
import type { RunEvent, RunHandle } from "../tauri";
import { useRun, useRunEvents } from "./useRun";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A run the test settles by hand, with the event callback it was launched with. */
function fakeRun<T>() {
  const result = deferred<T>();
  const cancel = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  let push: (event: RunEvent) => void = () => undefined;
  const launch = vi.fn((onEvent: (event: RunEvent) => void): RunHandle<T> => {
    push = onEvent;
    return { promise: result.promise, cancel };
  });
  return { launch, cancel, result, push: (event: RunEvent) => push(event) };
}

/** Lets the animation frame that announces events run. */
async function frame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("useRun", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useRun<string>());
    expect(result.current.state).toEqual({ phase: "idle" });
  });

  it("collects events while running and keeps them on success", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ phase: "running", cancelling: false });

    act(() => run.push({ step: "parsing", count: 2 }));
    act(() => run.push({ step: "matching" }));
    await frame();
    expect(result.current.events.get()).toEqual([{ step: "parsing", count: 2 }, { step: "matching" }]);

    await act(async () => run.result.resolve("done"));
    expect(result.current.state).toEqual({ phase: "succeeded", result: "done" });
    expect(result.current.events.get()).toEqual([{ step: "parsing", count: 2 }, { step: "matching" }]);
  });

  it("reports a failed run with its events", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    act(() => run.push({ step: "receipts_found", count: 4 }));
    const failure = { kind: "network", message: "offline" };
    await act(async () => run.result.reject(failure));
    expect(result.current.state).toEqual({ phase: "failed", error: failure });
    expect(result.current.events.get()).toEqual([{ step: "receipts_found", count: 4 }]);
  });

  it("marks the run cancelling and asks the backend to stop it", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    act(() => result.current.cancel());
    expect(run.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ phase: "running", cancelling: true });

    act(() => run.push({ step: "matching" }));
    await frame();
    expect(result.current.events.get()).toEqual([{ step: "matching" }]);
    expect(result.current.state).toEqual({ phase: "running", cancelling: true });

    await act(async () => run.result.reject({ kind: "cancelled", message: "stopped" }));
    expect(result.current.state.phase).toBe("failed");
  });

  it("logs a cancel the backend refuses", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = fakeRun<string>();
    run.cancel.mockRejectedValue(new Error("gone"));
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    await act(async () => result.current.cancel());
    expect(error).toHaveBeenCalledWith("could not cancel the run", new Error("gone"));
  });

  it("does nothing on cancel without a running run", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.cancel());
    expect(result.current.state).toEqual({ phase: "idle" });

    act(() => result.current.start(run.launch));
    await act(async () => run.result.resolve("done"));
    act(() => result.current.cancel());
    expect(run.cancel).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe("succeeded");
  });

  it("returns to idle on reset and ignores the old run's result", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ phase: "idle" });

    act(() => run.push({ step: "matching" }));
    await act(async () => run.result.resolve("late"));
    expect(result.current.state).toEqual({ phase: "idle" });
  });

  it("ignores a failure from a run that was reset", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    act(() => result.current.reset());
    await act(async () => run.result.reject(new Error("late")));
    expect(result.current.state).toEqual({ phase: "idle" });
  });

  it("follows only the latest run when a new one starts", async () => {
    const first = fakeRun<string>();
    const second = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(first.launch));
    act(() => first.push({ step: "parsing", count: 1 }));
    act(() => result.current.start(second.launch));
    expect(result.current.state).toEqual({ phase: "running", cancelling: false });
    expect(result.current.events.get()).toEqual([]);

    await act(async () => first.result.resolve("first"));
    expect(result.current.state.phase).toBe("running");
    await act(async () => second.result.resolve("second"));
    expect(result.current.state).toEqual({ phase: "succeeded", result: "second" });
  });

  it("ignores events from a superseded run", async () => {
    const first = fakeRun<string>();
    const second = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(first.launch));
    act(() => result.current.start(second.launch));
    act(() => second.push({ step: "matching" }));
    act(() => first.push({ step: "parsing", count: 1 }));
    await frame();
    expect(result.current.events.get()).toEqual([{ step: "matching" }]);
  });

  it("cancels a running run on unmount", () => {
    const run = fakeRun<string>();
    const { result, unmount } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    unmount();
    expect(run.cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed cancel on unmount", async () => {
    const run = fakeRun<string>();
    run.cancel.mockRejectedValue(new Error("gone"));
    const { result, unmount } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    unmount();
    await act(async () => undefined);
    expect(run.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels nothing on unmount once the run is over", async () => {
    const run = fakeRun<string>();
    const { result, unmount } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    await act(async () => run.result.resolve("done"));
    unmount();
    expect(run.cancel).not.toHaveBeenCalled();
  });

  it("keeps only the latest event of each step, in the order the steps last reported", async () => {
    const run = fakeRun<string>();
    const { result } = renderHook(() => useRun<string>());
    act(() => result.current.start(run.launch));
    act(() => {
      run.push({ step: "parsing", count: 1 });
      for (let current = 1; current <= 500; current += 1) {
        run.push({ step: "extracting", current, total: 500 });
      }
      run.push({ step: "matching" });
    });
    await frame();
    expect(result.current.events.get()).toEqual([{ step: "parsing", count: 1 }, { step: "extracting", current: 500, total: 500 }, { step: "matching" }]);
  });

  it("announces a burst of events once per frame, and a run's end at once", async () => {
    const run = fakeRun<string>();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      const hook = useRun<string>();
      useRunEvents(hook.events);
      return hook;
    });
    act(() => result.current.start(run.launch));
    await frame();
    renders = 0;
    act(() => {
      for (let current = 1; current <= 300; current += 1) {
        run.push({ step: "extracting", current, total: 300 });
      }
    });
    expect(renders).toBe(0);
    await frame();
    expect(renders).toBe(1);

    act(() => run.push({ step: "matching" }));
    await act(async () => run.result.resolve("done"));
    expect(result.current.events.get().map((event) => event.step)).toEqual(["extracting", "matching"]);
  });
});
