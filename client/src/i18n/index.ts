import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import pt from './locales/pt.json';

// Boot language is injected synchronously by Electron preload (read from
// electron-store, passed via additionalArguments). This avoids the English
// flash for non-English users on cold launch / server fork reload.
// Window.concilia is typed in client/src/electron-bridge.d.ts.
const bootLanguage = (typeof window !== 'undefined' && window.concilia?.bootLanguage) || 'en';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    pt: { translation: pt },
  },
  lng: bootLanguage,
  fallbackLng: 'en',
  supportedLngs: ['en', 'pt'],
  interpolation: { escapeValue: false },
});

export default i18n;
