import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useSafeStorage } from "../lib/hooks/useSafeStorage";

/** Keyboard step, in pixels. */
const STEP = 10;

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
 * one on the trailing side.
 */
export function ResizeHandle({
  label,
  width,
  min,
  max,
  grows,
  onResize,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  grows: "left" | "right";
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = grows === "right" ? 1 : -1;

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, width };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start) {
      onResize(clamp(start.width + (e.clientX - start.x) * direction, min, max));
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
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
