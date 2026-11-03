import ptBR from "./pt-BR.json";
import en from "./en.json";

export const LOCALES = ["pt-BR", "en"];
export const DEFAULT_LOCALE = "pt-BR";
export const MESSAGES = { "pt-BR": ptBR, en };

/** Saved choice wins; otherwise English browsers get "en", everyone else pt-BR. */
export function detectLocale(saved, navigatorLanguages = []) {
  if (LOCALES.includes(saved)) return saved;
  for (const lang of navigatorLanguages) {
    const l = String(lang).toLowerCase();
    if (l.startsWith("pt")) return "pt-BR";
    if (l.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}

function lookup(dict, key) {
  let node = dict;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Builds t(key, vars). Missing keys fall back: current locale → pt-BR → en → key.
 * Plural messages are objects keyed by Intl.PluralRules categories ({ one, other }).
 * `{name}` placeholders are interpolated; numbers are formatted for the locale.
 */
export function createTranslator(locale, messages = MESSAGES) {
  const chain = [locale, DEFAULT_LOCALE, "en"].filter((l, i, a) => messages[l] && a.indexOf(l) === i);
  const plural = new Intl.PluralRules(locale);
  const numberFormat = new Intl.NumberFormat(locale);

  return function t(key, vars) {
    let value;
    for (const l of chain) {
      value = lookup(messages[l], key);
      if (value !== undefined) break;
    }
    if (value === undefined || value === null) return key;
    if (typeof value === "object") {
      const n = Number(vars?.count ?? 0);
      value = value[plural.select(n)] ?? value.other;
      if (typeof value !== "string") return key;
    }
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (match, name) => {
      if (!(name in vars)) return match;
      const v = vars[name];
      return typeof v === "number" ? numberFormat.format(v) : String(v);
    });
  };
}

/** Everything components get from useT(). */
export function createI18n(locale, setLocale = () => {}) {
  const t = createTranslator(locale);
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return {
    locale,
    setLocale,
    t,
    formatNumber: (n) => nf.format(n),
    formatDate: (d) => (d ? df.format(new Date(d)) : ""),
    formatRelative: (d) => {
      if (!d) return "";
      const diff = (new Date(d).getTime() - Date.now()) / 1000;
      const abs = Math.abs(diff);
      if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
      if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
      if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
      return df.format(new Date(d));
    },
    /** Translated message for an ApiError (by code), falling back to the server text. */
    errorMessage: (err) => {
      if (!err) return "";
      if (err.code) {
        const key = `errors.${err.code}`;
        const msg = t(key);
        if (msg !== key) return msg;
      }
      return err.message || t("errors.generic");
    },
  };
}
