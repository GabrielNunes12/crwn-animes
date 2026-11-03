import { useEffect, useRef, useState } from "react";
import { ErrorNotice } from "../Await/AsyncView.jsx";
import { CardGridSkeleton } from "../Skeleton/Skeleton.jsx";
import { Reveal } from "../Reveal/Reveal.jsx";
import { SeriesCard } from "../Cards/SeriesCard.jsx";
import { resultKey } from "../../hooks/useSearchResults.js";
import { useT } from "../../i18n/useT.js";
import styles from "./SearchResults.module.css";

/**
 * Result grid for useSearchResults(): live result count, skeletons, empty state,
 * and a "Load more" button that announces how many results it added.
 */
export function SearchResults({ results, empty, emptyAction, headingId }) {
  const { t, errorMessage } = useT();
  const { key, items, total, loading, stale, loaded, error, hasMore, loadingMore, moreError, loadMore } = results;
  const listRef = useRef(null);
  const [announce, setAnnounce] = useState({ key: null, text: "" });
  const [focusKey, setFocusKey] = useState(null);

  // After the last page loads the button disappears: move focus to the first new result.
  useEffect(() => {
    if (!focusKey || !listRef.current) return;
    const li = [...listRef.current.querySelectorAll("[data-result]")].find((el) => el.dataset.result === focusKey);
    li?.querySelector("a")?.focus();
  }, [focusKey]);

  async function onMore() {
    if (loadingMore) return;
    const { items: fresh, done } = await loadMore();
    if (!fresh.length) return;
    setAnnounce({ key, text: t("search.moreLoaded", { count: fresh.length, shown: items.length + fresh.length, total }) });
    if (done) setFocusKey(resultKey(fresh[0]));
  }

  const ready = loaded && !loading;
  const showSkeleton = loading && !stale;

  return (
    <div className={styles.results}>
      {/* Always mounted so screen readers announce every new count (polite). */}
      <p role="status" className={styles.count} id={headingId ? `${headingId}-count` : undefined}>
        {ready && !error ? t("search.count", { count: total }) : ""}
      </p>
      <p role="status" className="visually-hidden">
        {announce.key === key ? announce.text : ""}
      </p>

      {error ? (
        <ErrorNotice error={error} />
      ) : showSkeleton ? (
        <CardGridSkeleton count={10} kind="series" />
      ) : ready && total === 0 ? (
        <div className="card stack">
          <p>{empty ?? t("search.empty")}</p>
          {emptyAction}
        </div>
      ) : (
        <>
          <ul ref={listRef} className={`grid-cards ${styles.grid}`} role="list" aria-busy={loading || undefined} data-stale={(loading && stale) || undefined}>
            {items.map((item, i) => (
              <Reveal as="li" key={resultKey(item)} index={i % 6} data-result={resultKey(item)}>
                <SeriesCard series={item} section={item.section} showSection />
              </Reveal>
            ))}
          </ul>
          {ready && (hasMore || moreError) && (
            <div className={styles.more}>
              <p className="hint">{t("search.showing", { shown: items.length, total })}</p>
              {moreError && (
                <p className="field-error" role="alert">
                  {errorMessage(moreError)}
                </p>
              )}
              <button type="button" className="btn" onClick={onMore} aria-disabled={loadingMore || undefined} data-busy={loadingMore || undefined}>
                {loadingMore && <span className={styles.spinner} aria-hidden="true" />}
                {t("search.loadMore")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
