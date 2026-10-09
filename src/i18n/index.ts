import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import pt from "./locales/pt.json";

export type Language = "en" | "pt";

/** The language to show for a saved choice: the choice itself, or the system's when none is saved. */
export function resolveLanguage(saved: Language | null, systemLanguage: string): Language {
  if (saved) {
    return saved;
  }
  return systemLanguage.toLowerCase().startsWith("pt") ? "pt" : "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    pt: { translation: pt },
  },
  lng: resolveLanguage(null, navigator.language),
  fallbackLng: "en",
  supportedLngs: ["en", "pt"],
  interpolation: { escapeValue: false },
});

/** Switches every string to the saved language, or the system's when none is saved. */
export function applyLanguage(saved: Language | null): Promise<unknown> {
  const language = resolveLanguage(saved, navigator.language);
  document.documentElement.lang = language;
  return i18n.changeLanguage(language);
}

export default i18n;
