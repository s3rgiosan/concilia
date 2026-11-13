const LOCALES: Record<string, string> = { en: "en-GB", pt: "pt-PT" };

const numberFormats = new Map<string, Intl.NumberFormat>();

/** The formatter for these options, built once per locale and options. */
function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, formatter);
  }
  return formatter;
}

function format(cents: number, currency: string | null, language: string, signDisplay: "auto" | "exceptZero"): string {
  const locale = LOCALES[language] ?? "en-GB";
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
  try {
    return numberFormat(locale, { style: "currency", currency: code, signDisplay }).format(cents / 100);
  } catch {
    const sign = signDisplay === "exceptZero" && cents > 0 ? "+" : "";
    return `${sign}${(cents / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

/** A whole-number percentage as text in the given language: "74%" in English, "74 %" in Portuguese. */
export function formatPercent(percent: number, language: string): string {
  const locale = LOCALES[language] ?? "en-GB";
  const digits = numberFormat(locale, { maximumFractionDigits: 0 }).format(percent);
  return language === "pt" ? `${digits}\u00a0%` : `${digits}%`;
}

/** An amount in cents as currency text in the given language, such as "€10.00" or "10,00 €". */
export function formatMoney(cents: number, currency: string | null, language: string): string {
  return format(cents, currency, language, "auto");
}

/** Like `formatMoney`, with a sign on every amount but zero: "+€10.00", "-€10.00". */
export function formatSignedMoney(cents: number, currency: string | null, language: string): string {
  return format(cents, currency, language, "exceptZero");
}
