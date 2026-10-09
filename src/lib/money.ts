const LOCALES: Record<string, string> = { en: "en-GB", pt: "pt-PT" };

/** An amount in cents as currency text in the given language, such as "€10.00" or "10,00 €". */
export function formatMoney(cents: number, currency: string | null, language: string): string {
  const locale = LOCALES[language] ?? "en-GB";
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}
