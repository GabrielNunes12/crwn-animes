import { useCallback, useEffect, useMemo, useState } from "react";
import { I18nContext } from "./context.js";
import { createI18n, detectLocale, LOCALES } from "./core.js";
import { readString, writeString } from "../lib/storage.js";
import { LOCALE_KEY } from "../lib/prefs.js";

function initialLocale() {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectLocale(readString(LOCALE_KEY), langs);
}

/** `locale` prop forces a starting locale (tests). */
export function I18nProvider({ children, locale: initial }) {
  const [locale, setLocaleState] = useState(() => initial ?? initialLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next) => {
    if (!LOCALES.includes(next)) return;
    writeString(LOCALE_KEY, next);
    setLocaleState(next);
  }, []);

  const value = useMemo(() => createI18n(locale, setLocale), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
