import type { TFunction } from "i18next";
import type { PeriodSummary } from "./tauri";

export interface Period {
  year: string;
  month: string;
}

export const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;

/** The first year the New Month sheet offers. */
export const FIRST_YEAR = 2000;

/** The month to start on: the previous one, since statements arrive after a month ends. */
export function defaultPeriod(now: Date): Period {
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: String(previous.getFullYear()), month: String(previous.getMonth() + 1).padStart(2, "0") };
}

/** Next year down to 2000, newest first. */
export function yearOptions(now: Date): string[] {
  const years: string[] = [];
  for (let year = now.getFullYear() + 1; year >= FIRST_YEAR; year -= 1) {
    years.push(String(year));
  }
  return years;
}

export function monthOptions(t: TFunction): { value: string; label: string }[] {
  return MONTHS.map((month) => ({ value: month, label: t(`form.months.${month}`) }));
}

/** "March 2030", in the current language. */
export function periodLabel(period: Period, t: TFunction): string {
  return `${t(`form.months.${period.month}`)} ${period.year}`;
}

/** "2030-03": identifies a month in storage and in maps. */
export function periodKey(period: Period): string {
  return `${period.year}-${period.month}`;
}

/** The month a key names, or null when the key is not a valid "YYYY-MM". */
export function parsePeriodKey(key: string): Period | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  return match ? { year: match[1], month: match[2] } : null;
}

/** A month with nothing in it yet. */
export function emptySummary(period: Period): PeriodSummary {
  return { year: period.year, month: period.month, status: "empty", receipts: 0, transactions: 0, pending: 0 };
}

/**
 * The months the backend listed plus `extra` months it does not know about (as empty months),
 * each once, newest first.
 */
export function mergePeriods(listed: PeriodSummary[], extra: Period[]): PeriodSummary[] {
  const byKey = new Map<string, PeriodSummary>();
  for (const summary of listed) {
    byKey.set(periodKey(summary), summary);
  }
  for (const period of extra) {
    const key = periodKey(period);
    if (!byKey.has(key)) {
      byKey.set(key, emptySummary(period));
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([, summary]) => summary);
}

/** Months grouped under their year, in the order given. */
export function groupByYear(periods: PeriodSummary[]): { year: string; periods: PeriodSummary[] }[] {
  const groups: { year: string; periods: PeriodSummary[] }[] = [];
  for (const summary of periods) {
    const last = groups[groups.length - 1];
    if (last && last.year === summary.year) {
      last.periods.push(summary);
    } else {
      groups.push({ year: summary.year, periods: [summary] });
    }
  }
  return groups;
}

export type DotTone = "gray" | "yellow" | "orange" | "green";

/** The dot colour and label that describe where a month stands. */
export function statusLine(summary: PeriodSummary, t: TFunction): { tone: DotTone; label: string } {
  switch (summary.status) {
    case "ready":
      return {
        tone: "yellow",
        label: summary.receipts > 0 ? t("month.status.readyReceipts", { count: summary.receipts }) : t("month.status.ready"),
      };
    case "in_review":
      return {
        tone: "orange",
        label: summary.pending > 0 ? t("month.status.inReviewPending", { count: summary.pending }) : t("month.status.inReview"),
      };
    case "finalized":
      return { tone: "green", label: t("month.status.finalized") };
    case "empty":
    default:
      return { tone: "gray", label: t("month.status.empty") };
  }
}

/** Whether the month has been matched, so it opens in the review. */
export function isReviewable(summary: PeriodSummary): boolean {
  return summary.status === "in_review" || summary.status === "finalized";
}
