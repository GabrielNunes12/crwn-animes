import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Outlet, ScrollRestoration, useLocation, useNavigation } from "react-router";
import { Header } from "./Header.jsx";
import { Footer } from "./Footer.jsx";
import { ShortcutsDialog } from "../ShortcutsDialog/ShortcutsDialog.jsx";
import { CommandPalette } from "../CommandPalette/CommandPalette.jsx";
import { useShortcuts } from "../../hooks/useShortcuts.js";
import { useT } from "../../i18n/useT.js";
import { isPaletteShortcut } from "../../lib/platform.js";
import styles from "./Layout.module.css";

export function Layout() {
  const { t } = useT();
  const location = useLocation();
  const navigation = useNavigation();
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchRef = useRef(null);

  // ⌘K / Ctrl+K is a modifier shortcut: it works even while typing and is not
  // affected by the "single-key shortcuts" switch. It stays out of the way of
  // other open modal dialogs.
  const onPaletteKey = useEffectEvent((e) => {
    if (!isPaletteShortcut(e) || e.defaultPrevented) return;
    if (paletteOpen) {
      e.preventDefault();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    setPaletteOpen(true);
  });
  useEffect(() => {
    const onKey = (e) => onPaletteKey(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useShortcuts({
    "?": () => setHelpOpen(true),
    "/": () => searchRef.current?.focus(),
  });

  const notice = location.state?.notice;
  // The entrance plays on in-app navigations only: the page the visitor landed on is shown at
  // once (fading it in from opacity 0 would hold back its first paint / LCP, docs/API.md v1.7).
  const [landingPath] = useState(location.pathname);
  const [navigated, setNavigated] = useState(false);
  if (!navigated && location.pathname !== landingPath) setNavigated(true);

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        {t("nav.skip")}
      </a>
      <div className={styles.progress} data-active={navigation.state !== "idle"} aria-hidden="true" />
      <Header searchRef={searchRef} onOpenPalette={() => setPaletteOpen(true)} />
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
        <div key={location.pathname} className={navigated ? "route-enter" : undefined}>
          <Outlet />
        </div>
      </main>
      <Footer onShowShortcuts={() => setHelpOpen(true)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ScrollRestoration />
    </div>
  );
}
