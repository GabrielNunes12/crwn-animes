import { useContext } from "react";
import { I18nContext } from "./context.js";

/** const { t, locale, setLocale, formatNumber, formatDate, errorMessage } = useT(); */
export function useT() {
  return useContext(I18nContext);
}
