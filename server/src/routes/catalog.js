import { Router } from "express";
import { SECTIONS, normalize } from "../classifier.js";
import { notFound, validationError } from "../errors.js";
import { publicVideo } from "../repository.js";
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

// Public, read-only catalog. Responses never include admin-only fields.
export function catalogRoutes({ repo }) {
  const router = Router();
  const list = (videos) => videos.map(publicVideo);
  const get = (path, handler) => router.get(path, publicCache, handler);

  get("/sections", (req, res) => {
    res.json(repo.sectionSummary());
  });

  get("/genres", (req, res) => {
    const genres = new Map();
    for (const series of repo.listSeries()) {
      for (const genre of series.genres) {
        if (!genres.has(genre.toLowerCase())) genres.set(genre.toLowerCase(), genre);
      }
    }
    res.json([...genres.values()].sort((a, b) => a.localeCompare(b)));
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
    let items = repo.listSeriesInSection(section, queryString(req.query.genre));
    const q = queryString(req.query.q);
    if (q) {
      const needle = normalize(q).trim();
      items = items.filter((s) => [s.name, ...s.aliases].some((name) => normalize(name).includes(needle)));
    }
    res.json(items);
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
