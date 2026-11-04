import { ratingAverage, toIso } from "./repository.js";

// GET /api/admin/metrics (docs/API.md v1.6): anonymous aggregates only.
//
// Every number comes from the catalog (series, videos) or from tables that
// hold no user id: series_stats, rating_totals, rating_days (rating_activity
// per day) and the in-memory image cache. Nothing here reads users, sessions,
// email_tokens or the ratings rows themselves (test/metrics.test.js records
// every statement this runs and checks that). All reads are index-backed or
// read precomputed rows, so the cost does not grow with the number of ratings.

export const METRICS_DAYS = { min: 7, max: 90, fallback: 30 };
const TOP_SERIES = 10;
const TOP_SERIES_MIN_RATINGS = 3; // as /api/search?sort=top and /api/top-rated
const TOP_REASONS = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Why a live video waits in the pending queue, worked out from its current
 * columns (one video can have several): the stored classifier reasons also list
 * what it did find ("found episode number 5"), carry names and numbers (they
 * would not group) and can be stale (a taken slot freed since). `key` is a
 * stable code the client translates; `reason` is the English text. In order:
 *   no-section      section unknown (the classifier could not tell anime from manga)
 *   no-series       no series (none named in the title, or an admin-picked slug that
 *                   matches no live series)
 *   series-trashed  no series, and the series an admin picked is in the trash
 *   no-number       no episode/chapter number in the title
 *   guessed-number  no number, but the classifier found a bare one (suggestedNumber)
 *   slot-taken      section, series and number known, a live published video holds the slot
 *   ready           section, series and number known, the slot is free: ready to publish
 * Every pending video has at least one of them (the classifier publishes a video
 * with section, series and number unless its slot is taken), so none is "other".
 */
export const PENDING_REASONS = [
  { key: "no-section", reason: "could not tell whether this is anime or manga" },
  { key: "no-series", reason: "no series" },
  { key: "series-trashed", reason: "its series is in the trash" },
  { key: "no-number", reason: "no episode or chapter number" },
  { key: "guessed-number", reason: "only a guessed episode/chapter number (a bare number in the title)" },
  { key: "slot-taken", reason: "its episode/chapter slot already has a published video" },
  { key: "ready", reason: "complete and its slot is free: ready to publish" },
];

const round1 = (value) => Math.round(value * 10) / 10;

