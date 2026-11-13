import type { TFunction } from "i18next";

/** When a count of receipts read was reported, in milliseconds since the epoch. */
export interface Sample {
  time: number;
  current: number;
}

/** Receipts read before an estimate shows. */
const MIN_DONE = 3;

/** How many recent samples the rate is measured over, so a burst of cached receipts fades out. */
export const WINDOW = 10;

/**
 * Milliseconds left to read `total` receipts at the rate measured over the latest samples, or
 * null before `MIN_DONE` receipts are read, once all are read, or while no rate can be measured.
 */
export function remainingMs(samples: Sample[], total: number): number | null {
  const latest = samples[samples.length - 1];
  if (!latest || latest.current < MIN_DONE || latest.current >= total) {
    return null;
  }
  const base = samples[Math.max(0, samples.length - 1 - WINDOW)];
  const read = latest.current - base.current;
  const elapsed = latest.time - base.time;
  if (read <= 0 || elapsed <= 0) {
    return null;
  }
  return ((total - latest.current) * elapsed) / read;
}

/** "About 3 min left", in whole minutes, or "Less than a minute left" under a minute. */
export function remainingText(ms: number, t: TFunction): string {
  if (ms < 60_000) {
    return t("progress.lessThanMinute");
  }
  return t("progress.minutesLeft", { count: Math.round(ms / 60_000) });
}
