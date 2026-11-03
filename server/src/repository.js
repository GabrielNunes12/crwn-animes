import { seriesRoute, videoRoute } from "./routing.js";

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

function toSeries(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    aliases: parseJson(row.aliases, []),
    genres: parseJson(row.genres, []),
    coverUrl: row.cover_url,
  };
}

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
    classification: parseJson(row.classification, {}),
    overrides: parseJson(row.overrides, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  video.route = video.status === "published" ? videoRoute(video) : null;
  return video;
}

const VIDEO_SELECT = `
  SELECT v.*, s.slug AS series_slug, s.name AS series_name
  FROM videos v LEFT JOIN series s ON s.id = v.series_id`;

export function createRepository(db) {
  const q = {
    allSeries: db.prepare("SELECT * FROM series ORDER BY name"),
    seriesBySlug: db.prepare("SELECT * FROM series WHERE slug = ?"),
    insertSeries: db.prepare(
      "INSERT INTO series (slug, name, aliases, genres, cover_url) VALUES (@slug, @name, @aliases, @genres, @coverUrl)"
    ),
    seriesInSection: db.prepare(`
      SELECT s.*, COUNT(v.id) AS video_count
      FROM series s JOIN videos v ON v.series_id = s.id
      WHERE v.status = 'published' AND v.section = @section
        AND (@genre IS NULL OR EXISTS (
          SELECT 1 FROM json_each(s.genres) g WHERE lower(g.value) = lower(@genre)))
      GROUP BY s.id ORDER BY s.name`),
    sectionSummary: db.prepare(`
      SELECT section, COUNT(DISTINCT series_id) AS series_count, COUNT(*) AS video_count
      FROM videos WHERE status = 'published' GROUP BY section`),
    publishedInSeries: db.prepare(`${VIDEO_SELECT}
      WHERE v.status = 'published' AND v.series_id = ? AND v.section = ?
      ORDER BY v.season, v.number`),
    videoById: db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`),
    videoByYoutubeId: db.prepare(`${VIDEO_SELECT} WHERE v.youtube_video_id = ?`),
    videosByStatus: db.prepare(`${VIDEO_SELECT} WHERE (@status IS NULL OR v.status = @status) ORDER BY v.created_at DESC, v.id DESC`),
    slotOwner: db.prepare(`
      SELECT id FROM videos
      WHERE status = 'published' AND series_id = @seriesId AND section = @section
        AND season = @season AND number = @number AND id IS NOT @excludeId`),
    insertVideo: db.prepare(`
      INSERT INTO videos (youtube_video_id, source_title, channel, section, series_id, season, number, status, classification, overrides)
      VALUES (@youtubeVideoId, @title, @channel, @section, @seriesId, @season, @number, @status, @classification, @overrides)`),
    updateVideo: db.prepare(`
      UPDATE videos SET section = @section, series_id = @seriesId, season = @season, number = @number,
        status = @status, classification = @classification, overrides = @overrides, updated_at = datetime('now')
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

  return {
    listSeries: () => q.allSeries.all().map(toSeries),
    getSeries: (slug) => {
      const row = q.seriesBySlug.get(slug);
      return row ? toSeries(row) : null;
    },
    createSeries: ({ slug, name, aliases, genres, coverUrl }) => {
      q.insertSeries.run({
        slug,
        name,
        aliases: JSON.stringify(aliases),
        genres: JSON.stringify(genres),
        coverUrl: coverUrl ?? null,
      });
      return toSeries(q.seriesBySlug.get(slug));
    },
    listSeriesInSection: (section, genre = null) =>
      q.seriesInSection.all({ section, genre }).map((row) => ({
        ...toSeries(row),
        videoCount: row.video_count,
        route: seriesRoute(section, row.slug),
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
    getVideo: (id) => {
      const row = q.videoById.get(id);
      return row ? toVideo(row) : null;
    },
    getVideoByYoutubeId: (youtubeVideoId) => {
      const row = q.videoByYoutubeId.get(youtubeVideoId);
      return row ? toVideo(row) : null;
    },
    listVideos: (status = null) => q.videosByStatus.all({ status }).map(toVideo),
    slotTaken: ({ seriesId, section, season, number }, excludeId = null) =>
      Boolean(q.slotOwner.get({ seriesId, section, season, number, excludeId })),
    insertVideo: ({ youtubeVideoId, title, channel, ...rest }) => {
      const { lastInsertRowid } = q.insertVideo.run({
        youtubeVideoId,
        title,
        channel: channel ?? null,
        ...placement(rest),
      });
      return toVideo(q.videoById.get(lastInsertRowid));
    },
    updateVideo: (id, fields) => {
      q.updateVideo.run({ id, ...placement(fields) });
      return toVideo(q.videoById.get(id));
    },
    deleteVideo: (id) => q.deleteVideo.run(id).changes > 0,
  };
}
