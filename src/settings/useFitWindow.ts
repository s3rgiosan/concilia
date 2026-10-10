import { useEffect, type RefObject } from "react";
import { isPreview } from "../lib/preview";
import { setWindowSize } from "../lib/tauri";

/** Width of the Settings window; src-tauri/src/windows.rs creates it with the same value. */
export const SETTINGS_WIDTH = 640;
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 640;
const DURATION_MS = 160;

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Sizes the Settings window to its content: the pane switcher plus the pane's own height, within
 * limits (a taller pane scrolls). The first size applies at once and later ones animate.
 */
export function useFitWindow(
  bar: RefObject<HTMLElement | null>,
  pane: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  ready: boolean,
) {
  useEffect(() => {
    const barEl = bar.current;
    const paneEl = pane.current;
    const contentEl = content.current;
    if (!ready || !barEl || !paneEl || !contentEl || isPreview() || typeof ResizeObserver === "undefined") {
      return;
    }
    let current: number | null = null;
    let frame = 0;

    function target(): number {
      const style = getComputedStyle(paneEl as HTMLElement);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const total = (barEl as HTMLElement).offsetHeight + padding + (contentEl as HTMLElement).offsetHeight;
      return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(total)));
    }

    function apply(height: number) {
      setWindowSize(SETTINGS_WIDTH, height).catch((e) => console.error("could not resize the window", e));
    }

    function fit() {
      const to = target();
      cancelAnimationFrame(frame);
      if (current === null) {
        current = to;
        apply(to);
        return;
      }
      const from = current;
      if (from === to) {
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / DURATION_MS);
        current = Math.round(from + (to - from) * easeOut(progress));
        apply(current);
        if (progress < 1) {
          frame = requestAnimationFrame(step);
        }
      };
      frame = requestAnimationFrame(step);
    }

    const observer = new ResizeObserver(fit);
    observer.observe(contentEl);
    observer.observe(barEl);
    fit();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [bar, pane, content, ready]);
}
