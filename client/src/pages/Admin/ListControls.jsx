import { useId } from "react";
import { useT } from "../../i18n/useT.js";
import styles from "./Admin.module.css";

/**
 * The list's h2 (focus target after Previous/Next). While searching it reads as results
 * ("11 results for “x”"); on multi-page lists its name ends with ", page x of y".
 */
export function ListHeading({ list, id, ref, children }) {
  const { t } = useT();
  return (
    <h2 id={id} ref={ref} tabIndex={-1}>
      {list.q ? t("admin.list.resultsFor", { count: list.total, q: list.q }) : children}
      {list.pageCount > 1 && <span className="visually-hidden">{t("admin.list.pageSuffix", { page: list.page + 1, pages: list.pageCount })}</span>}
    </h2>
  );
}

/** Search box + live "N results" line for a useAdminList() list. */
export function ListSearch({ list, label }) {
  const { t } = useT();
  const id = useId();
  return (
    <div className={styles.listBar}>
      <div role="search" aria-label={label} className={styles.listSearch}>
        <label htmlFor={`${id}-q`} className="visually-hidden">
          {label}
        </label>
        <input
          id={`${id}-q`}
          className="input"
          type="search"
          value={list.query}
          onChange={(e) => list.setQuery(e.target.value)}
          placeholder={t("admin.list.searchPlaceholder")}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {/* aria-live (not role=status) so the tab's own status message stays the only status. */}
      <p className="hint" aria-live="polite" aria-busy={list.loading || undefined}>
        {list.loaded && !list.loading ? t(list.q ? "admin.list.resultsFor" : "admin.list.results", { count: list.total, q: list.q }) : ""}
      </p>
    </div>
  );
}

/** Previous / "Page x of y" / Next. Hidden when everything fits on one page. */
export function Pager({ list }) {
  const { t } = useT();
  if (!list.loaded || list.pageCount <= 1) return null;
  const atStart = list.page === 0;
  const atEnd = list.page >= list.pageCount - 1;
  // aria-disabled (not disabled) keeps focus on the button while the next page loads.
  const go = (index, blocked) => () => {
    if (!blocked && !list.loading) list.goTo(index);
  };
  return (
    <nav className={styles.pager} aria-label={t("admin.list.pagination")}>
      <button type="button" className="btn btn-sm" aria-disabled={atStart || undefined} onClick={go(list.page - 1, atStart)}>
        <span aria-hidden="true">←</span> {t("admin.list.previous")}
      </button>
      <p className={styles.pageOf}>{t("admin.list.pageOf", { page: list.page + 1, pages: list.pageCount })}</p>
      <button type="button" className="btn btn-sm" aria-disabled={atEnd || undefined} onClick={go(list.page + 1, atEnd)}>
        {t("admin.list.next")} <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}

/** Empty-state text: "No results for …" while searching, else the list's own empty text. */
export function ListEmpty({ list, children }) {
  const { t } = useT();
  if (!list.loaded || list.loading || list.error || list.total > 0) return null;
  return <p className="card muted">{list.q ? t("admin.list.noResults", { q: list.q }) : children}</p>;
}
