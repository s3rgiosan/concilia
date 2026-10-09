import { useCallback, useEffect, useRef, useState } from "react";
import type { RunHandle, RunEvent } from "../tauri";

export type RunState<T> =
  | { phase: "idle" }
  | { phase: "running"; events: RunEvent[]; cancelling: boolean }
  | { phase: "succeeded"; events: RunEvent[]; result: T }
  | { phase: "failed"; events: RunEvent[]; error: unknown };

/**
 * Runs one reconcile or scan at a time and follows its progress. A run still going when the
 * component unmounts is cancelled.
 */
export function useRun<T>(): {
  state: RunState<T>;
  start: (launch: (onEvent: (event: RunEvent) => void) => RunHandle<T>) => void;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<RunState<T>>({ phase: "idle" });
  const handle = useRef<RunHandle<T> | null>(null);
  /** Counts runs, so callbacks from a run that was replaced do nothing. */
  const generation = useRef(0);

  useEffect(
    () => () => {
      handle.current?.cancel().catch(() => undefined);
    },
    [],
  );

  const start = useCallback((launch: (onEvent: (event: RunEvent) => void) => RunHandle<T>) => {
    const events: RunEvent[] = [];
    generation.current += 1;
    const mine = generation.current;
    setState({ phase: "running", events: [], cancelling: false });
    const current = launch((event) => {
      if (generation.current !== mine) {
        return;
      }
      events.push(event);
      setState((prev) => (prev.phase === "running" ? { ...prev, events: [...events] } : prev));
    });
    handle.current = current;
    current.promise.then(
      (result) => {
        if (handle.current === current) {
          handle.current = null;
          setState({ phase: "succeeded", events: [...events], result });
        }
      },
      (error) => {
        if (handle.current === current) {
          handle.current = null;
          setState({ phase: "failed", events: [...events], error });
        }
      },
    );
  }, []);

  const cancel = useCallback(() => {
    const current = handle.current;
    if (!current) {
      return;
    }
    setState((prev) => (prev.phase === "running" ? { ...prev, cancelling: true } : prev));
    current.cancel().catch((e) => console.error("could not cancel the run", e));
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    handle.current = null;
    setState({ phase: "idle" });
  }, []);

  return { state, start, cancel, reset };
}
