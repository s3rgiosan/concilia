import { useCallback, useEffect, useRef, useState } from "react";
import type { Draft } from "../lib/tauri";
import { useLatest } from "../lib/hooks/useLatest";

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; error: unknown };

/** Delay between the last change and the save. */
export const AUTOSAVE_DELAY_MS = 500;

/**
 * Saves the draft shortly after each change. `flush` saves at once, or again after a failed save,
 * and resolves when the draft is stored, or rejects when the save fails. Pending changes are saved when the component
 * unmounts.
 */
export function useDraftAutosave(
  draft: Draft,
  dirty: boolean,
  save: (draft: Draft) => Promise<void>,
): { state: SaveState; flush: () => Promise<void> } {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  /** Whether the last save failed, so the next flush saves again. */
  const failed = useRef(false);
  const latestDraft = useLatest(draft);
  const latestSave = useLatest(save);
  /** Saves run one at a time, in order. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  const write = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = false;
    const snapshot = latestDraft.current;
    setState({ kind: "saving" });
    const run = queue.current
      .catch(() => undefined)
      .then(() => latestSave.current(snapshot))
      .then(
        () => {
          failed.current = false;
          setState((prev) => (pending.current ? prev : { kind: "saved" }));
        },
        (error) => {
          failed.current = true;
          setState({ kind: "failed", error });
          throw error;
        },
      );
    queue.current = run;
    return run;
  }, [latestDraft, latestSave]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    pending.current = true;
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      write().catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
  }, [draft, dirty, write]);

  useEffect(
    () => () => {
      if (pending.current) {
        write().catch(() => undefined);
      }
    },
    [write],
  );

  const flush = useCallback(() => (pending.current || failed.current ? write() : queue.current), [write]);

  return { state, flush };
}
