import { useCallback, useState } from "react";
import { useLatest } from "./useLatest";

/** A function with a fixed identity that calls the latest `fn`, so memoized children it is passed to do not re-render. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useLatest(fn);
  return useCallback((...args: A) => latest.current(...args), [latest]);
}

/** An object of functions with fixed identities that call the latest ones; its keys must not change between renders. */
export function useStableHandlers<T extends { [K in keyof T]: (...args: never[]) => unknown }>(handlers: T): T {
  const latest = useLatest(handlers);
  const [stable] = useState(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(handlers)) {
      out[key] = (...args: unknown[]) => (latest.current as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args);
    }
    return out as T;
  });
  return stable;
}
