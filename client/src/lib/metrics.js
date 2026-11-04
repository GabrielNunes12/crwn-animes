// Pure helpers for the admin "Métricas" tab (docs/API.md v1.6): periods, the daily
// series and the chart's scale. No DOM, no React — unit-tested in metrics.test.js.

export const METRIC_PERIODS = [7, 30, 90];
export const DEFAULT_PERIOD = 30;

/** `?days=` → one of METRIC_PERIODS (anything else → the default). */
export function readPeriod(value) {
  const n = Number(value);
  return METRIC_PERIODS.includes(n) ? n : DEFAULT_PERIOD;
}

const DAY_MS = 86_400_000;
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toUtc = (day) => Date.parse(`${day}T00:00:00Z`);
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Exactly `days` consecutive UTC days, oldest first, each `{ day, count, average }`.
 * The server already sends zero-activity days (count 0); this also fills any it
 * left out, so a gap in the data is never drawn as a gap in time. The window ends
 * on the newest day the server sent (or on `generatedAt`'s UTC date).
 */
export function fillDays(daily, days, generatedAt) {
  const byDay = new Map();
  for (const d of Array.isArray(daily) ? daily : []) {
    if (isDay(d?.day)) byDay.set(d.day, d);
  }
  const sent = [...byDay.keys()].sort();
  const fallback = typeof generatedAt === "string" && !Number.isNaN(Date.parse(generatedAt)) ? new Date(generatedAt).toISOString().slice(0, 10) : fromUtc(Date.now());
  const end = toUtc(sent.at(-1) ?? fallback);
  return Array.from({ length: days }, (_, i) => {
    const day = fromUtc(end - (days - 1 - i) * DAY_MS);
    const d = byDay.get(day);
    const count = Math.max(0, Number(d?.count) || 0);
    const average = count > 0 && Number.isFinite(Number(d?.average)) && d?.average !== null ? Number(d.average) : null;
    return { day, count, average };
  });
}

/** Totals for the chart's summary: sum, number of empty days and the peak (latest on a tie). */
export function summarize(series) {
  let total = 0;
  let empty = 0;
  let peak = null;
  for (const d of series) {
    total += d.count;
    if (d.count === 0) empty += 1;
    if (d.count > 0 && (!peak || d.count >= peak.count)) peak = d;
  }
  return { total, empty, peak };
}

/**
 * Clean integer y-axis ticks from 0 to at least `max` (≈ `target` steps of 1, 2 or 5 × 10ⁿ).
 * An empty series still gets an axis (0 – 1) so the frame doesn't collapse.
 */
export function niceTicks(max, target = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

/**
 * Which of `n` days get an x-axis label when only `fit` labels fit side by side:
 * evenly spaced, always the first and the last.
 */
export function labelIndices(n, fit) {
  if (n <= 0) return [];
  const room = Math.max(2, Math.floor(fit));
  if (n <= room) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (room - 1));
  const out = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  // The last label is end-anchored (its text runs back from the right edge): it needs
  // ~¾ of a step clear before it, or the previous label is dropped.
  if (out.length > 1 && n - 1 - out.at(-1) < step * 0.75) out.pop();
  out.push(n - 1);
  return out;
}

/** A column with a 4px rounded data end and a square foot on the baseline (SVG path). */
export function columnPath(x, y, w, h) {
  const r = Math.max(0, Math.min(4, w / 2, h));
  const b = y + h;
  return `M${x},${b}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${b}Z`;
}

/**
 * The tooltip's x (px from the plot's left edge). It sits beside the active column —
 * after it (to the right) or before it (to the left) — and is then clamped to
 * [0, width − tipWidth] so it never overflows the chart, even on a 320px phone with
 * a long localized date. Wider than the chart: it starts at 0 (and wraps, in CSS).
 */
export function tooltipLeft({ colStart, colEnd, align, tipWidth, width, gap = 8 }) {
  const want = align === "before" ? colStart - gap - tipWidth : colEnd + gap;
  return Math.max(0, Math.min(want, width - tipWidth));
}
