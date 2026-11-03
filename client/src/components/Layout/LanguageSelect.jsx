import { useId } from "react";
import { useT } from "../../i18n/useT.js";
import { LOCALES } from "../../i18n/core.js";
import styles from "./Layout.module.css";

const NAMES = { "pt-BR": "Português (BR)", en: "English" };
const SHORT = { "pt-BR": "PT", en: "EN" };

export function LanguageSelect({ compact = false }) {
  const { t, locale, setLocale } = useT();
  const id = useId();
  return (
    <span className={styles.lang}>
      <label htmlFor={id} className="visually-hidden">
        {t("nav.language")}
      </label>
      <select id={id} className={styles.langSelect} value={locale} onChange={(e) => setLocale(e.target.value)}>
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {compact ? SHORT[l] : NAMES[l]}
          </option>
        ))}
      </select>
    </span>
  );
}
