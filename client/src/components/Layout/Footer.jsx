import { Link } from "react-router";
import { useT } from "../../i18n/useT.js";
import { LanguageSelect } from "./LanguageSelect.jsx";
import styles from "./Layout.module.css";

export function Footer({ onShowShortcuts }) {
  const { t } = useT();
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerInner}`}>
        <div className="stack" style={{ "--stack-gap": "var(--space-2)" }}>
          <p className={styles.footerBrand}>
            Crwn <span className="gradient-text">Animes</span>
          </p>
          <p className="hint">{t("footer.note")}</p>
        </div>
        <nav aria-label={t("footer.label")} className={styles.footerNav}>
          <Link to="/privacy">{t("footer.privacy")}</Link>
          <Link to="/anime">{t("nav.anime")}</Link>
          <Link to="/manga">{t("nav.manga")}</Link>
          <button type="button" className={styles.linkButton} onClick={onShowShortcuts}>
            {t("footer.shortcuts")}
          </button>
          <LanguageSelect />
        </nav>
      </div>
    </footer>
  );
}