/** "YYYY-MM-DD" (UTC) of a time in ms. */
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createMetricsService({ db, repo, images = null, now = () => new Date() }) {
  const q = {
    liveSeries: db.prepare("SELECT COUNT(*) FROM series WHERE deleted_at IS NULL").pluck(),
    // series_stats only has rows for live published videos of live series (db.js migrations 8, 13).
    sections: db.prepare("SELECT section, COUNT(*) AS series, SUM(video_count) AS videos FROM series_stats GROUP BY section"),
    // Partial indexes series_trashed / videos_trashed / videos_unavailable.
    trashed: db.prepare(`
      SELECT (SELECT COUNT(*) FROM series WHERE deleted_at IS NOT NULL) AS series,
        (SELECT COUNT(*) FROM videos WHERE deleted_at IS NOT NULL) AS videos`),
    unavailable: db.prepare("SELECT COUNT(*) FROM videos WHERE availability = 'unavailable' AND deleted_at IS NULL").pluck(),
    // Live pending videos (videos_status_created) and, per PENDING_REASONS key, how many have
    // it. JSON is only read for videos missing a series or a number (invalid JSON = no hint),
    // the slot lookup (videos_published_slot) only for videos that have all three.
    // MATERIALIZED: each row's states are worked out once (flattened, every SUM would repeat them).
    pending: db.prepare(`
      WITH pending AS MATERIALIZED (
        SELECT v.created_at, v.section,
          CASE WHEN v.series_id IS NOT NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM series s WHERE s.deleted_at IS NOT NULL
              AND s.slug = json_extract(CASE WHEN json_valid(v.overrides) THEN v.overrides END, '$.seriesSlug')) THEN 1
            ELSE 0 END AS series_state,
          CASE WHEN v.number IS NOT NULL THEN NULL
            WHEN json_type(CASE WHEN json_valid(v.classification) THEN v.classification END, '$.suggestedNumber')
              IN ('integer', 'real') THEN 1
            ELSE 0 END AS number_state,
          CASE WHEN v.section IS NULL OR v.series_id IS NULL OR v.number IS NULL THEN NULL
            ELSE EXISTS (SELECT 1 FROM videos p
              WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.series_id = v.series_id
                AND p.section = v.section AND p.season = v.season AND p.number = v.number) END AS slot_state
        FROM videos v WHERE v.status = 'pending' AND v.deleted_at IS NULL
      )
      SELECT COUNT(*) AS count, MIN(created_at) AS oldest,
        COALESCE(SUM(section IS NULL), 0) AS "no-section",
        COALESCE(SUM(series_state = 0), 0) AS "no-series",
        COALESCE(SUM(series_state = 1), 0) AS "series-trashed",
        COALESCE(SUM(number_state = 0), 0) AS "no-number",
        COALESCE(SUM(number_state = 1), 0) AS "guessed-number",
        COALESCE(SUM(slot_state = 1), 0) AS "slot-taken",
        COALESCE(SUM(slot_state = 0), 0) AS "ready"
      FROM pending`),
    // The middle one or two pending videos by age, straight off videos_status_created.
    pendingMiddle: db.prepare(`
      SELECT created_at FROM videos WHERE status = 'pending' AND deleted_at IS NULL
      ORDER BY created_at, id LIMIT ? OFFSET ?`).pluck(),
    totals: db.prepare("SELECT n, total FROM rating_totals WHERE id = 1"),
    days: db.prepare("SELECT day, count, score_sum FROM rating_days WHERE day BETWEEN ? AND ?"),
  };

  function catalog() {
    const sections = { anime: { series: 0, videos: 0 }, manga: { series: 0, videos: 0 } };
    for (const row of q.sections.all()) {
      if (sections[row.section]) sections[row.section] = { series: row.series, videos: row.videos ?? 0 };
    }
    const trashed = q.trashed.get();
    return {
      series: q.liveSeries.get(),
      ...sections,
      unavailable: q.unavailable.get(),
      trashed: { series: trashed.series, videos: trashed.videos },
    };
  }

  function pendingQueue(at) {
    const row = q.pending.get();
    const ageHours = (createdAt) => (at - Date.parse(toIso(createdAt))) / HOUR_MS;
    let medianAgeHours = null;
    if (row.count > 0) {
      const middle = q.pendingMiddle.all(row.count % 2 ? 1 : 2, Math.floor((row.count - 1) / 2));
      const ages = middle.map(ageHours).filter(Number.isFinite);
      if (ages.length) medianAgeHours = round1(Math.max(0, ages.reduce((a, b) => a + b, 0) / ages.length));
    }
    // Most frequent first; ties keep the PENDING_REASONS order.
    const byReason = PENDING_REASONS.map(({ key, reason }) => ({ key, reason, count: row[key] }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_REASONS);
    return { count: row.count, oldestAt: row.oldest ? toIso(row.oldest) : null, medianAgeHours, byReason };
  }

  /** Site-wide totals (ratings of live videos) and the last `days` UTC days, oldest first, 0 when quiet. */
  function ratings(at, days) {
    const totals = q.totals.get() ?? { n: 0, total: 0 };
    const today = utcDay(at);
    const first = utcDay(at - (days - 1) * DAY_MS);
    const byDay = new Map(q.days.all(first, today).map((r) => [r.day, r]));
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = utcDay(at - i * DAY_MS);
      const row = byDay.get(day);
      const count = row && row.count > 0 ? row.count : 0;
      daily.push({ day, count, average: ratingAverage(count ? row.score_sum / count : null, count).average });
    }
    return {
      total: totals.n,
      average: ratingAverage(totals.n ? totals.total / totals.n : null, totals.n).average,
      daily,
    };
  }

  /** The /api/search?sort=top ranking (Bayesian average, C = 5, m = site mean), rows with n >= 3. */
  function topSeries() {
    return repo
      .search({ sort: "top", limit: TOP_SERIES, offset: 0, minCount: TOP_SERIES_MIN_RATINGS })
      .items.filter((s) => s.rating.count >= TOP_SERIES_MIN_RATINGS)
      .map((s) => ({ id: s.id, name: s.name, slug: s.slug, section: s.section, ratingCount: s.rating.count, average: s.rating.average }));
  }

  /** The same-origin image cache (THUMB_CACHE_DIR: thumbnails and the series covers that share it). */
  function thumbnails() {
    const stats = images?.stats();
    if (!stats) return { cachedFiles: 0, cachedBytes: 0, failuresRemembered: 0 };
    return {
      cachedFiles: stats.files,
      cachedBytes: stats.bytes,
      failuresRemembered: (stats.thumbnails?.failures ?? 0) + (stats.covers?.failures ?? 0),
    };
  }

  // One read transaction: every number comes from the same snapshot.
  const snapshot = db.transaction((at, days) => ({
    catalog: catalog(),
    pending: pendingQueue(at),
    ratings: ratings(at, days),
    topSeries: topSeries(),
  }));

  return {
    /** GET /api/admin/metrics body; `days` is already validated (METRICS_DAYS). */
    get({ days = METRICS_DAYS.fallback } = {}) {
      const date = now();
      const at = date.getTime();
      const data = snapshot(at, days);
      return {
        generatedAt: date.toISOString(),
        catalog: {
          series: data.catalog.series,
          anime: data.catalog.anime,
          manga: data.catalog.manga,
          pending: data.pending.count,
          unavailable: data.catalog.unavailable,
          trashed: data.catalog.trashed,
        },
        pendingQueue: data.pending,
        ratings: data.ratings,
        topSeries: data.topSeries,
        thumbnails: thumbnails(),
      };
    },
  };
}
