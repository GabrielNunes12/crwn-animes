import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT.js";
import { columnPath, labelIndices, niceTicks, summarize, tooltipLeft } from "../../lib/metrics.js";
import { useMetricFormats } from "./useMetricFormats.js";
import styles from "./Metrics.module.css";

// Geometry (px). The SVG is drawn at the measured width so text never scales.
const PLOT_H = 168;
const TOP = 24; // room for the peak's direct label
const AXIS = 28; // x-axis label band (part of the figure's height: no nested scroll)
const RIGHT = 6;
const HEIGHT = TOP + PLOT_H + AXIS;
const MAX_BAR = 24;
const GAP = 2; // surface gap between adjacent columns

/** Width of `ref`'s box, following resizes (jsdom has no ResizeObserver: the fallback stays). */
function useWidth(ref, fallback) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Daily ratings as columns (one series, one hue: --chart-mark). Accessible as a whole:
 * the SVG is role="img" with a one-sentence summary, and a table with every day
 * (visually hidden until "Ver tabela") carries the same data. The hover/keyboard
 * tooltip only repeats what the table says.
 */
export function RatingsChart({ series, days }) {
  const { t, formatNumber } = useT();
  const fmt = useMetricFormats();
  const base = useId();
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const tipRef = useRef(null);
  const width = useWidth(wrapRef, 640);
  const [active, setActive] = useState(null);
  const [showTable, setShowTable] = useState(false);

  const n = series.length;
  const { total, empty, peak } = summarize(series);
  const ticks = niceTicks(peak?.count ?? 0);
  const top = ticks.at(-1);
  const left = Math.max(24, String(formatNumber(top)).length * 7.5 + 12);
  const plotW = Math.max(40, width - left - RIGHT);
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const y = (v) => TOP + PLOT_H - (v / top) * PLOT_H;
  const xLabels = labelIndices(n, plotW / 84);
  const current = active != null && active < n ? active : null;

  const summary =
    total > 0
      ? `${t("admin.metrics.chart.lead", { days })}: ${[
          t("admin.metrics.chart.total", { count: total }),
          t("admin.metrics.chart.peak", { count: peak.count, day: fmt.longDay(peak.day) }),
          empty > 0 && t("admin.metrics.chart.emptyDays", { count: empty }),
        ]
          .filter(Boolean)
          .join("; ")}.`
      : `${t("admin.metrics.chart.lead", { days })}: ${t("admin.metrics.chart.none")}.`;

  function indexAt(e) {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - left) / slot);
    return Number.isFinite(i) ? Math.min(n - 1, Math.max(0, i)) : n - 1;
  }
  function onKeyDown(e) {
    const from = current ?? n - 1;
    const next = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: n - 1 }[e.key];
    if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    setActive(Math.min(n - 1, Math.max(0, next)));
  }

  // The tooltip sits beside the active column (never over it): right of it in the
  // first half of the chart, left of it in the second; measured, then clamped inside.
  const tip = current != null ? series[current] : null;
  const tipAlign = current != null && current >= n / 2 ? "before" : "after";
  const colStart = current == null ? 0 : left + current * slot;
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const x = tooltipLeft({ colStart, colEnd: colStart + slot, align: tipAlign, tipWidth: el.offsetWidth, width });
    el.style.translate = `${Math.round(x)}px 0`;
  }, [tip, colStart, slot, tipAlign, width]);

  // A tap elsewhere closes it (touch has no pointerleave to rely on; blur covers keyboard).
  const open = current != null;
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!svgRef.current?.contains(e.target)) setActive(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const peakX = peak ? left + (series.indexOf(peak) + 0.5) * slot : 0;
  const anchorAt = (x) => (x - left < 18 ? "start" : left + plotW - x < 18 ? "end" : "middle");

  return (
    <section className={`card ${styles.panel}`} aria-labelledby={`${base}-title`}>
      <div className={styles.panelHead}>
        <h3 id={`${base}-title`}>{t("admin.metrics.chart.title")}</h3>
        <button type="button" className="chip" aria-pressed={showTable} aria-controls={`${base}-table`} onClick={() => setShowTable((v) => !v)}>
          {t("admin.metrics.chart.showTable")}
        </button>
      </div>

      <div ref={wrapRef} className={styles.plot}>
        <svg
          ref={svgRef}
          className={styles.svg}
          role="img"
          aria-label={summary}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          tabIndex={0}
          onPointerMove={(e) => setActive(indexAt(e))}
          onPointerDown={(e) => setActive(indexAt(e))}
          onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          onFocus={() => setActive((a) => a ?? n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className={v === 0 ? styles.baseline : styles.grid} x1={left} x2={left + plotW} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
              <text className={styles.tick} x={left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                {formatNumber(v)}
              </text>
            </g>
          ))}
          {series.map((d, i) => {
            const x = left + i * slot;
            const h = d.count > 0 ? Math.max(2, (d.count / top) * PLOT_H) : 0;
            return (
              <g key={d.day} data-day={d.day} data-count={d.count}>
                {/* The column band: hover/focus highlight (the hit target is the whole slot). */}
                <rect className={styles.band} data-active={i === current || undefined} x={x} y={TOP} width={slot} height={PLOT_H} />
                {h > 0 && <path className={styles.bar} data-active={i === current || undefined} d={columnPath(x + (slot - barW) / 2, TOP + PLOT_H - h, barW, h)} />}
              </g>
            );
          })}
          {peak && (
            <text className={styles.peak} x={peakX} y={y(peak.count) - 7} textAnchor={anchorAt(peakX)}>
              {formatNumber(peak.count)}
            </text>
          )}
          {xLabels.map((i) => {
            const cx = left + (i + 0.5) * slot;
            return (
              <text key={i} className={styles.tick} x={cx} y={TOP + PLOT_H + 18} textAnchor={n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"} dx={i === 0 && n > 1 ? -slot / 2 + 1 : i === n - 1 && n > 1 ? slot / 2 - 1 : 0}>
                {fmt.shortDay(series[i].day)}
              </text>
            );
          })}
        </svg>
        {total === 0 && <p className={styles.emptyNote}>{t("admin.metrics.chart.empty")}</p>}
        {tip && (
          <div ref={tipRef} className={styles.tooltip} data-align={tipAlign} aria-hidden="true">
            <strong>{tip.count > 0 ? t("common.ratingCount", { count: tip.count }) : t("admin.metrics.chart.zero")}</strong>
            <span>{fmt.longDay(tip.day)}</span>
            {tip.average != null ? (
              <span>{t("admin.metrics.chart.avg", { avg: fmt.average(tip.average) })}</span>
            ) : (
              tip.count > 0 && <span>{t("admin.metrics.chart.avgFew")}</span>
            )}
          </div>
        )}
      </div>
      <p className="hint">{t("admin.metrics.chart.keys")}</p>

      <div
        id={`${base}-table`}
        className={showTable ? styles.tableScroll : "visually-hidden"}
        // A scrollable region must be reachable by keyboard, but only while it is visible.
        {...(showTable ? { tabIndex: 0, role: "region", "aria-labelledby": `${base}-caption` } : {})}
      >
        <table className={styles.table}>
          <caption id={`${base}-caption`}>{t("admin.metrics.chart.caption", { days })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("admin.metrics.chart.day")}</th>
              <th scope="col">{t("admin.metrics.chart.count")}</th>
              <th scope="col">{t("admin.metrics.chart.average")}</th>
            </tr>
          </thead>
          <tbody>
            {series.map((d) => (
              <tr key={d.day}>
                <th scope="row">
                  <time dateTime={d.day}>{fmt.longDay(d.day)}</time>
                </th>
                <td>{formatNumber(d.count)}</td>
                <td>
                  {d.average != null ? (
                    fmt.average(d.average)
                  ) : d.count > 0 ? (
                    // The server leaves out the average of a day with fewer than 3 ratings.
                    t("admin.metrics.chart.fewShort")
                  ) : (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="visually-hidden">{t("admin.metrics.chart.noAverage")}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
