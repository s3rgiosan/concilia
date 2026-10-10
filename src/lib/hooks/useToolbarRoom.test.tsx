// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useToolbarRoom } from "./useToolbarRoom";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const room = useToolbarRoom(slot);
  return (
    <header className="titlebar">
      <div className="titlebar__leading" />
      <div ref={setSlot} />
      <output>{room === null ? "none" : String(room)}</output>
    </header>
  );
}

function widths(header: number, leading: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("titlebar") ? header : leading;
    return { width } as DOMRect;
  });
}

describe("useToolbarRoom", () => {
  it("is null without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("none");
  });

  it("measures the toolbar less its leading area and follows resizes", () => {
    let notify: () => void = () => undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    widths(1200, 220);
    const { unmount } = render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("980");
    expect(observe).toHaveBeenCalledTimes(2);
    widths(1200, 80);
    act(() => notify());
    expect(screen.getByRole("status").textContent).toBe("1120");
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
