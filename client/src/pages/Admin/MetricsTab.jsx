import { useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { adminApi } from "../../api/client.js";
import { Skeleton } from "../../components/Skeleton/Skeleton.jsx";
import { useT } from "../../i18n/useT.js";
import { fillDays, METRIC_PERIODS, readPeriod } from "../../lib/metrics.js";
import { RatingsChart } from "./RatingsChart.jsx";
import { ErrorText } from "./shared.jsx";
import { useMetricFormats } from "./useMetricFormats.js";
import styles from "./Metrics.module.css";

/** 7 / 30 / 90 days as native radios (arrow keys move between them). */
function PeriodFilter({ value, onChange }) {
  const { t } = useT();
  const name = useId();
  return (
    <fieldset className={styles.segmented}>
      <legend className={styles.legend}>{t("admin.metrics.period")}</legend>
      <div className={styles.segments}>
        {METRIC_PERIODS.map((d) => (
          <label key={d} className={styles.segment}>
            <input type="radio" name={name} value={d} checked={value === d} onChange={() => onChange(d)} />
            <span>{t("admin.metrics.periodDays", { days: d })}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Tile({ label, value, detail }) {
  return (
    <div className={styles.tile}>
      <dt>{label}</dt>
      <dd className={styles.value}>{value}</dd>
      {detail && <dd className={styles.detail}>{detail}</dd>}
    </div>
  );
}

function Tiles({ data }) {
  const { t, formatNumber, formatRelative } = useT();
  const fmt = useMetricFormats();
  const c = data.catalog ?? {};
  const q = data.pendingQueue ?? {};
  const r = data.ratings ?? {};
  const th = data.thumbnails ?? {};
  const n = (v) => formatNumber(Number(v) || 0);
  return (
    <dl className={styles.tiles}>
      <Tile
        label={t("admin.metrics.tiles.series")}
        value={n(c.series)}
        detail={t("admin.metrics.tiles.seriesDetail", { anime: Number(c.anime?.series) || 0, manga: Number(c.manga?.series) || 0 })}
      />
      <Tile label={t("admin.metrics.tiles.anime")} value={n(c.anime?.videos)} detail={t("admin.metrics.tiles.inSeries", { count: Number(c.anime?.series) || 0 })} />
      <Tile label={t("admin.metrics.tiles.manga")} value={n(c.manga?.videos)} detail={t("admin.metrics.tiles.inSeries", { count: Number(c.manga?.series) || 0 })} />
      <Tile
        label={t("admin.metrics.tiles.pending")}
        value={n(c.pending)}
        detail={q.oldestAt ? t("admin.metrics.tiles.oldest", { when: formatRelative(q.oldestAt) }) : t("admin.metrics.tiles.queueEmpty")}
      />
      <Tile label={t("admin.metrics.tiles.unavailable")} value={n(c.unavailable)} detail={t("admin.metrics.tiles.unavailableDetail")} />
      <Tile label={t("admin.metrics.tiles.trash")} value={n(c.trashed?.videos)} detail={t("admin.metrics.tiles.trashDetail", { count: Number(c.trashed?.series) || 0 })} />
      <Tile
        label={t("admin.metrics.tiles.ratings")}
        value={n(r.total)}
        detail={r.average != null ? t("admin.metrics.tiles.average", { avg: fmt.average(r.average) }) : t("common.noRatings")}
      />
      <Tile
        label={t("admin.metrics.tiles.thumbs")}
        value={n(th.cachedFiles)}
        detail={t("admin.metrics.tiles.thumbsDetail", { size: fmt.bytes(th.cachedBytes), count: Number(th.failuresRemembered) || 0 })}
      />
    </dl>
  );
}

/**
 * A pending reason's label: its stable `key` (docs/API.md v1.6, e.g. "no-series") translated
 * from admin.metrics.pending.reason.*; an unknown or missing key shows the server's `reason` text.
 */
function reasonLabel(t, r) {
  const key = typeof r.key === "string" && /^[a-z0-9-]+$/.test(r.key) ? `admin.metrics.pending.reason.${r.key}` : null;
  const msg = key && t(key);
  return msg && msg !== key ? msg : r.reason || r.key;
}

function PendingQueue({ queue }) {
  const { t, formatNumber, formatRelative } = useT();
  const fmt = useMetricFormats();
  const id = useId();
  const count = Number(queue?.count) || 0;
  const reasons = (Array.isArray(queue?.byReason) ? queue.byReason : []).filter((r) => r && (r.key || r.reason));
  const most = Math.max(1, ...reasons.map((r) => Number(r.count) || 0));
  const median = fmt.age(queue?.medianAgeHours);
  return (
    <section className={`card ${styles.panel}`} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("admin.metrics.pending.title")}</h3>
      {count === 0 ? (
        <p className="muted">{t("admin.metrics.pending.empty")}</p>
      ) : (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>{t("admin.metrics.pending.count")}</dt>
              <dd>{formatNumber(count)}</dd>
            </div>
            {median && (
              <div>
                <dt>{t("admin.metrics.pending.median")}</dt>
                <dd>{median}</dd>
              </div>
            )}
            {queue?.oldestAt && (
              <div>
                <dt>{t("admin.metrics.pending.oldest")}</dt>
                <dd>
                  <time dateTime={queue.oldestAt}>{formatRelative(queue.oldestAt)}</time>
                </dd>
              </div>
            )}
          </dl>
          <h4 id={`${id}-reasons`} className={styles.subhead}>
            {t("admin.metrics.pending.reasons")}
          </h4>
          {reasons.length === 0 ? (
            <p className="muted">{t("admin.metrics.pending.noReasons")}</p>
          ) : (
            <ol className={styles.ranked} aria-labelledby={`${id}-reasons`}>
              {reasons.map((r, i) => (
                <li key={`${i}-${r.key ?? r.reason}`}>
                  <span className={styles.rankText}>{reasonLabel(t, r)}</span>
                  <span className={styles.rankValue}>{t("common.videoCount", { count: Number(r.count) || 0 })}</span>
                  <span className={styles.meter} aria-hidden="true">
                    <span style={{ inlineSize: `${((Number(r.count) || 0) / most) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function TopSeries({ items }) {
  const { t } = useT();
  const fmt = useMetricFormats();
  const id = useId();
  const list = Array.isArray(items) ? items : [];
  return (
    <section className={`card ${styles.panel}`} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("admin.metrics.top.title")}</h3>
      <p className="hint">{t("admin.metrics.top.hint")}</p>
      {list.length === 0 ? (
        <p className="muted">{t("admin.metrics.top.empty")}</p>
      ) : (
        <ol className={styles.top} aria-labelledby={`${id}-title`}>
          {list.map((s) => (
            <li key={s.id}>
              <Link className={styles.topName} to={`/admin/series/${s.id}`}>
                {s.name}
              </Link>
              {(s.section === "anime" || s.section === "manga") && <span className={`badge badge-${s.section}`}>{t(`common.${s.section}`)}</span>}
              <span className={styles.topStat}>
                {s.average != null && (
                  <>
                    <span aria-hidden="true" className={styles.star}>
                      ★
                    </span>{" "}
                    {t("admin.metrics.top.avg", { avg: fmt.average(s.average) })} ·{" "}
                  </>
                )}
                {t("common.ratingCount", { count: Number(s.ratingCount) || 0 })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MetricsSkeleton() {
  const { t } = useT();
  return (
    <div className="stack" role="status" aria-label={t("common.loading")}>
      <div className={styles.tiles}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={styles.tile}>
            <Skeleton style={{ blockSize: "0.8rem", inlineSize: "60%" }} />
            <Skeleton style={{ blockSize: "1.8rem", inlineSize: "40%" }} />
            <Skeleton style={{ blockSize: "0.8rem", inlineSize: "75%" }} />
          </div>
        ))}
      </div>
      <Skeleton style={{ blockSize: "17rem", borderRadius: "var(--radius-lg)" }} />
    </div>
  );
}

/**
 * Admin "Métricas" (docs/API.md v1.6): anonymous aggregates only. The period lives in
 * `?days=` (7/30/90). A refetch (period or refresh) keeps the last render dimmed instead
 * of flashing skeletons, and a polite live region says when new numbers arrived.
 */
export function MetricsTab() {
  const { t } = useT();
  const fmt = useMetricFormats();
  const [params, setParams] = useSearchParams();
  const days = readPeriod(params.get("days"));
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ key: null, days, data: null, error: null });
  const [live, setLive] = useState({ n: 0, at: null, days });
  const loadedOnce = useRef(false);

  const key = `${days}:${version}`;
  useEffect(() => {
    const ctrl = new AbortController();
    const k = `${days}:${version}`;
    adminApi
      .metrics({ days }, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setState({ key: k, days, data: data ?? {}, error: null });
        // The first load is announced by the page itself; later ones (refresh, period) here.
        if (loadedOnce.current) setLive((l) => ({ n: l.n + 1, at: data?.generatedAt ?? new Date().toISOString(), days }));
        loadedOnce.current = true;
      })
      .catch((error) => {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        setState((s) => ({ ...s, key: k, error }));
      });
    return () => ctrl.abort();
  }, [days, version]);

  const loading = state.key !== key;
  const error = loading ? null : state.error;
  const data = state.data;
  const generatedAt = data?.generatedAt;

  function refresh() {
    if (!loading) setVersion((v) => v + 1);
  }
  function setDays(d) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("days", String(d));
        return next;
      },
      { replace: true },
    );
  }

  return (
    <section className="stack" aria-labelledby="metrics-title">
      <div className="section-head" style={{ marginBlockEnd: 0 }}>
        <h2 id="metrics-title">{t("admin.metrics.title")}</h2>
      </div>
      <p className="hint">{t("admin.metrics.hint")}</p>

      <div className={styles.toolbar}>
        <PeriodFilter value={days} onChange={setDays} />
        <div className={styles.updated}>
          {generatedAt && (
            <p className="hint">
              <time dateTime={generatedAt}>{t("admin.metrics.updatedAt", { time: fmt.time(generatedAt) })}</time>
            </p>
          )}
          {/* aria-disabled (not disabled) keeps focus on the button while it reloads. */}
          <button type="button" className="btn btn-sm" onClick={refresh} aria-disabled={loading || undefined}>
            <span aria-hidden="true">↻</span> {loading && data ? t("admin.metrics.refreshing") : t("admin.refresh")}
          </button>
        </div>
      </div>
      <p role="status" className="visually-hidden">
        {live.n > 0 && <span key={live.n}>{t("admin.metrics.updatedLive", { time: fmt.time(live.at), days: live.days })}</span>}
      </p>

      <ErrorText error={error} />
      {error && !data && (
        <p>
          <button type="button" className="btn" onClick={refresh}>
            {t("common.retry")}
          </button>
        </p>
      )}
      {!data && !error && <MetricsSkeleton />}
      {data && (
        <div className={`stack ${styles.body}`} aria-busy={loading || undefined} data-stale={loading || undefined}>
          <Tiles data={data} />
          <RatingsChart series={fillDays(data.ratings?.daily, state.days, generatedAt)} days={state.days} />
          <div className={styles.split}>
            <PendingQueue queue={data.pendingQueue} />
            <TopSeries items={data.topSeries} />
          </div>
        </div>
      )}
    </section>
  );
}
