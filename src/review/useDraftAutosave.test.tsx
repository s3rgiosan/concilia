// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "../lib/tauri";
import { deferred } from "../test/fixtures";
import { AUTOSAVE_DELAY_MS, useDraftAutosave } from "./useDraftAutosave";

const DRAFT_A: Draft = { "tx-1": { status: "MATCHED", notes: "salary" } };
const DRAFT_B: Draft = { "tx-1": { status: "UNMATCHED", notes: "" } };
const DRAFT_C: Draft = { "tx-2": { status: "MATCHED", notes: "transfer" } };

type Props = { draft: Draft; dirty: boolean };

function setup(save: (draft: Draft) => Promise<void>, initial: Props = { draft: {}, dirty: false }) {
  return renderHook(({ draft, dirty }: Props) => useDraftAutosave(draft, dirty, save), { initialProps: initial });
}

/** Lets settled promises run their callbacks. */
async function settle() {
  await act(async () => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDraftAutosave", () => {
  it("stays idle until there is a change", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = setup(save);
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 4));
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  it("saves 500 ms after the last change, not before", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(400));
    rerender({ draft: DRAFT_B, dirty: true });
    await act(async () => vi.advanceTimersByTime(499));
    expect(save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(DRAFT_B);
  });

  it("reports saving, then saved", async () => {
    const pending = deferred<void>();
    const save = vi.fn().mockReturnValue(pending.promise);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.state).toEqual({ kind: "saving" });
    await act(async () => pending.resolve());
    expect(result.current.state).toEqual({ kind: "saved" });
  });

  it("reports a failed save with its error", async () => {
    const error = { kind: "io", message: "disk full" };
    const save = vi.fn().mockRejectedValue(error);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.state).toEqual({ kind: "failed", error });
  });

  it("stays saving while a newer change waits for its save", async () => {
    const first = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    rerender({ draft: DRAFT_B, dirty: true });
    await act(async () => first.resolve());
    expect(result.current.state).toEqual({ kind: "saving" });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.state).toEqual({ kind: "saved" });
    expect(save).toHaveBeenLastCalledWith(DRAFT_B);
  });

  it("flush saves at once and resolves when the draft is stored", async () => {
    const pending = deferred<void>();
    const save = vi.fn().mockReturnValue(pending.promise);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    let flushed = false;
    act(() => {
      result.current.flush().then(() => {
        flushed = true;
      });
    });
    await settle();
    expect(save).toHaveBeenCalledWith(DRAFT_A);
    expect(flushed).toBe(false);
    await act(async () => pending.resolve());
    expect(flushed).toBe(true);
    // The timer the change started is cancelled.
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush rejects when the save fails", async () => {
    const error = { kind: "io", message: "disk full" };
    const save = vi.fn().mockRejectedValue(error);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    let flush!: Promise<void>;
    act(() => {
      flush = result.current.flush();
    });
    await expect(flush).rejects.toBe(error);
    await settle();
    expect(result.current.state).toEqual({ kind: "failed", error });
  });

  it("flush with nothing pending resolves without saving", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = setup(save);
    await expect(result.current.flush()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("flush waits for a save already running", async () => {
    const pending = deferred<void>();
    const save = vi.fn().mockReturnValue(pending.promise);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    let flushed = false;
    result.current.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false);
    await act(async () => pending.resolve());
    expect(flushed).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush retries a save that failed", async () => {
    const error = { kind: "io", message: "disk full" };
    const save = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.state).toEqual({ kind: "failed", error });
    let flush!: Promise<void>;
    act(() => {
      flush = result.current.flush();
    });
    await expect(flush).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("runs saves one at a time, in order", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    act(() => {
      result.current.flush().catch(() => undefined);
    });
    rerender({ draft: DRAFT_B, dirty: true });
    act(() => {
      result.current.flush().catch(() => undefined);
    });
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(DRAFT_A);
    await act(async () => first.resolve());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(DRAFT_B);
    await act(async () => second.resolve());
    expect(result.current.state).toEqual({ kind: "saved" });
  });

  it("saves after an earlier save failed", async () => {
    const error = { kind: "io", message: "disk full" };
    const save = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.state).toEqual({ kind: "failed", error });
    rerender({ draft: DRAFT_C, dirty: true });
    let flush!: Promise<void>;
    act(() => {
      flush = result.current.flush();
    });
    await expect(flush).resolves.toBeUndefined();
    expect(save).toHaveBeenLastCalledWith(DRAFT_C);
    await settle();
    expect(result.current.state).toEqual({ kind: "saved" });
  });

  it("saves pending changes on unmount", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    unmount();
    await settle();
    expect(save).toHaveBeenCalledWith(DRAFT_A);
  });

  it("swallows a failed save on unmount", async () => {
    const save = vi.fn().mockRejectedValue(new Error("gone"));
    const { rerender, unmount } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    unmount();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves nothing on unmount once saved", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    unmount();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("uses the latest save function", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ draft, dirty, save }: Props & { save: (d: Draft) => Promise<void> }) => useDraftAutosave(draft, dirty, save), {
      initialProps: { draft: {}, dirty: false, save: first },
    });
    rerender({ draft: DRAFT_A, dirty: true, save: second });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(DRAFT_A);
  });

  it("forgets a finished save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    await settle();
    expect(result.current.state).toEqual({ kind: "saved" });
    act(() => result.current.forget());
    expect(result.current.state).toEqual({ kind: "idle" });
  });

  it("forgets a failed save, so flush has nothing to retry", async () => {
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_A, dirty: true });
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    await settle();
    act(() => result.current.forget());
    expect(result.current.state).toEqual({ kind: "idle" });
    await act(async () => result.current.flush());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the state while a change waits for its save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = setup(save);
    rerender({ draft: DRAFT_C, dirty: true });
    act(() => result.current.forget());
    await act(async () => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    await settle();
    expect(save).toHaveBeenCalledWith(DRAFT_C);
    expect(result.current.state).toEqual({ kind: "saved" });
  });
});
