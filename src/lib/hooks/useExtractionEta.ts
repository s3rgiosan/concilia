import { useEffect, useRef, useState } from "react";
import { remainingMs, WINDOW, type Sample } from "../eta";
import type { RunEvent } from "../tauri";

type Reading = Extract<RunEvent, { step: "extracting" }>;

/**
 * Milliseconds left to read the run's receipts, at the rate measured from when each count
 * arrived, or null while there is no estimate. `events` is the running run's events, or null
 * between runs.
 */
export function useExtractionEta(events: RunEvent[] | null): number | null {
  const [samples, setSamples] = useState<Sample[]>([]);
  const seen = useRef<Reading | null>(null);

  const last = events?.[events.length - 1];
  const reading = last?.step === "extracting" ? last : null;

  useEffect(() => {
    if (reading === seen.current) {
      return;
    }
    seen.current = reading;
    if (reading === null) {
      setSamples((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const sample: Sample = { time: Date.now(), current: reading.current };
    setSamples((prev) => [...prev, sample].slice(-(WINDOW + 1)));
  }, [reading]);

  if (reading === null) {
    return null;
  }
  return remainingMs(samples, reading.total);
}
