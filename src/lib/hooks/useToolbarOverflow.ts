import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** The width the toolbar holding `trailing` has left for it after the leading area and the title's minimum width. */
function room(header: HTMLElement, trailing: HTMLElement): number {
  let others = 0;
  for (const child of Array.from(header.children)) {
    if (child === trailing || !(child instanceof HTMLElement)) {
      continue;
    }
    const minWidth = parseFloat(getComputedStyle(child).minWidth) || 0;
    others += child.classList.contains("titlebar__heading") ? minWidth : child.offsetWidth;
  }
  return header.clientWidth - others;
}

/**
 * How compact the toolbar's trailing controls must be to fit, from 0 (everything shown) to
 * `levels`. A level steps up while the controls overflow the toolbar, and steps back down once
 * the toolbar has room for what the lower level measured. A change of `contentKey` (other
 * labels, other controls) starts over from 0. Window resizes are followed through ResizeObserver
 * where it exists.
 */
export function useToolbarOverflow(slot: HTMLElement | null, levels: number, contentKey: string): number {
  const [level, setLevel] = useState(0);
  const latestLevel = useRef(level);
  latestLevel.current = level;
  /** The width the controls needed at each level that overflowed. */
  const needs = useRef<number[]>([]);

  useLayoutEffect(() => {
    needs.current = [];
    setLevel(0);
  }, [contentKey]);

  const check = useCallback(() => {
    const header = slot?.closest<HTMLElement>(".titlebar");
    const trailing = header?.querySelector<HTMLElement>(".titlebar__trailing");
    if (!header || !trailing) {
      return;
    }
    const current = latestLevel.current;
    if (trailing.scrollWidth > trailing.clientWidth + 1) {
      if (current < levels) {
        needs.current[current] = trailing.scrollWidth;
        setLevel(current + 1);
      }
      return;
    }
    const need = current > 0 ? needs.current[current - 1] : undefined;
    if (need !== undefined && room(header, trailing) >= need) {
      setLevel(current - 1);
    }
  }, [slot, levels]);

  useLayoutEffect(() => {
    check();
  }, [check, level, contentKey]);

  useLayoutEffect(() => {
    const header = slot?.closest<HTMLElement>(".titlebar");
    if (!header || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(check);
    observer.observe(header);
    // The leading area changes width with the sidebar while the toolbar keeps its own.
    const leading = header.querySelector(".titlebar__leading");
    if (leading) {
      observer.observe(leading);
    }
    return () => observer.disconnect();
  }, [slot, check]);

  return level;
}
