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

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** The formatter for these options, built once per locale and options. */
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, formatter);
  }
  return formatter;
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
  const month = dateFormat(localeFor(language), { month: "short", timeZone: "UTC" }).format(date);
  return `${date.getUTCDate()} ${month}`;
}

/** "4 March 2030" in English, "4 de março de 2030" in Portuguese. Text that is not an ISO date is returned as it is. */
export function longDate(iso: string, language: string): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return iso;
  }
  return dateFormat(localeFor(language), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
