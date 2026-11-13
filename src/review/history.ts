// An undo history of values: the present, the values before it and the values undone after it.

import { useCallback, useState } from "react";

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/** How many steps undo can go back. */
export const HISTORY_LIMIT = 100;

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Makes `next` the present. The old present can be undone to; anything undone is forgotten. */
export function record<T>(history: History<T>, next: T, limit = HISTORY_LIMIT): History<T> {
  if (Object.is(next, history.present)) {
    return history;
  }
  const past = [...history.past, history.present];
  return { past: past.slice(Math.max(0, past.length - limit)), present: next, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) {
    return history;
  }
  const previous = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) {
    return history;
  }
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Applies `fn` to every value, so a change that is not a step (a rescan) reaches undone values too. */
export function mapHistory<T>(history: History<T>, fn: (value: T) => T): History<T> {
  return { past: history.past.map(fn), present: fn(history.present), future: history.future.map(fn) };
}

export interface HistoryControls<T> {
  present: T;
  /** The value undo would return to, or undefined when there is none. */
  previous: T | undefined;
  /** The value redo would return to, or undefined when there is none. */
  next: T | undefined;
  canUndo: boolean;
  canRedo: boolean;
  record: (next: T | ((present: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  /** Starts over from `value`, with nothing to undo or redo. */
  reset: (value: T) => void;
  map: (fn: (value: T) => T) => void;
}

/** A value with undo and redo, keeping at most `limit` steps. */
export function useHistory<T>(initial: T, limit = HISTORY_LIMIT): HistoryControls<T> {
  const [history, setHistory] = useState<History<T>>(() => startHistory(initial));

  const recordStep = useCallback(
    (next: T | ((present: T) => T)) =>
      setHistory((prev) => record(prev, typeof next === "function" ? (next as (present: T) => T)(prev.present) : next, limit)),
    [limit],
  );
  const undoStep = useCallback(() => setHistory(undo), []);
  const redoStep = useCallback(() => setHistory(redo), []);
  const reset = useCallback((value: T) => setHistory(startHistory(value)), []);
  const map = useCallback((fn: (value: T) => T) => setHistory((prev) => mapHistory(prev, fn)), []);

  return {
    present: history.present,
    previous: history.past[history.past.length - 1],
    next: history.future[0],
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    record: recordStep,
    undo: undoStep,
    redo: redoStep,
    reset,
    map,
  };
}
