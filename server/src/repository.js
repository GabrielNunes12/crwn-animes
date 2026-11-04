import { coverPath } from "./covers.js";
import { seriesRoute, videoRoute } from "./routing.js";
import { canonicalGenres, genreKey, genreSpellings, sortGenres } from "./genres.js";
import { TRASH_TTL_MS } from "./retention.js";
import { NEEDLE_MATCH, NEEDLE_RANK, searchNormalize, searchText } from "./search.js";
import { thumbnailPath, thumbnailSrcSet } from "./thumbnails.js";

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

/** SQLite's datetime('now') gives "2026-11-03 19:31:00" (UTC); the API speaks ISO 8601. */
export const toIso = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}.000Z`
    : value;

/** { average, count } with the average rounded to one decimal (null when unrated). */
export const ratingAverage = (average, count) => ({
  average: count > 0 && average != null ? Math.round(average * 10) / 10 : null,
  count: count ?? 0,
});

/** { deletedAt, purgeAt } of a trashed row (v1.4 trash), {} for a live one. */
const trashFields = (row) =>
  row.deleted_at
    ? { deletedAt: row.deleted_at, purgeAt: new Date(Date.parse(row.deleted_at) + TRASH_TTL_MS).toISOString() }
    : {};

// Trashed series/videos (only admins ever see them) also carry deletedAt + purgeAt.
// coverUrl is the same-origin proxy (v1.5; null for a trashed series, which /api/covers
// answers 404); coverSourceUrl, the URL the admin typed, is admin-only (publicSeries()).
function toSeries(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    synopsis: row.synopsis ?? null,
    aliases: parseJson(row.aliases, []),
    genres: parseJson(row.genres, []),
    coverUrl: row.cover_url && !row.deleted_at ? coverPath(row.id, row.cover_url) : null,
    coverSourceUrl: row.cover_url ?? null,
    ...trashFields(row),
  };
}

/** Drops the admin-only fields of a series. */
export function publicSeries(series) {
  if (!series) return series;
  const { coverSourceUrl, deletedAt, purgeAt, ...rest } = series;
  return rest;
}

const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Full video, as admins see it. Public responses go through publicVideo().
function toVideo(row) {
  const video = {
    id: row.id,
    youtubeVideoId: row.youtube_video_id,
    title: row.source_title,
    channel: row.channel,
    // Same-origin (v1.5): the server fetches and caches it, the browser never contacts Google before Play.
    // A trashed video's is null (/api/thumbs answers 404 for it), and so is its srcset.
    thumbnailUrl: row.deleted_at ? null : thumbnailPath(row.youtube_video_id),
    // v1.7: "/api/thumbs/<id>-m.jpg 320w, /api/thumbs/<id>.jpg 480w" (src/thumbnails.js).
    thumbnailSrcSet: row.deleted_at ? null : thumbnailSrcSet(row.youtube_video_id),
    section: row.section,
    seriesId: row.series_id,
    seriesSlug: row.series_slug ?? null,
    seriesName: row.series_name ?? null,
    season: row.season,
    number: row.number,
    status: row.status,
    route: null,
    rating: ratingAverage(row.rating_avg, row.rating_count),
    availability: row.availability ?? "ok",
    publishedAt: row.published_at ?? null,
    isNew: row.published_at != null && Date.now() - Date.parse(row.published_at) <= NEW_FOR_MS,
    classification: parseJson(row.classification, {}),
    overrides: parseJson(row.overrides, {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    ...trashFields(row),
  };
  // A trashed video has no page (its status says what restoring brings back).
  video.route = video.status === "published" && !row.deleted_at ? videoRoute(video) : null;
  return video;
}

/** Drops the admin-only fields. */
export function publicVideo(video) {
  if (!video) return video;
  const { classification, overrides, deletedAt, purgeAt, ...rest } = video;
  return rest;
}

// GET /api/search: one row per (series, section) with >= 1 published video,
// read from series_stats (kept current by triggers, see db.js migration 8), so
// nothing is aggregated per request. Ratings count published videos of that
// section only, like the section list; `bayes` is the /top-rated Bayesian
// average (C*m + sum) / (C + n), m = site-wide mean (@m). `total` comes from
// the same statement (window count before LIMIT/OFFSET).
const SEARCH_SELECT = `
  SELECT s.id, s.slug, s.name, s.synopsis, s.aliases, s.genres, s.cover_url,
    st.section, st.video_count, st.latest_published_at, st.rating_n AS rating_count,
    CASE WHEN st.rating_n > 0 THEN CAST(st.rating_sum AS REAL) / st.rating_n END AS rating_avg,
    CASE WHEN st.rating_n > 0 THEN (@c * @m + st.rating_sum) / (@c + st.rating_n) END AS bayes,
    ${NEEDLE_RANK} AS match_rank,
    COUNT(*) OVER () AS total
  FROM series_stats st JOIN series s ON s.id = st.series_id
  WHERE (@section IS NULL OR st.section = @section) AND s.deleted_at IS NULL AND ${NEEDLE_MATCH}
    AND (@genre IS NULL OR EXISTS (SELECT 1 FROM json_each(s.genres) g WHERE g.value = @genre))`;

// Fixed ORDER BY per sort (never built from user input). Ties end on name,
// then anime before manga, then id, so pages never overlap.
const TIEBREAK = "name COLLATE NOCASE, section, id";
const SEARCH_ORDER = {
  relevance: `match_rank, bayes IS NULL, bayes DESC, rating_count DESC, ${TIEBREAK}`,
  top: `rating_count >= @minCount DESC, bayes IS NULL, bayes DESC, rating_count DESC, ${TIEBREAK}`,
  new: `latest_published_at IS NULL, latest_published_at DESC, ${TIEBREAK}`,
  az: TIEBREAK,
};
export const SEARCH_SORTS = Object.keys(SEARCH_ORDER);

// Ratings come from video_rating_stats (kept by triggers, db.js migration 12).
const VIDEO_SELECT = `
  SELECT v.*, s.slug AS series_slug, s.name AS series_name,
    CASE WHEN vr.n > 0 THEN CAST(vr.total AS REAL) / vr.n END AS rating_avg,
    COALESCE(vr.n, 0) AS rating_count
  FROM videos v LEFT JOIN series s ON s.id = v.series_id
    LEFT JOIN video_rating_stats vr ON vr.video_id = v.id`;

// Admin video list (GET /api/admin/videos). WHERE is assembled from these
// fixed fragments (never from user input) so each filter combination gets its
// own prepared statement whose plan can use an index: "(@x IS NULL OR col = @x)"
// would defeat it. Order: newest created first, id breaking ties, which the
// videos_created / videos_status_created indexes serve without sorting. Both
// are partial (WHERE deleted_at IS NULL, db.js migration 13): trashed videos
// are never listed here, and the condition below is what lets the planner use them.
const ADMIN_VIDEO_LIVE = "v.deleted_at IS NULL";
const ADMIN_VIDEO_FILTERS = {
  status: "v.status = @status",
  availability: "v.availability = @availability",
  // Normalised title, or one of the series whose normalised name matches
  // (@seriesIds: JSON array, worked out in JS from the cached series names).
  needle: "(instr(v.title_search, @needle) > 0 OR v.series_id IN (SELECT value FROM json_each(@seriesIds)))",
};
const ADMIN_VIDEO_ORDER = "v.created_at DESC, v.id DESC";

// Admin rows carry their published counts per section (from series_stats) so the admin can see
// which series are not on the site yet: a series only appears in a section once it has a video there.
const ADMIN_SERIES_SELECT = `
  SELECT s.*, COUNT(*) OVER () AS total,
    COALESCE((SELECT video_count FROM series_stats WHERE series_id = s.id AND section = 'anime'), 0) AS anime_count,
    COALESCE((SELECT video_count FROM series_stats WHERE series_id = s.id AND section = 'manga'), 0) AS manga_count
  FROM series s WHERE s.deleted_at IS NULL AND ${NEEDLE_MATCH}`;

export function createRepository(db) {
  const q = {
    // Live series only (the classifier never routes a video into the trash).
    allSeries: db.prepare("SELECT * FROM series WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE"),
    seriesNames: db.prepare("SELECT id, name FROM series WHERE deleted_at IS NULL ORDER BY id"),
    // Same matching as /api/search (search_text = name + aliases); name order, id breaks ties.
    adminSeriesPage: db.prepare(`${ADMIN_SERIES_SELECT}
      ORDER BY s.name COLLATE NOCASE, s.id LIMIT @limit OFFSET @offset`),
    adminSeriesCount: db.prepare(`SELECT COUNT(*) AS n FROM series s WHERE s.deleted_at IS NULL AND ${NEEDLE_MATCH}`),
    seriesBySlug: db.prepare("SELECT * FROM series WHERE slug = ? AND deleted_at IS NULL"),
    seriesVideoCounts: db.prepare("SELECT section, video_count FROM series_stats WHERE series_id = ?"),
    seriesById: db.prepare("SELECT * FROM series WHERE id = ? AND deleted_at IS NULL"),
    // Including the trash: a trashed series keeps its slug reserved.
    anySeriesBySlug: db.prepare("SELECT * FROM series WHERE slug = ?"),
    anySeriesById: db.prepare("SELECT * FROM series WHERE id = ?"),
    insertSeries: db.prepare(`
      INSERT INTO series (slug, name, synopsis, aliases, genres, cover_url, search_text)
      VALUES (@slug, @name, @synopsis, @aliases, @genres, @coverUrl, @searchText)`),
    updateSeries: db.prepare(`
      UPDATE series SET slug = @slug, name = @name, synopsis = @synopsis, aliases = @aliases,
        genres = @genres, cover_url = @coverUrl, search_text = @searchText
      WHERE id = @id`),
    deleteSeries: db.prepare("DELETE FROM series WHERE id = ?"),
    // Rating of a series in one section = average of every rating given to
    // its published videos in that section (precomputed in series_stats).
    seriesInSection: db.prepare(`
      SELECT s.*, st.video_count, st.rating_n AS rating_count,
        CASE WHEN st.rating_n > 0 THEN CAST(st.rating_sum AS REAL) / st.rating_n END AS rating_avg
      FROM series_stats st JOIN series s ON s.id = st.series_id
      WHERE st.section = @section AND s.deleted_at IS NULL AND ${NEEDLE_MATCH}
        AND (@genre IS NULL OR EXISTS (SELECT 1 FROM json_each(s.genres) g WHERE g.value = @genre))
      ORDER BY s.name COLLATE NOCASE, s.id`),
    search: Object.fromEntries(
      Object.entries(SEARCH_ORDER).map(([sort, order]) => [
        sort,
        db.prepare(`${SEARCH_SELECT} ORDER BY ${order} LIMIT @limit OFFSET @offset`),
      ])
    ),
    // Only needed when OFFSET is past the end (no row carries the window count).
    searchCount: db.prepare(`SELECT COUNT(*) AS n FROM (${SEARCH_SELECT})`),
    siteRating: db.prepare("SELECT n, total FROM rating_totals WHERE id = 1"),
    catalogVersion: db.prepare("SELECT version FROM catalog_version WHERE id = 1").pluck(),
    seriesVersion: db.prepare("SELECT version FROM series_version WHERE id = 1").pluck(),
    // What reclassifying needs of each pending video (no joins, no rating lookups).
    pendingForReclassify: db.prepare(`
      SELECT id, source_title, section, series_id, season, number, status, classification, overrides
      FROM videos WHERE status = 'pending' AND deleted_at IS NULL ORDER BY id`),
    seriesGenres: db.prepare("SELECT id, genres FROM series WHERE id IS NOT @excludeId ORDER BY id"),
    // Genres worth a page: series with a published video YouTube still serves.
    listedSeriesGenres: db.prepare(`
      SELECT s.id, s.genres FROM series s
      WHERE s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM videos v
        WHERE v.series_id = s.id AND v.status = 'published' AND v.deleted_at IS NULL AND v.availability = 'ok')
      ORDER BY s.id`),
    // ---- server-rendered pages (src/seo.js) and the sitemap ----
    seriesSectionStats: db.prepare(`
      SELECT COUNT(*) AS video_count, MAX(published_at) AS latest_published_at FROM videos
      WHERE status = 'published' AND deleted_at IS NULL AND series_id = ? AND section = ?`),
    // Manga routes have no season: the lowest season wins if two share a number.
    publishedAt: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND v.series_id = @seriesId AND v.section = @section
        AND v.number = @number AND (@section = 'manga' OR v.season = @season)
      ORDER BY v.season LIMIT 1`),
    sitemapSeries: db.prepare(`
      SELECT s.slug, v.section, MAX(v.published_at) AS lastmod
      FROM videos v JOIN series s ON s.id = v.series_id
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND v.section IS NOT NULL
      GROUP BY s.id, v.section ORDER BY v.section, s.slug`),
    sitemapVideos: db.prepare(`
      SELECT s.slug AS series_slug, v.section, v.season, v.number, v.published_at, v.updated_at
      FROM videos v JOIN series s ON s.id = v.series_id
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND v.availability = 'ok'
        AND v.section IS NOT NULL AND v.number IS NOT NULL
      ORDER BY v.section, s.slug, v.season, v.number`),
    latestPublishedAt: db.prepare(`
      SELECT MAX(published_at) AS at FROM videos
      WHERE status = 'published' AND deleted_at IS NULL AND (@section IS NULL OR section = @section)`),
    sectionSummary: db.prepare(`
      SELECT section, COUNT(DISTINCT series_id) AS series_count, COUNT(*) AS video_count
      FROM videos WHERE status = 'published' AND deleted_at IS NULL GROUP BY section`),
    publishedInSeries: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND v.series_id = @seriesId AND v.section = @section
        AND (@season IS NULL OR v.season = @season)
      ORDER BY v.season, v.number`),
    // Served by the partial unique index videos_published_slot (series_id, section, season, ...).
    publishedSeasons: db.prepare(`
      SELECT DISTINCT season FROM videos
      WHERE status = 'published' AND deleted_at IS NULL AND series_id = ? AND section = ?
      ORDER BY season`).pluck(),
    latest: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND v.availability = 'ok'
        AND (@section IS NULL OR v.section = @section)
      ORDER BY v.published_at DESC, v.id DESC LIMIT @limit OFFSET @offset`),
    // Bayesian average (C*m + sum) / (C + n): C = @c, m = site-wide mean (@m, from
    // rating_totals). Per-video counts/sums come from video_rating_stats, so
    // nothing is aggregated per request; the page is picked first, then joined.
    topRated: db.prepare(`
      WITH top AS (
        SELECT st.video_id, st.n, (@c * @m + st.total) / (@c + st.n) AS score
        FROM video_rating_stats st JOIN videos tv ON tv.id = st.video_id
        WHERE st.n >= @minCount AND tv.status = 'published' AND tv.deleted_at IS NULL AND tv.availability = 'ok'
          AND (@section IS NULL OR tv.section = @section)
        ORDER BY score DESC, st.n DESC, st.video_id DESC
        LIMIT @limit
      )
      ${VIDEO_SELECT}
      JOIN top ON top.video_id = v.id
      ORDER BY top.score DESC, top.n DESC, v.id DESC`),
    trending: db.prepare(`
      WITH recent AS (
        SELECT video_id, SUM(count) AS n FROM rating_activity
        WHERE day >= @since GROUP BY video_id HAVING SUM(count) > 0
      )
      ${VIDEO_SELECT}
      JOIN recent ON recent.video_id = v.id
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND v.availability = 'ok'
        AND (@section IS NULL OR v.section = @section)
      ORDER BY recent.n DESC, v.published_at DESC, v.id DESC
      LIMIT @limit`),
    randomVideo: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND v.availability = 'ok'
        AND (@section IS NULL OR v.section = @section)
      ORDER BY RANDOM() LIMIT 1`),
    videoById: db.prepare(`${VIDEO_SELECT} WHERE v.id = ? AND v.deleted_at IS NULL`),
    anyVideoById: db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`),
    // Including the trash: youtube_video_id stays unique.
    videoByYoutubeId: db.prepare(`${VIDEO_SELECT} WHERE v.youtube_video_id = ?`),
    youtubeIdState: db.prepare("SELECT deleted_at IS NOT NULL AS trashed, availability FROM videos WHERE youtube_video_id = ?"),
    youtubeIdsOfSeries: db.prepare("SELECT youtube_video_id FROM videos WHERE series_id = ?").pluck(),
    coverSource: db.prepare("SELECT cover_url, deleted_at FROM series WHERE id = ?"),
    videosFiltered: db.prepare(`${VIDEO_SELECT}
      WHERE v.deleted_at IS NULL AND (@status IS NULL OR v.status = @status)
        AND (@availability IS NULL OR v.availability = @availability)
      ORDER BY v.created_at DESC, v.id DESC`),
    // The health check skips the trash.
    allVideoIds: db.prepare("SELECT id, youtube_video_id FROM videos WHERE deleted_at IS NULL ORDER BY id"),
    staleVideoIds: db.prepare(`
      SELECT id, youtube_video_id FROM videos
      WHERE (checked_at IS NULL OR checked_at < ?) AND deleted_at IS NULL ORDER BY id`),
    setAvailability: db.prepare(`
      UPDATE videos SET availability = @availability, checked_at = ${NOW_ISO} WHERE id = @id`),
    swapYoutubeId: db.prepare(`
      UPDATE videos SET youtube_video_id = @youtubeVideoId, availability = 'ok', checked_at = ${NOW_ISO},
        updated_at = datetime('now')
      WHERE id = @id`),
    slotOwner: db.prepare(`
      SELECT id FROM videos
      WHERE status = 'published' AND deleted_at IS NULL AND series_id = @seriesId AND section = @section
        AND season = @season AND number = @number AND id IS NOT @excludeId`),
    insertVideo: db.prepare(`
      INSERT INTO videos (youtube_video_id, source_title, title_search, channel, section, series_id, season, number, status,
        classification, overrides, published_at, checked_at)
      VALUES (@youtubeVideoId, @title, @titleSearch, @channel, @section, @seriesId, @season, @number, @status,
        @classification, @overrides, CASE WHEN @status = 'published' THEN ${NOW_ISO} END, ${NOW_ISO})`),
    updateVideo: db.prepare(`
      UPDATE videos SET section = @section, series_id = @seriesId, season = @season, number = @number,
        status = @status, classification = @classification, overrides = @overrides, updated_at = datetime('now'),
        published_at = COALESCE(published_at, CASE WHEN @status = 'published' THEN ${NOW_ISO} END)
      WHERE id = @id`),
    deleteVideo: db.prepare("DELETE FROM videos WHERE id = ?"),

    // ---- trash (v1.4). deleted_at is ISO 8601, like published_at. ----
    trashSeries: db.prepare("UPDATE series SET deleted_at = @at WHERE id = @id AND deleted_at IS NULL"),
    // Every live video of the series (any status/section) goes with it.
    trashSeriesVideos: db.prepare(`
      UPDATE videos SET deleted_at = @at, trashed_with_series = 1 WHERE series_id = @id AND deleted_at IS NULL`),
    trashVideo: db.prepare(`
      UPDATE videos SET deleted_at = @at, trashed_with_series = 0 WHERE id = @id AND deleted_at IS NULL`),
    // Served by the partial indexes series_trashed / videos_trashed (deleted_at, id).
    // video_count: every video of the series, i.e. what deleting it forever removes (FK
    // cascade), including videos trashed on their own before it (also listed under videos).
    trashedSeries: db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM videos v WHERE v.series_id = s.id) AS video_count
      FROM series s WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC, s.id DESC`),
    trashedVideos: db.prepare(`${VIDEO_SELECT}
      WHERE v.deleted_at IS NOT NULL AND v.trashed_with_series = 0 ORDER BY v.deleted_at DESC, v.id DESC`),
    trashedSeriesById: db.prepare("SELECT * FROM series WHERE id = ? AND deleted_at IS NOT NULL"),
    trashedVideoById: db.prepare(`${VIDEO_SELECT} WHERE v.id = ? AND v.deleted_at IS NOT NULL`),
    // Oldest published first: if two ever claim one slot, the older one keeps it.
    videosTrashedWithSeries: db.prepare(`${VIDEO_SELECT}
      WHERE v.series_id = ? AND v.deleted_at IS NOT NULL AND v.trashed_with_series = 1
      ORDER BY v.published_at IS NULL, v.published_at, v.id`),
    restoreVideo: db.prepare(`
      UPDATE videos SET deleted_at = NULL, trashed_with_series = 0, status = @status, classification = @classification,
        updated_at = datetime('now')
      WHERE id = @id AND deleted_at IS NOT NULL`),
    restoreSeries: db.prepare("UPDATE series SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL"),
    purgeSeries: db.prepare("DELETE FROM series WHERE id = ? AND deleted_at IS NOT NULL"),
    purgeVideo: db.prepare("DELETE FROM videos WHERE id = ? AND deleted_at IS NOT NULL"),

    // ---- reorder (PUT /api/admin/series/:id/order) ----
    setNumber: db.prepare("UPDATE videos SET number = ? WHERE id = ?"),
    renumber: db.prepare(`
      UPDATE videos SET number = @number, overrides = @overrides, updated_at = datetime('now') WHERE id = @id`),
  };

  const placement = (p) => ({
    section: p.section,
    seriesId: p.seriesId,
    season: p.season,
    number: p.number,
    status: p.status,
    classification: JSON.stringify(p.classification ?? {}),
    overrides: JSON.stringify(p.overrides ?? {}),
  });

  const genreRows = (stmt, params = {}) => stmt.all(params).map((r) => ({ genres: parseJson(r.genres, []) }));

  /** Memoises fn() until the catalog changes (catalog_version is bumped by triggers on series/videos). */
  /** Memoises fn() until a series is created, changed or deleted (series_version, db.js migration 11). */
  const untilSeriesChange = (fn) => {
    let cached = null;
    return () => {
      const version = q.seriesVersion.get();
      if (!cached || cached.version !== version) cached = { version, value: fn() };
      return cached.value;
    };
  };

  const untilCatalogChanges = (fn) => {
    let cached = null;
    return () => {
      const version = q.catalogVersion.get();
      if (!cached || cached.version !== version) cached = { version, value: fn() };
      return cached.value;
    };
  };
  // genreKey -> canonical spelling, over every series (canonicalising input).
  const allGenreSpellings = untilCatalogChanges(() => genreSpellings(genreRows(q.seriesGenres, { excludeId: null })));
  // Sorted canonical genres of series with a published, available video.
  const listedGenres = untilCatalogChanges(() => sortGenres(genreSpellings(genreRows(q.listedSeriesGenres)).values()));

  /** Column values for a series; genres take the spelling other series already use. */
  const seriesParams = (s, excludeId = null) => ({
    slug: s.slug,
    name: s.name,
    synopsis: s.synopsis ?? null,
    aliases: JSON.stringify(s.aliases ?? []),
    genres: JSON.stringify(canonicalGenres(s.genres ?? [], genreSpellings(genreRows(q.seriesGenres, { excludeId })))),
    coverUrl: s.coverSourceUrl ?? null, // the URL the admin typed (Series.coverUrl is the proxy path)
    searchText: searchText(s.name, s.aliases ?? []),
  });

  // [{ id, name }] with the name through searchNormalize(), for the admin video search.
  const normalisedSeriesNames = untilCatalogChanges(() =>
    q.seriesNames.all().map((r) => ({ id: r.id, name: searchNormalize(r.name) }))
  );

  // One prepared statement pair per combination of admin video filters.
  const adminVideoStatements = new Map();
  const adminVideoStatement = (keys) => {
    const key = keys.join(",");
    if (!adminVideoStatements.has(key)) {
      const where = `WHERE ${[ADMIN_VIDEO_LIVE, ...keys.map((k) => ADMIN_VIDEO_FILTERS[k])].join(" AND ")}`;
      adminVideoStatements.set(key, {
        page: db.prepare(`${VIDEO_SELECT} ${where} ORDER BY ${ADMIN_VIDEO_ORDER} LIMIT @limit OFFSET @offset`),
        // Unfiltered: every row minus the trash, so SQLite's btree count (no row visits) still applies.
        count: keys.length
          ? db.prepare(`SELECT COUNT(*) AS n FROM videos v ${where}`).pluck()
          : db.prepare("SELECT (SELECT COUNT(*) FROM videos) - (SELECT COUNT(*) FROM videos WHERE deleted_at IS NOT NULL)").pluck(),
      });
    }
    return adminVideoStatements.get(key);
  };

  const getVideo = (id) => {
    const row = q.videoById.get(id);
    return row ? toVideo(row) : null;
  };
  const one = (row, map) => (row ? map(row) : null);

  return {
    /** Runs `fn` in one SQLite transaction (sync functions only). */
    transaction: (fn) => db.transaction(fn)(),
    /** Live series (not in the trash), by name. */
    listSeries: () => q.allSeries.all().map(toSeries),
    /** The live series with this slug, or null (a trashed one is not there). */
    getSeries: (slug) => {
      const row = q.seriesBySlug.get(slug);
      return row ? toSeries(row) : null;
    },
    getSeriesById: (id) => {
      const row = q.seriesById.get(id);
      return row ? toSeries(row) : null;
    },
    /** { anime, manga }: live published videos per section (series_stats), as in the admin series list. */
    seriesVideoCounts: (id) => {
      const counts = { anime: 0, manga: 0 };
      for (const row of q.seriesVideoCounts.all(id)) counts[row.section] = row.video_count;
      return counts;
    },
    /** Live or trashed (then with deletedAt/purgeAt); null once purged. */
    getAnySeriesById: (id) => one(q.anySeriesById.get(id), toSeries),
    /** The series holding this slug, trashed ones included (their slug stays reserved), or null. */
    seriesHoldingSlug: (slug) => one(q.anySeriesBySlug.get(slug), toSeries),
    /** `series.coverSourceUrl` is the cover's source URL (what the admin typed as coverUrl). */
    createSeries: (series) => {
      const { lastInsertRowid } = q.insertSeries.run(seriesParams(series));
      return toSeries(q.seriesById.get(lastInsertRowid));
    },
    /** Replaces every column with `series` (callers merge the patch first). */
    updateSeries: (id, series) => {
      q.updateSeries.run({ id, ...seriesParams(series, id) });
      return toSeries(q.seriesById.get(id));
    },
    /** Hard delete. Videos (and through them ratings) go with it: ON DELETE CASCADE. */
    deleteSeries: (id) => q.deleteSeries.run(id).changes > 0,
    /** Bumped by triggers on every series/video change; keys in-memory caches. */
    catalogVersion: () => q.catalogVersion.get(),
    untilCatalogChanges,
    untilSeriesChange,
    /** Canonical genres of series with >= 1 published, available video, sorted (cached). */
    listGenres: () => listedGenres(),
    /** The stored spelling of `genre` (any case), or null when no series uses it. */
    canonicalGenre: (genre) => allGenreSpellings().get(genreKey(genre)) ?? null,
    /** `needle` comes from searchNeedle() (null = no text filter); `genre` must be canonical. */
    listSeriesInSection: (section, genre = null, needle = null) =>
      q.seriesInSection.all({ section, genre, needle }).map((row) => ({
        ...toSeries(row),
        videoCount: row.video_count,
        route: seriesRoute(section, row.slug),
        rating: ratingAverage(row.rating_avg, row.rating_count),
      })),
    /** { items: SearchItem[], total } — see GET /api/search. `genre` must be canonical. */
    search: ({ needle = null, section = null, genre = null, sort, limit, offset, c = 5, minCount = 3 }) => {
      const site = q.siteRating.get();
      const m = site && site.n > 0 ? site.total / site.n : 0;
      const params = { needle, section, genre, c, m, minCount, limit, offset };
      const rows = q.search[sort].all(params);
      const total = rows.length ? rows[0].total : offset > 0 ? q.searchCount.get(params).n : 0;
      const items = rows.map((row) => ({
        ...toSeries(row),
        videoCount: row.video_count,
        route: seriesRoute(row.section, row.slug),
        rating: ratingAverage(row.rating_avg, row.rating_count),
        section: row.section,
        latestPublishedAt: row.latest_published_at ?? null,
      }));
      return { items, total };
    },
    /** { videoCount, latestPublishedAt } of a series' published videos in one section. */
    seriesSectionStats: (seriesId, section) => {
      const row = q.seriesSectionStats.get(seriesId, section);
      return { videoCount: row.video_count, latestPublishedAt: row.latest_published_at ?? null };
    },
    /** The published video at a route slot (any availability), or null. */
    findPublishedVideo: ({ seriesId, section, season, number }) => {
      const row = q.publishedAt.get({ seriesId, section, season, number });
      return row ? toVideo(row) : null;
    },
    latestPublishedAt: (section = null) => q.latestPublishedAt.get({ section }).at ?? null,
    /** Rows for /sitemap.xml: series pages per section, and published available videos. */
    sitemapEntries: () => ({
      series: q.sitemapSeries.all().map((r) => ({ route: seriesRoute(r.section, r.slug), lastmod: r.lastmod })),
      videos: q.sitemapVideos.all().map((r) => ({
        route: videoRoute({ section: r.section, seriesSlug: r.series_slug, season: r.season, number: r.number }),
        lastmod: r.published_at ?? toIso(r.updated_at),
      })),
    }),
    sectionSummary: () => {
      const rows = Object.fromEntries(q.sectionSummary.all().map((r) => [r.section, r]));
      return ["anime", "manga"].map((section) => ({
        section,
        route: `/${section}`,
        seriesCount: rows[section]?.series_count ?? 0,
        videoCount: rows[section]?.video_count ?? 0,
      }));
    },
    /** Published videos of a series in a section (one season when `season` is given). */
    listPublishedInSeries: (seriesId, section, season = null) =>
      q.publishedInSeries.all({ seriesId, section, season }).map(toVideo),
    /** Ascending seasons that have a published video of this series in this section. */
    publishedSeasons: (seriesId, section) => q.publishedSeasons.all(seriesId, section),
    listLatest: ({ limit, offset = 0, section = null }) => q.latest.all({ limit, offset, section }).map(toVideo),
    /** GET /api/admin/series: { items: Series[], total }. `needle` from searchNeedle() (null = all; "" = none). */
    adminSeriesPage: ({ needle = null, limit, offset }) => {
      if (needle === "") return { items: [], total: 0 };
      const rows = q.adminSeriesPage.all({ needle, limit, offset });
      const total = rows.length ? rows[0].total : offset > 0 ? q.adminSeriesCount.get({ needle }).n : 0;
      const items = rows.map((row) => ({ ...toSeries(row), videoCounts: { anime: row.anime_count, manga: row.manga_count } }));
      return { items, total };
    },
    /**
     * GET /api/admin/videos: { items: Video[], total }. `needle` (from searchNeedle()) matches the
     * normalised video title or series name; null = no text filter, "" = matches nothing.
     */
    adminVideosPage: ({ status = null, availability = null, needle = null, limit, offset }) => {
      if (needle === "") return { items: [], total: 0 };
      const params = { status, availability, needle, limit, offset };
      const keys = Object.keys(ADMIN_VIDEO_FILTERS).filter((k) => params[k] != null);
      if (needle != null) {
        params.seriesIds = JSON.stringify(normalisedSeriesNames().filter((s) => s.name.includes(needle)).map((s) => s.id));
      }
      const stmt = adminVideoStatement(keys);
      return { items: stmt.page.all(params).map(toVideo), total: stmt.count.get(params) };
    },
    listTopRated: ({ limit, section = null, c = 5, minCount = 3 }) => {
      const site = q.siteRating.get();
      const m = site && site.n > 0 ? site.total / site.n : 0;
      return q.topRated.all({ limit, section, c, m, minCount }).map(toVideo);
    },
    /** [{ id, title, section, seriesId, season, number, status, classification (JSON), overrides }] of pending videos. */
    pendingForReclassify: () =>
      q.pendingForReclassify.all().map((r) => ({
        id: r.id,
        title: r.source_title,
        section: r.section,
        seriesId: r.series_id,
        season: r.season,
        number: r.number,
        status: r.status,
        classification: r.classification,
        overrides: parseJson(r.overrides, {}),
      })),
    /** `since` is the first day (YYYY-MM-DD) that counts. */
    listTrending: ({ limit, section = null, since }) => q.trending.all({ limit, section, since }).map(toVideo),
    randomVideo: (section = null) => {
      const row = q.randomVideo.get({ section });
      return row ? toVideo(row) : null;
    },
    /** A live video (published or pending), or null when unknown or in the trash. */
    getVideo,
    /** Live or trashed (then with deletedAt/purgeAt); null once purged. */
    getAnyVideo: (id) => one(q.anyVideoById.get(id), toVideo),
    /** Live or trashed: a YouTube video can only be added once, the trash included. */
    getVideoByYoutubeId: (youtubeVideoId) => {
      const row = q.videoByYoutubeId.get(youtubeVideoId);
      return row ? toVideo(row) : null;
    },
    /**
     * What GET /api/thumbs may do for this YouTube ID: "live" (fetch/serve), "unavailable"
     * (YouTube no longer serves the video: 404, never fetched), "trashed", or null (no video).
     */
    thumbnailState: (youtubeVideoId) => {
      const row = q.youtubeIdState.get(youtubeVideoId);
      if (!row) return null;
      if (row.trashed) return "trashed";
      return row.availability === "ok" ? "live" : "unavailable";
    },
    /** { sourceUrl, trashed } of a series (live or trashed), or null once purged / unknown. */
    coverSource: (seriesId) => {
      const row = q.coverSource.get(seriesId);
      return row ? { sourceUrl: row.cover_url ?? null, trashed: row.deleted_at != null } : null;
    },
    /** YouTube IDs of every video of a series, trashed ones included (what its purge deletes). */
    youtubeIdsOfSeries: (seriesId) => q.youtubeIdsOfSeries.all(seriesId),
    listVideos: (status = null, availability = null) => q.videosFiltered.all({ status, availability }).map(toVideo),
    /** [{ id, youtube_video_id }] of every video, or only those not checked since `olderThan` (ISO). */
    videoIdsToCheck: (olderThan = null) => (olderThan ? q.staleVideoIds.all(olderThan) : q.allVideoIds.all()),
    setAvailability: (id, availability) => q.setAvailability.run({ id, availability }),
    swapYoutubeId: (id, youtubeVideoId) => {
      q.swapYoutubeId.run({ id, youtubeVideoId });
      return getVideo(id);
    },
    slotTaken: ({ seriesId, section, season, number }, excludeId = null) =>
      Boolean(q.slotOwner.get({ seriesId, section, season, number, excludeId })),
    insertVideo: ({ youtubeVideoId, title, channel, ...rest }) => {
      const { lastInsertRowid } = q.insertVideo.run({
        youtubeVideoId,
        title,
        titleSearch: searchNormalize(title),
        channel: channel ?? null,
        ...placement(rest),
      });
      return getVideo(lastInsertRowid);
    },
    updateVideo: (id, fields) => {
      q.updateVideo.run({ id, ...placement(fields) });
      return getVideo(id);
    },
    /** Hard delete (ratings cascade). The admin API trashes instead (src/trashService.js). */
    deleteVideo: (id) => q.deleteVideo.run(id).changes > 0,

    // ---- trash (v1.4; the rules live in src/trashService.js) ----
    /** Trashes a live series and every live video of it (same `at`); false when not live. */
    trashSeries: (id, at) => {
      if (q.trashSeries.run({ id, at }).changes === 0) return false;
      q.trashSeriesVideos.run({ id, at });
      return true;
    },
    /** false when the video is not live. */
    trashVideo: (id, at) => q.trashVideo.run({ id, at }).changes > 0,
    /**
     * { series: TrashedSeries[], videos: TrashedVideo[] }, newest first. Videos trashed with their series
     * are only counted under it (videoCount = every video its delete-forever removes); videos trashed on
     * their own are listed, and counted under their series too when it is trashed later.
     */
    listTrash: () => ({
      series: q.trashedSeries.all().map((row) => ({ ...toSeries(row), videoCount: row.video_count })),
      videos: q.trashedVideos.all().map(toVideo),
    }),
    getTrashedSeries: (id) => one(q.trashedSeriesById.get(id), toSeries),
    getTrashedVideo: (id) => one(q.trashedVideoById.get(id), toVideo),
    /** Trashed videos that went to the trash with series `seriesId`, oldest published first. */
    videosTrashedWithSeries: (seriesId) => q.videosTrashedWithSeries.all(seriesId).map(toVideo),
    /** Brings a trashed video back with `status`/`classification` (a taken slot makes it pending). */
    restoreVideo: (id, { status, classification }) =>
      q.restoreVideo.run({ id, status, classification: JSON.stringify(classification ?? {}) }).changes > 0,
    restoreSeries: (id) => q.restoreSeries.run(id).changes > 0,
    /** Deletes a trashed series/video for good (ratings cascade); false when it is not in the trash. */
    purgeTrashedSeries: (id) => q.purgeSeries.run(id).changes > 0,
    purgeTrashedVideo: (id) => q.purgeVideo.run(id).changes > 0,

    /**
     * Gives `videos` ([{ id, number, overrides }], live published videos of one
     * series/section/season) the numbers 1..n in that order and pins each one
     * as overrides.number, so re-classifying never undoes it. Videos whose
     * number changes are first moved to -n, so the unique published-slot index
     * never sees two videos in one slot mid-way. Call inside a transaction.
     */
    renumber: (videos) => {
      const changes = videos
        .map((video, index) => ({ video, number: index + 1 }))
        .filter(({ video, number }) => video.number !== number || video.overrides?.number !== number);
      for (const { video, number } of changes) if (video.number !== number) q.setNumber.run(-number, video.id);
      for (const { video, number } of changes) {
        q.renumber.run({ id: video.id, number, overrides: JSON.stringify({ ...video.overrides, number }) });
      }
      return changes.length;
    },
  };
}
