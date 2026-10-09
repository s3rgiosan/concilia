// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useFileDrop } from "./useFileDrop";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

type DragPayload = { type: "enter" | "over" | "drop" | "leave"; paths?: string[] };

let push: (payload: DragPayload) => void;
const onDragDropEvent = vi.fn();
const unlisten = vi.fn();

beforeEach(() => {
  onDragDropEvent.mockImplementation((handler: (event: { payload: DragPayload }) => void) => {
    push = (payload) => handler({ payload });
    return Promise.resolve(unlisten);
  });
  vi.mocked(getCurrentWebview).mockReturnValue({ onDragDropEvent } as unknown as ReturnType<typeof getCurrentWebview>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__CONCILIA_PREVIEW__;
});

describe("useFileDrop", () => {
  it("tracks a drag over the window and passes the dropped paths", () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() => useFileDrop(onDrop));
    expect(result.current).toBe(false);
    expect(onDragDropEvent).toHaveBeenCalledTimes(1);

    act(() => push({ type: "enter", paths: ["/Users/example/Downloads/extrato-2030-03.pdf"] }));
    expect(result.current).toBe(true);
    act(() => push({ type: "leave" }));
    expect(result.current).toBe(false);
    act(() => push({ type: "over" }));
    expect(result.current).toBe(true);

    act(() => push({ type: "drop", paths: ["/Users/example/Downloads/extrato-2030-03.pdf"] }));
    expect(result.current).toBe(false);
    expect(onDrop).toHaveBeenCalledWith(["/Users/example/Downloads/extrato-2030-03.pdf"]);
  });

  it("calls the latest handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ onDrop }) => useFileDrop(onDrop), { initialProps: { onDrop: first } });
    rerender({ onDrop: second });
    act(() => push({ type: "drop", paths: ["/Users/example/a.pdf"] }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(["/Users/example/a.pdf"]);
    expect(onDragDropEvent).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount", async () => {
    const { unmount } = renderHook(() => useFileDrop(() => undefined));
    await act(async () => undefined);
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not listen while disabled, and stops when disabled", async () => {
    const { result, rerender } = renderHook(({ enabled }) => useFileDrop(() => undefined, enabled), {
      initialProps: { enabled: false },
    });
    expect(onDragDropEvent).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(onDragDropEvent).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
    act(() => push({ type: "enter" }));
    expect(result.current).toBe(true);

    rerender({ enabled: false });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });

  it("does not listen in the browser preview", () => {
    (window as unknown as Record<string, unknown>).__CONCILIA_PREVIEW__ = true;
    const { result } = renderHook(() => useFileDrop(() => undefined));
    expect(getCurrentWebview).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });
});
