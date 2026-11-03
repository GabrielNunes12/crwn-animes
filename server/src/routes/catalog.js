import { Router } from "express";
import { SECTIONS } from "../classifier.js";
import { notFound, validationError } from "../errors.js";
import { SEARCH_SORTS, publicVideo } from "../repository.js";
import { searchNeedle } from "../search.js";
import { publicCache } from "../middleware/security.js";
import { idParam, limitParam } from "../validation.js";

const TRENDING_DAYS = 7;

/** Optional ?section= filter: null when absent, 400 when unknown. */
function sectionFilter(value) {
  if (value == null || value === "") return null;
  if (!SECTIONS.includes(value)) throw validationError({ section: `Must be one of: ${SECTIONS.join(", ")}.` });
  return value;
}

const queryString = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

const SEARCH_Q_MAX = 80;
const SEARCH_GENRE_MAX = 100;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_OFFSET_MAX = 100_000;

/** GET /api/search query → repo.search() arguments; one 400 listing every bad field. */
function readSearchQuery(query) {
  const errors = {};
  const text = (field, max) => {
    const value = query[field];
    if (value == null) return null;
    if (typeof value !== "string") return void (errors[field] = "Send this parameter once, as text.");
    const trimmed = value.trim();
    if ([...trimmed].length > max) return void (errors[field] = `Use at most ${max} characters.`);
    return trimmed === "" ? null : trimmed;
  };
  const int = (field, { min, max, fallback }) => {
    const value = query[field];
    if (value == null || value === "") return fallback;
    if (typeof value !== "string" || !/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max) {
      return void (errors[field] = `Must be a whole number from ${min} to ${max}.`);
    }
    return Number(value);
  };

  const q = text("q", SEARCH_Q_MAX);
  const genre = text("genre", SEARCH_GENRE_MAX);
  const section = text("section", 10);
  if (section != null && !SECTIONS.includes(section)) errors.section = `Must be one of: ${SECTIONS.join(", ")}.`;
  const sort = text("sort", 20);
  if (sort != null && !SEARCH_SORTS.includes(sort)) errors.sort = `Must be one of: ${SEARCH_SORTS.join(", ")}.`;
  const limit = int("limit", { min: 1, max: SEARCH_LIMIT_MAX, fallback: 20 });
  const offset = int("offset", { min: 0, max: SEARCH_OFFSET_MAX, fallback: 0 });
  if (Object.keys(errors).length) throw validationError(errors);

  const needle = searchNeedle(q);
  return { needle, section, genre, sort: sort ?? (needle ? "relevance" : "az"), limit, offset };
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
    res.json(repo.search(readSearchQuery(req.query)));
  });

  get("/latest", (req, res) => {
    res.json(list(repo.listLatest(limitParam(req.query.limit))));
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
      series: repo.getSeriesById(video.seriesId),
      prev: publicVideo(siblings[index - 1] ?? null),
      next: publicVideo(siblings[index + 1] ?? null),
    });
  });

  get("/:section/series", (req, res) => {
    const { section } = req.params;
    if (!SECTIONS.includes(section)) throw notFound("Unknown section.");
    res.json(repo.listSeriesInSection(section, queryString(req.query.genre), searchNeedle(queryString(req.query.q))));
  });

  get("/:section/series/:slug", (req, res) => {
    const { section, slug } = req.params;
    if (!SECTIONS.includes(section)) throw notFound("Unknown section.");
    const series = repo.getSeries(slug);
    if (!series) throw notFound("Series not found.");
    res.json({ series, videos: list(repo.listPublishedInSeries(series.id, section)) });
  });

  return router;
}
