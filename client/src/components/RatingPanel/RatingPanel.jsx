import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ratingsApi } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { useT } from "../../i18n/useT.js";
import { applyMyRating, REACTIONS } from "../../lib/rating.js";
import { Skeleton } from "../Skeleton/Skeleton.jsx";
import styles from "./RatingPanel.module.css";

const SCORES = [1, 2, 3, 4, 5];
/** Arrow keys move through the stars: wait for the user to settle before saving. */
const KEYBOARD_SAVE_DELAY = 600;

export function RatingPanel({ videoId }) {
  const { user, status: authStatus } = useAuth();
  const { t, formatNumber, errorMessage } = useT();
  const location = useLocation();
  const groupId = useId();

  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [live, setLive] = useState({ kind: "idle", text: "" });
  const [hover, setHover] = useState(0);
  const confirmed = useRef(null); // last summary the server agreed with
  const seq = useRef(0);
  const inputMode = useRef("pointer"); // how the current star change was made
  const pending = useRef(null); // keyboard choice waiting to be saved
  const timer = useRef(null);

  const userId = user?.id ?? null;
  useEffect(() => {
    if (authStatus === "loading") return undefined;
    const ctrl = new AbortController();
    ratingsApi
      .get(videoId, { signal: ctrl.signal })
      .then((s) => {
        confirmed.current = s;
        setSummary(s);
        setLoadError(null);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setLoadError(err);
      });
    return () => ctrl.abort();
  }, [videoId, userId, authStatus, reloadKey]);

  // Save a pending keyboard choice if the panel goes away before the delay.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current) ratingsApi.put(videoId, pending.current.score, pending.current.reaction ?? null).catch(() => {});
    },
    [videoId],
  );

  /** Update the UI now; save now (pointer) or after KEYBOARD_SAVE_DELAY (keyboard). */
  function choose(mine, { debounce = false } = {}) {
    clearTimeout(timer.current);
    if (!debounce) {
      pending.current = null;
      send(mine);
      return;
    }
    setSummary((s) => applyMyRating(s, mine));
    pending.current = mine;
    timer.current = setTimeout(flush, KEYBOARD_SAVE_DELAY);
  }

  function flush() {
    clearTimeout(timer.current);
    const mine = pending.current;
    if (!mine) return;
    pending.current = null;
    send(mine, { applied: true });
  }

  async function send(mine, { applied = false } = {}) {
    const id = ++seq.current;
    if (!applied) setSummary((s) => applyMyRating(s, mine));
    setLive({ kind: "pending", text: t("rating.saving") });
    try {
      const next = mine ? await ratingsApi.put(videoId, mine.score, mine.reaction ?? null) : await ratingsApi.remove(videoId);
      confirmed.current = next;
      if (id !== seq.current) return;
      setSummary(next);
      setLive({ kind: "ok", text: mine ? t("rating.saved") : t("rating.removed") });
    } catch (err) {
      if (id !== seq.current) return;
      setSummary(confirmed.current);
      setLive({ kind: "error", text: t("rating.failed", { message: errorMessage(err) }) });
    }
  }

  const mine = summary?.mine ?? null;
  const shown = hover || mine?.score || 0;
  const total = summary?.count ?? 0;

  return (
    <section className={styles.panel} aria-labelledby={`${groupId}-title`}>
      <div className={styles.head}>
        <h2 id={`${groupId}-title`} className={styles.heading}>
          {t("rating.heading")}
        </h2>
        {summary && (
          <p className={styles.average}>
            <span className={styles.big}>{summary.average != null ? formatNumber(summary.average) : "–"}</span>
            <span className={styles.outOf}>/ 5</span>
            <span className="muted">{total ? t("common.ratingCount", { count: total }) : t("common.noRatings")}</span>
          </p>
        )}
      </div>

      {!summary && !loadError && (
        <div className={styles.loading} role="status" aria-label={t("common.loading")}>
          <Skeleton style={{ blockSize: "2.5rem", inlineSize: "12rem" }} />
          <Skeleton style={{ blockSize: "5rem" }} />
        </div>
      )}
      {loadError && !summary && (
        <div className="alert alert-error" role="alert">
          {errorMessage(loadError)}{" "}
          <button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {summary && (
        <div className={styles.grid}>
          <div className={styles.mine}>
            {user ? (
              <>
                <fieldset
                  className={styles.stars}
                  onMouseLeave={() => setHover(0)}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) flush();
                  }}
                >
                  <legend className={styles.legend}>{t("rating.yours")}</legend>
                  <div className={styles.starRow}>
                    {SCORES.map((n) => (
                      <label
                        key={n}
                        className={styles.star}
                        data-filled={n <= shown ? "true" : "false"}
                        onMouseEnter={() => setHover(n)}
                        onPointerDown={() => {
                          inputMode.current = "pointer";
                        }}
                      >
                        <input
                          type="radio"
                          className="visually-hidden"
                          name={`${groupId}-score`}
                          value={n}
                          checked={mine?.score === n}
                          onKeyDown={(e) => {
                            inputMode.current = "keyboard";
                            if (e.key === "Enter") {
                              e.preventDefault();
                              flush();
                            }
                          }}
                          onChange={() => choose({ score: n, reaction: mine?.reaction ?? null }, { debounce: inputMode.current === "keyboard" })}
                        />
                        <svg viewBox="0 0 24 24" aria-hidden="true" width="32" height="32">
                          <path d="M12 2.6l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17.2l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z" />
                        </svg>
                        <span className="visually-hidden">{t("rating.stars", { count: n })}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className={styles.reactions}>
                  <p className={styles.legend} id={`${groupId}-reactions`}>
                    {t("rating.reactions")}
                  </p>
                  <div className={styles.chipRow} role="group" aria-labelledby={`${groupId}-reactions`} aria-describedby={!mine ? `${groupId}-rhint` : undefined}>
                    {REACTIONS.map(({ key, emoji }) => {
                      const active = mine?.reaction === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={styles.reaction}
                          aria-pressed={active}
                          disabled={!mine}
                          onClick={() => {
                            flush();
                            choose({ score: mine.score, reaction: active ? null : key });
                          }}
                        >
                          <span aria-hidden="true" className={styles.emoji}>{emoji}</span>
                          <span className="visually-hidden">{t(`rating.reaction.${key}`)}</span>
                          <span className={styles.count}>{formatNumber(summary.reactions?.[key] ?? 0)}</span>
                        </button>
                      );
                    })}
                  </div>
                  {!mine && (
                    <p id={`${groupId}-rhint`} className="hint">
                      {t("rating.reactionsHint")}
                    </p>
                  )}
                </div>

                {mine && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      clearTimeout(timer.current);
                      pending.current = null;
                      send(null);
                    }}
                  >
                    {t("rating.remove")}
                  </button>
                )}
              </>
            ) : (
              <div className={styles.loggedOut}>
                <Link className="btn btn-primary" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
                  {t("rating.loginToRate")}
                </Link>
                <p className="hint">{t("rating.loginHint")}</p>
                <ul className={styles.chipRow} role="list" aria-label={t("rating.reactions")}>
                  {REACTIONS.map(({ key, emoji }) => (
                    <li key={key} className={styles.reactionStatic}>
                      <span aria-hidden="true">{emoji}</span>
                      <span className="visually-hidden">{t(`rating.reaction.${key}`)}:</span> {formatNumber(summary.reactions?.[key] ?? 0)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className={styles.dist}>
            <p className={styles.legend}>{t("rating.distribution")}</p>
            <ul role="list" className={styles.bars}>
              {[5, 4, 3, 2, 1].map((n) => {
                const c = summary.distribution?.[n] ?? 0;
                const pct = total ? Math.round((c / total) * 100) : 0;
                return (
                  <li key={n} className={styles.bar}>
                    <span className={styles.barLabel} aria-hidden="true">{n}★</span>
                    <span className={styles.track} aria-hidden="true">
                      <span className={styles.fill} style={{ inlineSize: `${pct}%` }} />
                    </span>
                    <span className={styles.barCount}>
                      <span className="visually-hidden">{t("rating.stars", { count: n })}: </span>
                      {formatNumber(c)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <p className={styles.live} data-kind={live.kind} role="status" aria-live="polite">
        {live.text}
      </p>
    </section>
  );
}
