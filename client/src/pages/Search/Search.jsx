import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { SearchResults } from "../../components/SearchResults/SearchResults.jsx";
import { useGenres } from "../../hooks/useGenres.js";
import { useSearchResults } from "../../hooks/useSearchResults.js";
import { useTitle } from "../../hooks/useTitle.js";
import { useT } from "../../i18n/useT.js";
import { DEBOUNCE_MS, MAX_Q, readSearchParams, SEARCH_SORTS } from "../../lib/search.js";
import styles from "./Search.module.css";

/** Segmented control built from native radios (arrow keys move between them for free). */
function SectionFilter({ value, onChange }) {
  const { t } = useT();
  const options = [
    ["", t("search.sectionAll")],
    ["anime", t("common.anime")],
    ["manga", t("common.manga")],
  ];
  return (
    <fieldset className={styles.segmented}>
      <legend className={styles.legend}>{t("search.sectionLabel")}</legend>
      <div className={styles.segments}>
        {options.map(([v, label]) => (
          <label key={v || "all"} className={styles.segment}>
            <input type="radio" name="section" value={v} checked={value === v} onChange={() => onChange(v)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Component() {
  const { t } = useT();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { q, section, genre, sort } = readSearchParams(searchParams);
  const genres = useGenres();
  const results = useSearchResults({ q, section, genre, sort });

  // The text box is a draft of `q`: typing updates the URL after a pause, and
  // back/forward (or the header search) updates the draft.
  const [draft, setDraft] = useState(q);
  const [seenQ, setSeenQ] = useState(q);
  if (q !== seenQ) {
    setSeenQ(q);
    if (draft.trim() !== q) setDraft(q);
  }

  const heading = q ? t("search.resultsFor", { q }) : t("search.title");
  useTitle(heading);

  function update(changes, opts) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        // "Relevance" only exists while there is a query.
        if (!next.get("q") && next.get("sort") === "relevance") next.delete("sort");
        return next;
      },
      { preventScrollReset: true, ...opts },
    );
  }

  // The last query whose results were actually on screen. A typed query gets its own
  // history entry once the user has seen its results; intermediate drafts whose results
  // never arrived (still typing) are replaced instead, so Back skips half-typed words
  // but never a query the user looked at.
  const shownQ = useRef(null);
  useEffect(() => {
    if (!results.loading) shownQ.current = q;
  }, [results.loading, q]);

  function commitQuery(value, typing) {
    const next = value.trim().slice(0, MAX_Q);
    if (next === q) return;
    const replace = typing && location.state?.typing === true && shownQ.current !== q;
    update({ q: next }, typing ? { replace, state: { typing: true } } : undefined);
  }

  const onTypingPause = useEffectEvent((value) => commitQuery(value, true));
  useEffect(() => {
    const id = setTimeout(() => onTypingPause(draft), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft]);

  const genreOptions = genre && !genres.some((g) => g.toLowerCase() === genre.toLowerCase()) ? [genre, ...genres] : genres;
  const filtered = Boolean(q || section || genre || searchParams.get("sort"));
  const clearLink = (
    <Link to="/search" className="btn" style={{ justifySelf: "start" }}>
      {t("section.clear")}
    </Link>
  );

  return (
    <div className="container" style={{ paddingBlock: "var(--space-6)" }}>
      <h1 className={styles.title}>{heading}</h1>

      <form
        role="search"
        aria-label={t("search.formLabel")}
        className={styles.filters}
        onSubmit={(e) => {
          e.preventDefault();
          commitQuery(draft, false);
        }}
      >
        <div className={`field ${styles.query}`}>
          <label htmlFor="search-q">{t("search.queryLabel")}</label>
          <input
            id="search-q"
            className="input"
            type="search"
            name="q"
            value={draft}
            maxLength={MAX_Q}
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t("section.searchPlaceholder")}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <SectionFilter value={section} onChange={(v) => update({ section: v })} />
        <div className="field">
          <label htmlFor="search-genre">{t("search.genreLabel")}</label>
          <select id="search-genre" className="select" value={genreOptions.find((g) => g.toLowerCase() === genre.toLowerCase()) ?? ""} onChange={(e) => update({ genre: e.target.value })}>
            <option value="">{t("search.allGenres")}</option>
            {genreOptions.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="search-sort">{t("search.sortLabel")}</label>
          <select id="search-sort" className="select" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            {SEARCH_SORTS.filter((s) => s !== "relevance" || q).map((s) => (
              <option key={s} value={s}>
                {t(`search.sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </form>

      <SearchResults results={results} emptyAction={filtered ? clearLink : null} />
    </div>
  );
}
