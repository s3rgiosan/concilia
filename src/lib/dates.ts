const LOCALES: Record<string, string> = { en: "en-GB", pt: "pt-PT" };

/** The calendar date of an ISO "YYYY-MM-DD" string, or null when the string is not one. */
function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return null;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function localeFor(language: string): string {
  return LOCALES[language] ?? "en-GB";
}

/** "4 Mar" in English, "4 mar." in Portuguese. Text that is not an ISO date is returned as it is. */
export function shortDate(iso: string, language: string): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return iso;
  }
  const month = new Intl.DateTimeFormat(localeFor(language), { month: "short", timeZone: "UTC" }).format(date);
  return `${date.getUTCDate()} ${month}`;
}

/** "4 March 2030" in English, "4 de março de 2030" in Portuguese. Text that is not an ISO date is returned as it is. */
export function longDate(iso: string, language: string): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return iso;
  }
  return new Intl.DateTimeFormat(localeFor(language), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
