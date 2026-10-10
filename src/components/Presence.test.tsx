// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitingContext, Presence } from "./Presence";

function Probe({ label }: { label: string }) {
  const exiting = useContext(ExitingContext);
  return <p>{`${label}${exiting ? " (leaving)" : ""}`}</p>;
}

function wrapper(): HTMLElement | null {
  return document.querySelector(".presence");
}

/** An animation that finishes when `finish` runs. */
function pendingAnimation(): { animation: Animation; finish: () => void } {
  let finish = () => undefined as void;
  const finished = new Promise<Animation>((resolve) => {
    finish = () => resolve(animation);
  });
  const animation = { finished, effect: { getComputedTiming: () => ({ endTime: 150 }) } } as unknown as Animation;
  return { animation, finish };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
});

describe("Presence", () => {
  it("shows content that is there from the start without an entry", () => {
    render(<Presence>{<Probe label="Sheet" />}</Presence>);
    expect(screen.getByText("Sheet")).toBeTruthy();
    expect(wrapper()?.dataset.presence).toBe("static");
  });

  it("marks content that appears later as entering", () => {
    const { rerender } = render(<Presence>{null}</Presence>);
    expect(wrapper()).toBeNull();
    rerender(<Presence>{<Probe label="Sheet" />}</Presence>);
    expect(wrapper()?.dataset.presence).toBe("enter");
  });

  it("unmounts at once when nothing animates", () => {
    const { rerender } = render(<Presence>{<Probe label="Sheet" />}</Presence>);
    rerender(<Presence>{null}</Presence>);
    expect(screen.queryByText(/Sheet/)).toBeNull();
  });

  it("keeps leaving content inert until its transitions end", async () => {
    const pending = pendingAnimation();
    HTMLElement.prototype.getAnimations = vi.fn(() => [pending.animation]);
    const { rerender } = render(<Presence>{<Probe label="Sheet" />}</Presence>);
    rerender(<Presence>{null}</Presence>);
    expect(screen.getByText("Sheet (leaving)")).toBeTruthy();
    expect(wrapper()?.dataset.presence).toBe("exit");
    expect(wrapper()?.hasAttribute("inert")).toBe(true);
    await act(async () => pending.finish());
    expect(screen.queryByText(/Sheet/)).toBeNull();
  });

  it("takes content back that returns while it leaves", () => {
    const pending = pendingAnimation();
    HTMLElement.prototype.getAnimations = vi.fn(() => [pending.animation]);
    const { rerender } = render(<Presence>{<Probe label="Sheet" />}</Presence>);
    rerender(<Presence>{null}</Presence>);
    const leaving = wrapper();
    rerender(<Presence>{<Probe label="Sheet" />}</Presence>);
    expect(wrapper()).toBe(leaving);
    expect(wrapper()?.dataset.presence).toBe("enter");
    expect(wrapper()?.hasAttribute("inert")).toBe(false);
    expect(screen.getByText("Sheet")).toBeTruthy();
  });

  it("ignores endless animations such as a spinner", () => {
    const spinner = { finished: new Promise(() => undefined), effect: { getComputedTiming: () => ({ endTime: Infinity }) } } as unknown as Animation;
    HTMLElement.prototype.getAnimations = vi.fn(() => [spinner]);
    const { rerender } = render(<Presence>{<Probe label="Sheet" />}</Presence>);
    rerender(<Presence>{null}</Presence>);
    expect(screen.queryByText(/Sheet/)).toBeNull();
  });
});
