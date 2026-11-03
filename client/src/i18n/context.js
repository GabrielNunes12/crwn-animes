import { createContext } from "react";
import { createI18n, DEFAULT_LOCALE } from "./core.js";

export const I18nContext = createContext(createI18n(DEFAULT_LOCALE));
