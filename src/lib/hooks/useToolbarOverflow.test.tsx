// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToolbarOverflow } from "./useToolbarOverflow";

/** The width the trailing controls need at each level, and the toolbar's width. */
const NEEDS = [700, 500, 400];
let headerWidth = 1200;
let notify: () => void = () => undefined;

function trailingNeed(el: HTMLElement): number {
  return NEEDS[Number(el.dataset.level)];
}

/** The room the trailing controls get: the toolbar less the 220 px leading area and the 220 px title. */
function room(): number {
  return headerWidth - 220 - 220;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("titlebar__trailing") ? trailingNeed(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("titlebar")) {
      return headerWidth;
    }
    return this.classList.contains("titlebar__trailing") ? Math.min(trailingNeed(this), room()) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("titlebar__leading") ? 220 : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ contentKey = "en" }: { contentKey?: string }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const level = useToolbarOverflow(slot, 2, contentKey);
  return (
    <header className="titlebar">
      <div className="titlebar__leading" />
      <div className="titlebar__heading" style={{ minWidth: "220px" }} />
      <div className="titlebar__trailing" data-level={level}>
        <div ref={setSlot} />
      </div>
      <output>{level}</output>
    </header>
  );
}

function level(): string {
  return screen.getByRole("status").textContent ?? "";
}

describe("useToolbarOverflow", () => {
  it("stays at 0 while the controls fit", () => {
    headerWidth = 1200;
    render(<Probe />);
    expect(level()).toBe("0");
  });

  it("steps up while the controls overflow, and back down once there is room", () => {
    headerWidth = 1000;
    render(<Probe />);
    expect(level()).toBe("1");
    headerWidth = 800;
    act(() => notify());
    expect(level()).toBe("2");
    headerWidth = 950;
    act(() => notify());
    expect(level()).toBe("1");
    headerWidth = 1150;
    act(() => notify());
    expect(level()).toBe("0");
  });

  it("goes no further than the last level", () => {
    headerWidth = 600;
    render(<Probe />);
    expect(level()).toBe("2");
  });

  it("measures again from 0 when the content changes", () => {
    headerWidth = 1000;
    const { rerender } = render(<Probe />);
    expect(level()).toBe("1");
    NEEDS[0] = 520;
    rerender(<Probe contentKey="pt" />);
    expect(level()).toBe("0");
    NEEDS[0] = 700;
  });
});
