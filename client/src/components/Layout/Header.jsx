import { useEffect, useRef, useState } from "react";
import { Form, Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../../auth/useAuth.js";
import { useT } from "../../i18n/useT.js";
import { effectiveTheme, setTheme } from "../../lib/prefs.js";
import { LanguageSelect } from "./LanguageSelect.jsx";
import styles from "./Layout.module.css";

function ThemeToggle() {
  const { t } = useT();
  const [theme, setThemeState] = useState(() => effectiveTheme());
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon ${styles.iconBtn}`}
      onClick={() => {
        setTheme(next);
        setThemeState(next);
      }}
      aria-label={next === "light" ? t("nav.toLight") : t("nav.toDark")}
      title={next === "light" ? t("nav.toLight") : t("nav.toDark")}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      )}
    </button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { t } = useT();
  const navigate = useNavigate();
  const ref = useRef(null);
  const location = useLocation();

  // Close the menu after navigating.
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [location.pathname]);

  if (!user) {
    return (
      <div className={styles.authLinks}>
        <Link className="btn btn-ghost btn-sm" to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>
          {t("nav.login")}
        </Link>
        <Link className="btn btn-primary btn-sm" to="/register">
          {t("nav.signup")}
        </Link>
      </div>
    );
  }
  return (
    <details ref={ref} className={styles.menu}>
      <summary className={styles.menuButton} aria-label={t("nav.userMenu", { name: user.displayName })}>
        <span className={styles.avatar} aria-hidden="true">
          {user.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.menuName}>{user.displayName}</span>
      </summary>
      <div className={styles.menuPanel}>
        <p className={styles.menuEmail}>{user.email}</p>
        <Link to="/account" className={styles.menuItem}>
          {t("nav.account")}
        </Link>
        {user.role === "admin" && (
          <Link to="/admin" className={styles.menuItem}>
            {t("nav.admin")}
          </Link>
        )}
        <button
          type="button"
          className={styles.menuItem}
          onClick={async () => {
            await logout();
            navigate("/");
          }}
        >
          {t("nav.logout")}
        </button>
      </div>
    </details>
  );
}

export function Header({ searchRef }) {
  const { isAdmin } = useAuth();
  const { t } = useT();
  const [params] = useSearchParams();
  const location = useLocation();
  const q = location.pathname === "/search" ? params.get("q") ?? "" : "";

  return (
    <header className={styles.header}>
      <div className={`container ${styles.headerInner}`}>
        <Link to="/" className={styles.logo} aria-label={t("nav.homeLabel")}>
          <svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">
            <defs>
              <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#ff5c9a" />
                <stop offset=".5" stopColor="#8b5cf6" />
                <stop offset="1" stopColor="#3dd9eb" />
              </linearGradient>
            </defs>
            <path d="M8 48 15 18l13 16 4-20 4 20 13-16 7 30Z" fill="url(#logo-g)" />
          </svg>
          <span>
            Crwn <span className="gradient-text">Animes</span>
          </span>
        </Link>

        <nav className={styles.nav} aria-label={t("nav.main")}>
          <NavLink to="/anime" className={styles.navLink}>
            {t("nav.anime")}
          </NavLink>
          <NavLink to="/manga" className={styles.navLink}>
            {t("nav.manga")}
          </NavLink>
          {isAdmin && (
            <NavLink to="/admin" className={styles.navLink}>
              {t("nav.admin")}
            </NavLink>
          )}
        </nav>

        <Form role="search" action="/search" className={styles.search} key={q}>
          <label htmlFor="site-search" className="visually-hidden">
            {t("nav.search")}
          </label>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className={styles.searchIcon}>
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input ref={searchRef} id="site-search" name="q" type="search" defaultValue={q} placeholder={t("nav.searchPlaceholder")} className={styles.searchInput} autoComplete="off" />
          <kbd className={styles.searchKbd} aria-hidden="true">
            /
          </kbd>
        </Form>

        <div className={styles.actions}>
          <LanguageSelect compact />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
