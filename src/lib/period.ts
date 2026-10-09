import type { TFunction } from "i18next";

export interface Period {
  year: string;
  month: string;
}

export const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;

/** The month to start on: the previous one, since statements arrive after a month ends. */
export function defaultPeriod(now: Date): Period {
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: String(previous.getFullYear()), month: String(previous.getMonth() + 1).padStart(2, "0") };
}

/** This year and the two before it, newest first. */
export function yearOptions(now: Date): string[] {
  const year = now.getFullYear();
  return [String(year), String(year - 1), String(year - 2)];
}

export function monthOptions(t: TFunction): { value: string; label: string }[] {
  return MONTHS.map((month) => ({ value: month, label: t(`form.months.${month}`) }));
}

/** "March 2030", in the current language. */
export function periodLabel(period: Period, t: TFunction): string {
  return `${t(`form.months.${period.month}`)} ${period.year}`;
}
