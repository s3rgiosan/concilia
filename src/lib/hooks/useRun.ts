import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RunHandle, RunEvent } from "../tauri";

export type RunState<T> =
  | { phase: "idle" }
  | { phase: "running"; cancelling: boolean }
  | { phase: "succeeded"; result: T }
  | { phase: "failed"; error: unknown };

/**
 * The progress events of the current run: the latest event of each step, in the order the steps
 * last reported. Listeners are told at most once per animation frame, and once more when the run
 * ends, so the components that show progress render per frame and nothing else does.
 */
export interface RunEvents {
  subscribe: (listener: () => void) => () => void;
  /** The current events; the same array until the next notification. */
  get: () => RunEvent[];
}

interface RunEventStore extends RunEvents {
  push: (event: RunEvent) => void;
  /** Notifies listeners of events not yet announced. */
  flush: () => void;
  clear: () => void;
  dispose: () => void;
}

function createRunEvents(): RunEventStore {
  const latest = new Map<RunEvent["step"], RunEvent>();
  const listeners = new Set<() => void>();
  let snapshot: RunEvent[] = [];
  let scheduled: { cancel: () => void } | null = null;
  let stale = false;

  function announce() {
    scheduled?.cancel();
    scheduled = null;
    if (!stale) {
      return;
    }
    stale = false;
    snapshot = [...latest.values()];
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function schedule() {
    if (scheduled) {
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(announce);
      scheduled = { cancel: () => cancelAnimationFrame(frame) };
    } else {
      const timer = setTimeout(announce, 16);
      scheduled = { cancel: () => clearTimeout(timer) };
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
    push(event) {
      latest.delete(event.step);
      latest.set(event.step, event);
      stale = true;
      schedule();
    },
    flush: announce,
    clear() {
      latest.clear();
      stale = true;
      announce();
    },
    dispose() {
      scheduled?.cancel();
      scheduled = null;
    },
  };
}

/** The events of a run, which re-renders the component that calls it once per animation frame at most. */
export function useRunEvents(events: RunEvents): RunEvent[] {
  return useSyncExternalStore(events.subscribe, events.get);
}

/**
 * Runs one reconcile or scan at a time and follows it. `state` changes when the run starts, is
 * asked to stop or ends; its progress is in `events`, which only the components showing progress
 * subscribe to. A run still going when the component unmounts is cancelled.
 */
export function useRun<T>(): {
  state: RunState<T>;
  events: RunEvents;
  start: (launch: (onEvent: (event: RunEvent) => void) => RunHandle<T>) => void;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<RunState<T>>({ phase: "idle" });
  const [store] = useState(createRunEvents);
  const handle = useRef<RunHandle<T> | null>(null);
  /** Counts runs, so callbacks from a run that was replaced do nothing. */
  const generation = useRef(0);

  useEffect(
    () => () => {
      handle.current?.cancel().catch(() => undefined);
      store.dispose();
    },
    [store],
  );

  const start = useCallback(
    (launch: (onEvent: (event: RunEvent) => void) => RunHandle<T>) => {
      generation.current += 1;
      const mine = generation.current;
      store.clear();
      setState({ phase: "running", cancelling: false });
      const current = launch((event) => {
        if (generation.current === mine) {
          store.push(event);
        }
      });
      handle.current = current;
      current.promise.then(
        (result) => {
          if (handle.current === current) {
            handle.current = null;
            store.flush();
            setState({ phase: "succeeded", result });
          }
        },
        (error) => {
          if (handle.current === current) {
            handle.current = null;
            store.flush();
            setState({ phase: "failed", error });
          }
        },
      );
    },
    [store],
  );

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

  return { state, events: store, start, cancel, reset };
}
