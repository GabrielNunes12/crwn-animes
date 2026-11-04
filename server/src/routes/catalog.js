import { Router } from "express";
import { SECTIONS } from "../classifier.js";
import { notFound, validationError } from "../errors.js";
import { SEARCH_SORTS, publicSeries, publicVideo } from "../repository.js";
import { searchNeedle } from "../search.js";
import { publicCache } from "../middleware/security.js";
import { idParam, limitParam, queryReader } from "../validation.js";

const TRENDING_DAYS = 7;

/** Optional ?section= filter: null when absent, 400 when unknown. */
function sectionFilter(value) {
  if (value == null || value === "") return null;
  if (!SECTIONS.includes(value)) throw validationError({ section: `Must be one of: ${SECTIONS.join(", ")}.` });
  return value;
}

export const SEARCH_Q_MAX = 80;
const SEARCH_GENRE_MAX = 100;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_OFFSET_MAX = 100_000;
const LATEST_OFFSET_MAX = 10_000;
const SEASON_MAX = 99;

/** GET /api/search query → repo.search() arguments; one 400 listing every bad field. */
function readSearchQuery(query) {
  const r = queryReader(query);
  const q = r.text("q", SEARCH_Q_MAX);
  const genre = r.text("genre", SEARCH_GENRE_MAX);
  const section = r.oneOf("section", SECTIONS);
  const sort = r.oneOf("sort", SEARCH_SORTS);
  const limit = r.int("limit", { min: 1, max: SEARCH_LIMIT_MAX, fallback: 20 });
  const offset = r.int("offset", { min: 0, max: SEARCH_OFFSET_MAX, fallback: 0 });
  r.done();

  const needle = searchNeedle(q);
  return { needle, section, genre, sort: sort ?? (needle != null ? "relevance" : "az"), limit, offset };
}

/**
 * Text and genre filters both match nothing when the q has no searchable
 * character ("鬼" is searchable, "😀" or "%" is not) or the genre is unknown.
 * Otherwise the genre is swapped for its stored spelling ("AÇÃO" -> "Ação").
 */
function resolveFilters(repo, { needle, genre }) {
  if (needle === "") return null;
  if (genre == null) return { needle, genre: null };
  const canonical = repo.canonicalGenre(genre);
  return canonical ? { needle, genre: canonical } : null;
}

// Public, read-only catalog. Responses never include admin-only fields.
export function catalogRoutes({ repo }) {
  const router = Router();
  const list = (videos) => videos.map(publicVideo);
  const get = (path, handler) => router.get(path, publicCache, handler);

  get("/sections", (req, res) => {
    res.json(repo.sectionSummary());
  });

  get("/genres", (req, res) => {
    res.json(repo.listGenres());
  });

  // Accent/case-insensitive search over series name + aliases, one item per
  // (series, section) that has a published video. Empty q browses everything.
  get("/search", (req, res) => {
    const query = readSearchQuery(req.query);
    const filters = resolveFilters(repo, query);
    if (!filters) return res.json({ items: [], total: 0 });
    const { items, total } = repo.search({ ...query, ...filters });
    res.json({ items: items.map(publicSeries), total });
  });

  // limit above 50 is clamped (as before v1.3); offset and section are validated.
  get("/latest", (req, res) => {
    const r = queryReader(req.query);
    const limit = r.int("limit", { min: 1, max: 50, fallback: 12, clamp: true });
    const offset = r.int("offset", { min: 0, max: LATEST_OFFSET_MAX, fallback: 0 });
    const section = r.oneOf("section", SECTIONS);
    r.done();
    res.json(list(repo.listLatest({ limit, offset, section })));
  });

  get("/top-rated", (req, res) => {
    const section = sectionFilter(req.query.section);
    res.json(list(repo.listTopRated({ limit: limitParam(req.query.limit), section })));
  });

  get("/trending", (req, res) => {
    const section = sectionFilter(req.query.section);
    const since = new Date(Date.now() - (TRENDING_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    res.json(list(repo.listTrending({ limit: limitParam(req.query.limit), section, since })));
  });

  get("/random", (req, res) => {
    const video = repo.randomVideo(sectionFilter(req.query.section));
    if (!video) throw notFound("There are no videos to pick from yet.");
    // A cached "random" answer would repeat the same video, so this one is not cacheable.
    res.set("Cache-Control", "no-store");
    res.json({ video: publicVideo(video) });
  });

  get("/videos/:id", (req, res) => {
    const id = idParam(req.params.id);
    const video = id && repo.getVideo(id);
    if (!video || video.status !== "published") throw notFound("Video not found.");
    const siblings = repo.listPublishedInSeries(video.seriesId, video.section);
    const index = siblings.findIndex((v) => v.id === video.id);
    res.json({
      video: publicVideo(video),
      series: publicSeries(repo.getSeriesById(video.seriesId)),
      prev: publicVideo(siblings[index - 1] ?? null),
      next: publicVideo(siblings[index + 1] ?? null),
    });
  });

  get("/:section/series", (req, res) => {
    const { section } = req.params;
    if (!SECTIONS.includes(section)) throw notFound("Unknown section.");
    const r = queryReader(req.query);
    const q = r.text("q", SEARCH_Q_MAX);
    const genre = r.text("genre", SEARCH_GENRE_MAX);
    r.done();
    const filters = resolveFilters(repo, { needle: searchNeedle(q), genre });
    res.json(filters ? repo.listSeriesInSection(section, filters.genre, filters.needle).map(publicSeries) : []);
  });

  get("/:section/series/:slug", (req, res) => {
    const { section, slug } = req.params;
    if (!SECTIONS.includes(section)) throw notFound("Unknown section.");
    const r = queryReader(req.query);
    const season = r.int("season", { min: 1, max: SEASON_MAX, fallback: null });
    r.done();
    const series = repo.getSeries(slug);
    if (!series) throw notFound("Series not found.");
    // seasons: every season with a published video here (manga chapters are all season 1).
    // An unknown season is not an error: it just has no videos.
    res.json({
      series: publicSeries(series),
      videos: list(repo.listPublishedInSeries(series.id, section, season)),
      seasons: repo.publishedSeasons(series.id, section),
    });
  });

  return router;
}
