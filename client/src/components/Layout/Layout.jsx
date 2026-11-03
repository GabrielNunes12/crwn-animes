import { useRef, useState } from "react";
import { Outlet, ScrollRestoration, useLocation, useNavigation } from "react-router";
import { Header } from "./Header.jsx";
import { Footer } from "./Footer.jsx";
import { ShortcutsDialog } from "../ShortcutsDialog/ShortcutsDialog.jsx";
import { useShortcuts } from "../../hooks/useShortcuts.js";
import { useT } from "../../i18n/useT.js";
import styles from "./Layout.module.css";

export function Layout() {
  const { t } = useT();
  const location = useLocation();
  const navigation = useNavigation();
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef(null);

  useShortcuts({
    "?": () => setHelpOpen(true),
    "/": () => searchRef.current?.focus(),
  });

  const notice = location.state?.notice;

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        {t("nav.skip")}
      </a>
      <div className={styles.progress} data-active={navigation.state !== "idle"} aria-hidden="true" />
      <Header searchRef={searchRef} />
      <main id="main" className={styles.main} tabIndex={-1}>
        {notice && (
          <div className="container">
            <p className="alert alert-info" role="status" style={{ marginBlockStart: "var(--space-4)" }}>
              {t(`notice.${notice}`)}
            </p>
          </div>
        )}
        {/* Keyed by path so each page plays a short CSS entrance. We deliberately do not use
            React <ViewTransition>: an active view transition swallows clicks and a commit
            prepared before the user typed overwrites inputs filled right after page load. */}
        <div key={location.pathname} className="route-enter">
          <Outlet />
        </div>
      </main>
      <Footer onShowShortcuts={() => setHelpOpen(true)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ScrollRestoration />
    </div>
  );
}
