import { seriesRoute, videoRoute } from "./routing.js";

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

function toSeries(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    synopsis: row.synopsis ?? null,
    aliases: parseJson(row.aliases, []),
    genres: parseJson(row.genres, []),
    coverUrl: row.cover_url,
  };
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
    thumbnailUrl: `https://i.ytimg.com/vi/${row.youtube_video_id}/hqdefault.jpg`,
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
  };
  video.route = video.status === "published" ? videoRoute(video) : null;
  return video;
}

/** Drops the admin-only fields. */
export function publicVideo(video) {
  if (!video) return video;
  const { classification, overrides, ...rest } = video;
  return rest;
}

const VIDEO_SELECT = `
  SELECT v.*, s.slug AS series_slug, s.name AS series_name,
    (SELECT AVG(r.score) FROM ratings r WHERE r.video_id = v.id) AS rating_avg,
    (SELECT COUNT(*) FROM ratings r WHERE r.video_id = v.id) AS rating_count
  FROM videos v LEFT JOIN series s ON s.id = v.series_id`;

export function createRepository(db) {
  const q = {
    allSeries: db.prepare("SELECT * FROM series ORDER BY name COLLATE NOCASE"),
    seriesBySlug: db.prepare("SELECT * FROM series WHERE slug = ?"),
    seriesById: db.prepare("SELECT * FROM series WHERE id = ?"),
    insertSeries: db.prepare(`
      INSERT INTO series (slug, name, synopsis, aliases, genres, cover_url)
      VALUES (@slug, @name, @synopsis, @aliases, @genres, @coverUrl)`),
    updateSeries: db.prepare(`
      UPDATE series SET slug = @slug, name = @name, synopsis = @synopsis, aliases = @aliases,
        genres = @genres, cover_url = @coverUrl
      WHERE id = @id`),
    deleteSeries: db.prepare("DELETE FROM series WHERE id = ?"),
    // Rating of a series in one section = average of every rating given to
    // its published videos in that section.
    seriesInSection: db.prepare(`
      SELECT s.*, COUNT(v.id) AS video_count, rs.avg_score AS rating_avg, rs.n AS rating_count
      FROM series s
      JOIN videos v ON v.series_id = s.id
      LEFT JOIN (
        SELECT v2.series_id, AVG(r.score) AS avg_score, COUNT(*) AS n
        FROM ratings r JOIN videos v2 ON v2.id = r.video_id
        WHERE v2.status = 'published' AND v2.section = @section
        GROUP BY v2.series_id
      ) rs ON rs.series_id = s.id
      WHERE v.status = 'published' AND v.section = @section
        AND (@genre IS NULL OR EXISTS (
          SELECT 1 FROM json_each(s.genres) g WHERE lower(g.value) = lower(@genre)))
      GROUP BY s.id ORDER BY s.name COLLATE NOCASE`),
    sectionSummary: db.prepare(`
      SELECT section, COUNT(DISTINCT series_id) AS series_count, COUNT(*) AS video_count
      FROM videos WHERE status = 'published' GROUP BY section`),
    publishedInSeries: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.series_id = ? AND v.section = ?
      ORDER BY v.season, v.number`),
    latest: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.availability = 'ok'
        AND (@section IS NULL OR v.section = @section)
      ORDER BY v.published_at DESC, v.id DESC LIMIT @limit`),
    // Bayesian average (C*m + sum) / (C + n): C = @c, m = site-wide mean.
    topRated: db.prepare(`
      WITH stats AS (
        SELECT video_id, COUNT(*) AS n, SUM(score) AS total FROM ratings GROUP BY video_id
      ), site AS (SELECT AVG(score) AS m FROM ratings)
      ${VIDEO_SELECT}
      JOIN stats st ON st.video_id = v.id CROSS JOIN site
      WHERE v.status = 'published' AND v.availability = 'ok' AND st.n >= @minCount
        AND (@section IS NULL OR v.section = @section)
      ORDER BY (@c * site.m + st.total) / (@c + st.n) DESC, st.n DESC, v.id DESC
      LIMIT @limit`),
    trending: db.prepare(`
      WITH recent AS (
        SELECT video_id, SUM(count) AS n FROM rating_activity
        WHERE day >= @since GROUP BY video_id HAVING SUM(count) > 0
      )
      ${VIDEO_SELECT}
      JOIN recent ON recent.video_id = v.id
      WHERE v.status = 'published' AND v.availability = 'ok'
        AND (@section IS NULL OR v.section = @section)
      ORDER BY recent.n DESC, v.published_at DESC, v.id DESC
      LIMIT @limit`),
    randomVideo: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.availability = 'ok'
        AND (@section IS NULL OR v.section = @section)
      ORDER BY RANDOM() LIMIT 1`),
    videoById: db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`),
    videoByYoutubeId: db.prepare(`${VIDEO_SELECT} WHERE v.youtube_video_id = ?`),
    videosFiltered: db.prepare(`${VIDEO_SELECT}
      WHERE (@status IS NULL OR v.status = @status) AND (@availability IS NULL OR v.availability = @availability)
      ORDER BY v.created_at DESC, v.id DESC`),
    allVideoIds: db.prepare("SELECT id, youtube_video_id FROM videos ORDER BY id"),
    staleVideoIds: db.prepare(`
      SELECT id, youtube_video_id FROM videos WHERE checked_at IS NULL OR checked_at < ? ORDER BY id`),
    setAvailability: db.prepare(`
      UPDATE videos SET availability = @availability, checked_at = ${NOW_ISO} WHERE id = @id`),
    swapYoutubeId: db.prepare(`
      UPDATE videos SET youtube_video_id = @youtubeVideoId, availability = 'ok', checked_at = ${NOW_ISO},
        updated_at = datetime('now')
      WHERE id = @id`),
    slotOwner: db.prepare(`
      SELECT id FROM videos
      WHERE status = 'published' AND series_id = @seriesId AND section = @section
        AND season = @season AND number = @number AND id IS NOT @excludeId`),
    insertVideo: db.prepare(`
      INSERT INTO videos (youtube_video_id, source_title, channel, section, series_id, season, number, status,
        classification, overrides, published_at, checked_at)
      VALUES (@youtubeVideoId, @title, @channel, @section, @seriesId, @season, @number, @status,
        @classification, @overrides, CASE WHEN @status = 'published' THEN ${NOW_ISO} END, ${NOW_ISO})`),
    updateVideo: db.prepare(`
      UPDATE videos SET section = @section, series_id = @seriesId, season = @season, number = @number,
        status = @status, classification = @classification, overrides = @overrides, updated_at = datetime('now'),
        published_at = COALESCE(published_at, CASE WHEN @status = 'published' THEN ${NOW_ISO} END)
      WHERE id = @id`),
    deleteVideo: db.prepare("DELETE FROM videos WHERE id = ?"),
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

  const seriesParams = (s) => ({
    slug: s.slug,
    name: s.name,
    synopsis: s.synopsis ?? null,
    aliases: JSON.stringify(s.aliases ?? []),
    genres: JSON.stringify(s.genres ?? []),
    coverUrl: s.coverUrl ?? null,
  });

  const getVideo = (id) => {
    const row = q.videoById.get(id);
    return row ? toVideo(row) : null;
  };

  return {
    listSeries: () => q.allSeries.all().map(toSeries),
    getSeries: (slug) => {
      const row = q.seriesBySlug.get(slug);
      return row ? toSeries(row) : null;
    },
    getSeriesById: (id) => {
      const row = q.seriesById.get(id);
      return row ? toSeries(row) : null;
    },
    createSeries: (series) => {
      const { lastInsertRowid } = q.insertSeries.run(seriesParams(series));
      return toSeries(q.seriesById.get(lastInsertRowid));
    },
    /** Replaces every column with `series` (callers merge the patch first). */
    updateSeries: (id, series) => {
      q.updateSeries.run({ id, ...seriesParams(series) });
      return toSeries(q.seriesById.get(id));
    },
    /** Videos (and through them ratings) go with it: ON DELETE CASCADE. */
    deleteSeries: (id) => q.deleteSeries.run(id).changes > 0,
    listSeriesInSection: (section, genre = null) =>
      q.seriesInSection.all({ section, genre }).map((row) => ({
        ...toSeries(row),
        videoCount: row.video_count,
        route: seriesRoute(section, row.slug),
        rating: ratingAverage(row.rating_avg, row.rating_count),
      })),
    sectionSummary: () => {
      const rows = Object.fromEntries(q.sectionSummary.all().map((r) => [r.section, r]));
      return ["anime", "manga"].map((section) => ({
        section,
        route: `/${section}`,
        seriesCount: rows[section]?.series_count ?? 0,
        videoCount: rows[section]?.video_count ?? 0,
      }));
    },
    listPublishedInSeries: (seriesId, section) => q.publishedInSeries.all(seriesId, section).map(toVideo),
    listLatest: (limit, section = null) => q.latest.all({ limit, section }).map(toVideo),
    listTopRated: ({ limit, section = null, c = 5, minCount = 3 }) =>
      q.topRated.all({ limit, section, c, minCount }).map(toVideo),
    /** `since` is the first day (YYYY-MM-DD) that counts. */
    listTrending: ({ limit, section = null, since }) => q.trending.all({ limit, section, since }).map(toVideo),
    randomVideo: (section = null) => {
      const row = q.randomVideo.get({ section });
      return row ? toVideo(row) : null;
    },
    getVideo,
    getVideoByYoutubeId: (youtubeVideoId) => {
      const row = q.videoByYoutubeId.get(youtubeVideoId);
      return row ? toVideo(row) : null;
    },
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
        channel: channel ?? null,
        ...placement(rest),
      });
      return getVideo(lastInsertRowid);
    },
    updateVideo: (id, fields) => {
      q.updateVideo.run({ id, ...placement(fields) });
      return getVideo(id);
    },
    deleteVideo: (id) => q.deleteVideo.run(id).changes > 0,
  };
}
