import { useEffect, useRef, useState } from "react";
import { remainingMs, WINDOW, type Sample } from "../eta";
import type { RunEvent } from "../tauri";

/**
 * Milliseconds left to read the run's receipts, at the rate measured from when each count
 * arrived, or null while there is no estimate. `events` is the running run's events, or null
 * between runs.
 */
export function useExtractionEta(events: RunEvent[] | null): number | null {
  const [samples, setSamples] = useState<Sample[]>([]);
  const seen = useRef(0);

  useEffect(() => {
    const restart = events === null || events.length < seen.current;
    const from = restart ? 0 : seen.current;
    const now = Date.now();
    const fresh: Sample[] = [];
    for (const event of events?.slice(from) ?? []) {
      if (event.step === "extracting") {
        fresh.push({ time: now, current: event.current });
      }
    }
    seen.current = events?.length ?? 0;
    if (restart || fresh.length > 0) {
      setSamples((prev) => [...(restart ? [] : prev), ...fresh].slice(-(WINDOW + 1)));
    }
  }, [events]);

  const last = events?.[events.length - 1];
  if (last?.step !== "extracting") {
    return null;
  }
  return remainingMs(samples, last.total);
}
