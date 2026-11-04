import { readString } from "../lib/storage.js";
import { LOCALE_KEY } from "../lib/prefs.js";
import { detectLocale } from "./core.js";

/** The locale to start with: the saved choice, else the browser's languages (see detectLocale). */
export function initialLocale() {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectLocale(readString(LOCALE_KEY), langs);
}
