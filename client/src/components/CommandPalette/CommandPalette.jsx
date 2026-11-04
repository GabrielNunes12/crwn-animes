import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LazyImage } from "../LazyImage/LazyImage.jsx";
import { useDebouncedValue } from "../../hooks/useDebouncedValue.js";
import { useSearchResults } from "../../hooks/useSearchResults.js";
import { useT } from "../../i18n/useT.js";
import { sectionLabel } from "../../lib/format.js";
import { DEBOUNCE_MS, MAX_Q, searchHref } from "../../lib/search.js";
import styles from "./CommandPalette.module.css";

const PALETTE_LIMIT = 8;

/**
 * ⌘K / Ctrl+K quick search: a modal <dialog> holding an ARIA 1.2 combobox
 * (editable input + listbox, list autocomplete with automatic selection).
 * Results come from /api/search?limit=8; the last option opens /search.
 * Focus goes back to whatever was focused before it opened.
 */
export function CommandPalette({ open, onClose }) {
  const { t } = useT();
  const navigate = useNavigate();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const returnFocus = useRef(null);
  const ids = useId();
  const listId = `${ids}-list`;
  const optionId = (i) => `${ids}-opt-${i}`;

  const [query, setQuery] = useState("");
  const q = query.trim().slice(0, MAX_Q);
  const debounced = useDebouncedValue(q, DEBOUNCE_MS);
  const results = useSearchResults({ q: debounced }, { pageSize: PALETTE_LIMIT, enabled: open && Boolean(debounced) });

  // Results only count while they belong to a non-empty query.
  const items = q && results.loaded ? results.items : [];
  const options = q ? [...items.map((item) => ({ kind: "series", item })), { kind: "all" }] : [];

  // Automatic selection: whenever the option list changes, the first option is active.
  const listKey = `${q ? "q" : ""}|${results.key}|${results.loading}|${items.length}`;
  const [active, setActive] = useState(0);
  const [seenListKey, setSeenListKey] = useState(listKey);
  if (listKey !== seenListKey) {
    setSeenListKey(listKey);
    setActive(0);
  }
  const activeIndex = options.length ? Math.min(active, options.length - 1) : -1;

  // Open / close the native dialog; restore focus on close.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      inputRef.current?.focus();
    } else if (!open) {
      if (d.open) {
        if (typeof d.close === "function") d.close();
        else d.removeAttribute("open");
      }
      const el = returnFocus.current;
      returnFocus.current = null;
      if (el && el !== document.body && el.isConnected && typeof el.focus === "function") el.focus();
    }
  }, [open]);

  // Keep the active option visible.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
  });

  function close() {
    setQuery("");
    onClose();
  }

  function choose(option) {
    if (!option) return;
    const to = option.kind === "all" ? searchHref(q) : option.item.route ?? `/${option.item.section}/${option.item.slug}`;
    close();
    navigate(to);
  }

  function onKeyDown(e) {
    const n = options.length;
    switch (e.key) {
      case "ArrowDown":
        if (!n) return;
        e.preventDefault();
        setActive((activeIndex + 1) % n);
        break;
      case "ArrowUp":
        if (!n) return;
        e.preventDefault();
        setActive((activeIndex - 1 + n) % n);
        break;
      case "Home":
        if (!n) return;
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        if (!n) return;
        e.preventDefault();
        setActive(n - 1);
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0) choose(options[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      default:
    }
  }

  const searching = Boolean(q) && (q !== debounced || results.loading);
  let status = t("palette.hint");
  if (q) {
    if (searching && !items.length) status = t("common.loading");
    else if (results.error) status = t("palette.error");
    else if (!searching) status = items.length ? t("palette.count", { count: results.total }) : t("palette.none", { q });
    else status = "";
  }

  return (
    <dialog
      ref={dialogRef}
      className={`dialog ${styles.palette}`}
      aria-labelledby={`${ids}-title`}
      // The browser fires `close` in a task AFTER dialog.close(). If the palette was reopened in
      // between (Esc, then Ctrl+K at once), that late event belongs to the previous close: the
      // dialog is open again, so it is ignored. A close the browser makes itself still lands here.
      onClose={() => {
        if (dialogRef.current?.open) return;
        if (open) close();
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (e.target === dialogRef.current) close();
      }}
    >
      <h2 id={`${ids}-title`} className="visually-hidden">
        {t("palette.title")}
      </h2>
      <div className={styles.field}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className={styles.icon}>
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <label htmlFor={`${ids}-input`} className="visually-hidden">
          {t("palette.inputLabel")}
        </label>
        <input
          ref={inputRef}
          id={`${ids}-input`}
          className={styles.input}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-describedby={`${ids}-status`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={MAX_Q}
          placeholder={t("nav.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className={styles.esc} aria-hidden="true">
          Esc
        </kbd>
      </div>

      <ul id={listId} role="listbox" aria-label={t("palette.results")} className={styles.list} data-stale={searching || undefined}>
        {options.map((option, i) => (
          <li
            key={option.kind === "all" ? "all" : `${option.item.section}:${option.item.id}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === activeIndex}
            className={styles.option}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== activeIndex && setActive(i)}
            onClick={() => choose(option)}
          >
            {option.kind === "all" ? (
              <>
                <span className={styles.allIcon} aria-hidden="true">
                  ↵
                </span>
                <span className={styles.name}>{t("palette.seeAll", { q })}</span>
              </>
            ) : (
              <>
                <span className={styles.thumb}>
                  <LazyImage src={option.item.coverUrl} alt="" ratio="2 / 3" width={40} height={60} fallbackLabel={option.item.name} />
                </span>
                <span className={styles.text}>
                  <span className={styles.name}>{option.item.name}</span>
                  <span className={styles.sub}>
                    {sectionLabel(t, option.item.section)} ·{" "}
                    {t(option.item.section === "manga" ? "common.chapters" : "common.episodes", { count: option.item.videoCount ?? 0 })}
                  </span>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>

      <p id={`${ids}-status`} role="status" className={styles.status}>
        {status}
      </p>
      <p className={styles.help} aria-hidden="true">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> {t("palette.helpMove")}
        </span>
        <span>
          <kbd>↵</kbd> {t("palette.helpOpen")}
        </span>
        <span>
          <kbd>Esc</kbd> {t("palette.helpClose")}
        </span>
      </p>
    </dialog>
  );
}
