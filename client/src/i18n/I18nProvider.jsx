import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I18nContext } from "./context.js";
import { createI18n, LOCALES, loadMessages, messagesLoaded } from "./core.js";
import { initialLocale } from "./locale.js";
import { writeString } from "../lib/storage.js";
import { LOCALE_KEY } from "../lib/prefs.js";

/**
 * `locale` prop forces a starting locale (tests). Its dictionary must already be loaded
 * (main.jsx awaits loadMessages() before the first render). Switching to a locale whose
 * dictionary is not loaded yet keeps the current language until its chunk arrives.
 */
export function I18nProvider({ children, locale: initial }) {
  const [locale, setLocaleState] = useState(() => initial ?? initialLocale());
  const wanted = useRef(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next) => {
    if (!LOCALES.includes(next)) return;
    writeString(LOCALE_KEY, next);
    wanted.current = next;
    if (messagesLoaded(next)) {
      setLocaleState(next);
      return;
    }
    loadMessages(next).then(
      () => {
        if (wanted.current === next) setLocaleState(next); // the last choice wins
      },
      () => {}, // offline and not cached: stay in the current language
    );
  }, []);

  const value = useMemo(() => createI18n(locale, setLocale), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
