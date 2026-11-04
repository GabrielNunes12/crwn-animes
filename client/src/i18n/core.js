export const LOCALES = ["pt-BR", "en"];
export const DEFAULT_LOCALE = "pt-BR";

// Each dictionary is its own chunk, kept out of the entry bundle (docs/API.md v1.7): main.jsx
// loads the visitor's one in parallel with the first route, and I18nProvider loads another
// before switching to it. MESSAGES holds the dictionaries loaded so far.
const IMPORTERS = { "pt-BR": () => import("./pt-BR.json"), en: () => import("./en.json") };
export const MESSAGES = {};

/** Makes `messages` the dictionary of `locale` (tests register both up front). */
export function registerMessages(locale, messages) {
  MESSAGES[locale] = messages;
}

export const messagesLoaded = (locale) => Boolean(MESSAGES[locale]);

/** Loads (once) the dictionary of a supported locale. Rejects when its chunk cannot be fetched. */
export async function loadMessages(locale) {
  if (!MESSAGES[locale]) {
    if (!Object.hasOwn(IMPORTERS, locale)) throw new Error(`Unsupported locale: ${locale}`);
    MESSAGES[locale] = (await IMPORTERS[locale]()).default;
  }
  return MESSAGES[locale];
}

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
  const chain = [locale, DEFAULT_LOCALE, "en"].filter((l, i, a) => a.indexOf(l) === i);
  const plural = new Intl.PluralRules(locale);
  const numberFormat = new Intl.NumberFormat(locale);

  return function t(key, vars) {
    let value;
    // Dictionaries load lazily: only those present when t() runs take part in the fallback.
    for (const l of chain) {
      if (!messages[l]) continue;
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
  /** Translated message for one invalid field (server `details` key). */
  const fieldError = (field) => {
    const key = `errors.fields.${field}`;
    const msg = t(key);
    return msg === key ? t("errors.fieldInvalid") : msg;
  };
  /** { field: translated message } for a VALIDATION_ERROR's details. */
  const fieldErrors = (err) => {
    if (err?.code !== "VALIDATION_ERROR" || !err.details || typeof err.details !== "object") return {};
    return Object.fromEntries(Object.keys(err.details).map((f) => [f, fieldError(f)]));
  };
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
    fieldError,
    fieldErrors,
    /**
     * Translated message for an error. ApiErrors are mapped by `code`; unknown
     * codes become errors.generic (the server's English text is never shown).
     * VALIDATION_ERROR details are translated per field. Errors without a code
     * are client-side and already translated.
     */
    errorMessage: (err) => {
      if (!err) return "";
      if (!err.code) return err.message || t("errors.generic");
      const key = `errors.${err.code}`;
      let msg = t(key);
      if (msg === key) msg = t("errors.generic");
      const fields = Object.values(fieldErrors(err));
      return fields.length ? `${msg} ${[...new Set(fields)].join(" ")}` : msg;
    },
  };
}
