import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useSafeStorage } from "../lib/hooks/useSafeStorage";

/** Keyboard step, in pixels. */
const STEP = 10;
/** How far past the minimum a drag goes before a collapsible pane closes, in pixels. */
const COLLAPSE_DISTANCE = 40;
/** Class on the root element while a divider is dragged: the col-resize cursor everywhere, no pane transitions. */
const RESIZING_CLASS = "is-resizing";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A pane width kept in localStorage, always within `min` and `max`. */
export function useStoredWidth(key: string, fallback: number, min: number, max: number): [number, (width: number) => void] {
  const [stored, setStored] = useSafeStorage(key, String(fallback));
  const parsed = Number(stored);
  const width = Number.isFinite(parsed) ? clamp(Math.round(parsed), min, max) : fallback;
  return [width, (next: number) => setStored(String(clamp(Math.round(next), min, max)))];
}

/**
 * The divider on a pane's edge that resizes it: drag it, or focus it and use ←/→, Home and End.
 * `grows` is the direction that widens the pane: right for a pane on the leading side, left for
 * one on the trailing side. The pane's width is the CSS custom property `variable` on `scope`:
 * a drag writes it there on every move and reports the final width through `onResize` on
 * release. Dragging past the minimum runs `onCollapse` when given.
 */
export function ResizeHandle({
  label,
  width,
  min,
  max,
  grows,
  scope,
  variable,
  onResize,
  onCollapse,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  grows: "left" | "right";
  /** The element that sets `variable` for the pane and the toolbar above it. */
  scope: RefObject<HTMLElement | null>;
  variable: string;
  onResize: (width: number) => void;
  onCollapse?: () => void;
}) {
  const drag = useRef<{ x: number; width: number; current: number } | null>(null);
  const direction = grows === "right" ? 1 : -1;

  function preview(element: HTMLElement, next: number) {
    scope.current?.style.setProperty(variable, `${next}px`);
    element.setAttribute("aria-valuenow", String(next));
  }

  function end(element: HTMLElement, pointerId: number) {
    drag.current = null;
    document.documentElement.classList.remove(RESIZING_CLASS);
    element.releasePointerCapture?.(pointerId);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.documentElement.classList.add(RESIZING_CLASS);
    drag.current = { x: e.clientX, width, current: width };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) {
      return;
    }
    const raw = start.width + (e.clientX - start.x) * direction;
    if (onCollapse && raw < min - COLLAPSE_DISTANCE) {
      end(e.currentTarget, e.pointerId);
      onResize(min);
      onCollapse();
      return;
    }
    const next = Math.round(clamp(raw, min, max));
    if (next !== start.current) {
      start.current = next;
      preview(e.currentTarget, next);
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    end(e.currentTarget, e.pointerId);
    if (start && start.current !== start.width) {
      onResize(start.current);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = width + STEP * direction;
        break;
      case "ArrowLeft":
        next = width - STEP * direction;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    onResize(clamp(next, min, max));
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
