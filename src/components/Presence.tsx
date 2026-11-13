import { createContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** True inside content that is leaving: its keyboard handling and focus trap stand down. */
export const ExitingContext = createContext(false);

/** Longest an exit may take before the content unmounts anyway, in milliseconds. */
const EXIT_LIMIT_MS = 500;

/**
 * Animations on `root` and its descendants that end: CSS transitions and finite keyframe
 * animations. Infinite ones, such as a spinner, never finish and are left out.
 */
function finiteAnimations(root: HTMLElement): Animation[] {
  if (typeof root.getAnimations !== "function") {
    return [];
  }
  return root.getAnimations({ subtree: true }).filter((animation) => {
    const end = animation.effect?.getComputedTiming().endTime;
    return typeof end === "number" && Number.isFinite(end);
  });
}

/**
 * Shows `children` and animates it in and out with CSS. Content that appears after the first
 * render gets `data-presence="enter"`, which the stylesheets pair with `@starting-style`. When
 * `children` becomes null, the last content stays mounted with `data-presence="exit"` and is
 * inert until its transitions end, then unmounts. Content that returns during the exit takes
 * over the same elements, so each transition reverses from where it is.
 */
export function Presence({ children }: { children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const last = useRef<ReactNode>(children);
  const [entered, setEntered] = useState(children == null);
  const [done, setDone] = useState(false);

  const present = children != null;
  if (present) {
    last.current = children;
    if (done) {
      setDone(false);
    }
  } else if (!entered) {
    // Content that leaves before any entry still animates the next one in.
    setEntered(true);
  }
  const exiting = !present && last.current != null && !done;

  useLayoutEffect(() => {
    if (!exiting || !wrapper.current) {
      return;
    }
    const animations = finiteAnimations(wrapper.current);
    if (animations.length === 0) {
      setDone(true);
      return;
    }
    let cancelled = false;
    const finish = () => {
      if (!cancelled) {
        setDone(true);
      }
    };
    const limit = window.setTimeout(finish, EXIT_LIMIT_MS);
    Promise.all(animations.map((animation) => animation.finished)).then(finish, () => undefined);
    return () => {
      cancelled = true;
      window.clearTimeout(limit);
    };
  }, [exiting]);

  const content = present ? children : exiting ? last.current : null;
  if (content == null) {
    return null;
  }
  return (
    <ExitingContext value={exiting}>
      <div ref={wrapper} className="presence" data-presence={exiting ? "exit" : entered ? "enter" : "static"} inert={exiting}>
        {content}
      </div>
    </ExitingContext>
  );
}
