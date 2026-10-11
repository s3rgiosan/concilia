import i18n, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";

export type Language = "en" | "pt";

/** The language to show for a saved choice: the choice itself, or the system's when none is saved. */
export function resolveLanguage(saved: Language | null, systemLanguage: string): Language {
  if (saved) {
    return saved;
  }
  return systemLanguage.toLowerCase().startsWith("pt") ? "pt" : "en";
}

/** Each language's strings, which load the first time that language is shown. */
const LOCALES: Record<Language, () => Promise<{ default: object }>> = {
  en: () => import("./locales/en.json"),
  pt: () => import("./locales/pt.json"),
};

const localeBackend: BackendModule = {
  type: "backend",
  init: () => undefined,
  read(language, _namespace, callback) {
    const load = LOCALES[language as Language];
    if (!load) {
      callback(new Error(`no strings for ${language}`), null);
      return;
    }
    load().then(
      (module) => callback(null, module.default),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  },
};

i18n
  .use(initReactI18next)
  .use(localeBackend)
  .init({
    supportedLngs: ["en", "pt"],
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });

/** Switches every string to the saved language, or the system's when none is saved. */
export function applyLanguage(saved: Language | null): Promise<unknown> {
  const language = resolveLanguage(saved, navigator.language);
  document.documentElement.lang = language;
  return i18n.changeLanguage(language);
}

export default i18n;
