import { useCallback, useEffect, useRef, useState } from "react";
import type { Draft } from "../lib/tauri";
import { errorKind } from "../lib/errors";
import { useLatest } from "../lib/hooks/useLatest";

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; error: unknown };

/** Delay between the last change and the save. */
export const AUTOSAVE_DELAY_MS = 500;

/** Delay before a save refused while a job runs on the month is tried again. */
export const AUTOSAVE_RETRY_MS = 1000;

export interface UnmountSaveOptions {
  /** Runs when the save on unmount succeeds, after the component can no longer show it. */
  onSaved?: () => void;
  /** Runs when the save on unmount fails, so the user still hears about the lost change. */
  onError?: (error: unknown) => void;
}

/**
 * Saves the draft shortly after each change. `flush` saves at once, or again after a failed save,
 * and resolves when the draft is stored, or rejects when the save fails. `forget` clears the save
 * state for a draft loaded afresh. Pending changes, and changes whose last save failed, are saved
 * when the component unmounts. The result of that save goes to `onSaved` or `onError`.
 *
 * The backend refuses a save while a job runs on the month. The change then stays pending and the
 * save runs again after a delay, until the job ends or the component unmounts.
 */
export function useDraftAutosave(
  draft: Draft,
  dirty: boolean,
  save: (draft: Draft) => Promise<void>,
  { onSaved, onError }: UnmountSaveOptions = {},
): { state: SaveState; flush: () => Promise<void>; forget: () => void } {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  /** Whether the last save failed, so the next flush saves again. */
  const failed = useRef(false);
  const latestDraft = useLatest(draft);
  const latestSave = useLatest(save);
  const latestOnSaved = useLatest(onSaved);
  const latestOnError = useLatest(onError);
  /** Saves run one at a time, in order. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

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
          const busy = errorKind(error) === "busy";
          if (busy && mounted.current && !timer.current) {
            pending.current = true;
            timer.current = setTimeout(() => {
              write().catch(() => undefined);
            }, AUTOSAVE_RETRY_MS);
          }
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (pending.current || failed.current) {
        write().then(
          () => latestOnSaved.current?.(),
          (error) => latestOnError.current?.(error),
        );
      }
    },
    [write, latestOnSaved, latestOnError],
  );

  const flush = useCallback(() => (pending.current || failed.current ? write() : queue.current), [write]);

  const forget = useCallback(() => {
    if (!pending.current) {
      failed.current = false;
      queue.current = queue.current.catch(() => undefined);
      setState({ kind: "idle" });
    }
  }, []);

  return { state, flush, forget };
}
