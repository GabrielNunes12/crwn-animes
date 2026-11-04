import { Router } from "express";
import { SECTIONS, parseYouTubeId } from "../classifier.js";
import { HttpError, notFound, validationError } from "../errors.js";
import { requireAdmin } from "../middleware/session.js";
import { slugify } from "../routing.js";
import { searchNeedle } from "../search.js";
import { bodyOf, idParam, queryReader, validator } from "../validation.js";

const BULK_MAX = 50;
const VIDEO_STATUSES = ["published", "pending"];
const AVAILABILITY = ["ok", "unavailable"];
const LIST_Q_MAX = 80;
const LIST_LIMIT_MAX = 100;
const LIST_OFFSET_MAX = 10_000_000;
// Videos in one reorder (one season). The 20 kB JSON body limit fits ~2,800 six-digit ids.
const ORDER_MAX = 2500;

/** ?q=&limit=&offset= of the admin lists (plus whatever `extra` reads), one 400 for every bad field. */
function readListQuery(query, extra = () => ({})) {
  const r = queryReader(query);
  const q = r.text("q", LIST_Q_MAX);
  const limit = r.int("limit", { min: 1, max: LIST_LIMIT_MAX, fallback: 50 });
  const offset = r.int("offset", { min: 0, max: LIST_OFFSET_MAX, fallback: 0 });
  const more = extra(r);
  r.done();
  return { needle: searchNeedle(q), limit, offset, ...more };
}

/** Reads the series fields of a POST (all) or PATCH (any subset). */
function readSeries(body, { partial }) {
  const v = validator(body);
  const out = {};
  if (!partial || v.has("name")) out.name = v.string("name", { required: true, max: 100 });
  if (v.has("slug") && body.slug != null) out.slug = v.slug("slug");
  if (v.has("synopsis")) out.synopsis = v.string("synopsis", { max: 2000, nullable: true });
  if (v.has("aliases")) out.aliases = v.stringList("aliases");
  if (v.has("genres")) out.genres = v.stringList("genres", { maxItems: 20, maxLength: 40 });
  if (v.has("coverUrl")) out.coverUrl = v.httpUrl("coverUrl", { nullable: true });
  if (!partial && out.name && !out.slug && !slugify(out.name)) {
    v.fail("slug", "Could not build a slug from the name; send one.");
  }
  v.done();
  return out;
}

/** Reads { section, seriesSlug, season, number } (PATCH allows null to clear). */
function readOverrides(v, { nullable, fields = ["section", "seriesSlug", "season", "number"] }) {
  const out = {};
  if (fields.includes("section") && v.has("section")) out.section = v.oneOf("section", SECTIONS, { nullable });
  if (fields.includes("seriesSlug") && v.has("seriesSlug")) out.seriesSlug = v.slug("seriesSlug", { nullable });
  if (fields.includes("season") && v.has("season")) out.season = v.int("season", { min: 1, max: 99, nullable });
  if (fields.includes("number") && v.has("number")) out.number = v.int("number", { min: 0, max: 99999, nullable });
  return out;
}

// Longest pasted token looked at (a YouTube link with tracking parameters is ~150 chars).
const BULK_TOKEN_MAX = 300;
const LEADING_WRAP = new Set(["<", "(", '"', "'", "["]);
const TRAILING_WRAP = new Set([">", ")", '"', "'", "]", "."]);

/** "<https://youtu.be/x>," -> "https://youtu.be/x". Loops, not a regex: linear on any input. */
function stripWrapping(token) {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_WRAP.has(token[start])) start++;
  while (end > start && TRAILING_WRAP.has(token[end - 1])) end--;
  return token.slice(start, end);
}

/** Every YouTube ID in the pasted text / url list, de-duplicated, as [{ input, youtubeVideoId }]. */
export function collectBulkInputs(text, urls) {
  const inputs = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    // A bare 11-char ID counts only when it is alone on its line (a title word could look like one).
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
      inputs.push(trimmed);
      continue;
    }
    for (const token of trimmed.split(/[\s,;|]+/)) {
      const clean = stripWrapping(token.slice(0, BULK_TOKEN_MAX));
      if (/youtu\.?be|youtube(-nocookie)?\.com/i.test(clean)) inputs.push(clean);
    }
  }
  for (const url of urls ?? []) inputs.push(url.trim());

  const seen = new Set();
  const rows = [];
  for (const input of inputs) {
    const youtubeVideoId = parseYouTubeId(input);
    const key = youtubeVideoId ?? `invalid:${input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ input, youtubeVideoId });
  }
  return rows;
}

/** PUT /series/:id/order body: { section, season, videoIds } (manga: season 1). */
function readOrder(body) {
  const v = validator(body);
  const section = v.oneOf("section", SECTIONS);
  const season = v.int("season", { min: 1, max: 99 });
  if (section === "manga" && season !== undefined && season !== 1) v.fail("season", "Manga chapters have no seasons: use 1.");
  const { videoIds } = body;
  if (!Array.isArray(videoIds)) v.fail("videoIds", "Must be a list of video ids.");
  else if (videoIds.length > ORDER_MAX) v.fail("videoIds", `At most ${ORDER_MAX} videos.`);
  else if (!videoIds.every((id) => Number.isSafeInteger(id) && id > 0)) v.fail("videoIds", "Every item must be a video id.");
  v.done();
  return { section, season, videoIds };
}

export function adminRoutes({ repo, videos, trash }) {
  const router = Router();
  router.use(requireAdmin);

  // Normal admin routes only see live series/videos: a trashed one is a 404 there.
  const seriesOr404 = (req) => {
    const id = idParam(req.params.id);
    const series = id && repo.getSeriesById(id);
    if (!series) throw notFound("Series not found.");
    return series;
  };
  const videoId = (req) => {
    const id = idParam(req.params.id);
    if (!id) throw notFound("Video not found.");
    return id;
  };
  const trashId = (req) => {
    const id = idParam(req.params.id);
    if (!id) throw notFound("Not in the trash.");
    return id;
  };
  // A trashed series keeps its slug until it is purged or deleted forever.
  const checkSlugFree = (slug) => {
    const holder = repo.seriesHoldingSlug(slug);
    if (!holder) return;
    if (holder.deletedAt) {
      throw new HttpError(409, `The series "${holder.name}" in the trash still uses the slug "${slug}".`, {
        slug: "A series in the trash still uses this slug: restore it, delete it forever, or pick another.",
      });
    }
    throw new HttpError(409, `A series with slug "${slug}" already exists.`, { slug: "This slug is already used." });
  };

  // ---- series ----
  // { items, total }; q matches name + aliases like /api/search.
  router.get("/series", (req, res) => {
    res.json(repo.adminSeriesPage(readListQuery(req.query)));
  });

  router.post("/series", (req, res) => {
    const fields = readSeries(bodyOf(req), { partial: false });
    const slug = fields.slug ?? slugify(fields.name);
    checkSlugFree(slug);
    const series = repo.createSeries({ aliases: [], genres: [], ...fields, slug });
    res.status(201).json({ series, published: videos.reclassifyPending({ before: null, after: series }) });
  });

  router.patch("/series/:id", (req, res) => {
    const current = seriesOr404(req);
    const fields = readSeries(bodyOf(req), { partial: true });
    if (fields.slug && fields.slug !== current.slug) checkSlugFree(fields.slug);
    const series = repo.updateSeries(current.id, { ...current, ...fields });
    res.json({ series, published: videos.reclassifyPending({ before: current, after: series }) });
  });

  // Board data (v1.4): per section, the live published videos (available or
  // not) by season, number — per season exactly the set PUT .../order expects.
  router.get("/series/:id", (req, res) => {
    const series = seriesOr404(req);
    const sections = {};
    for (const section of SECTIONS) {
      sections[section] = {
        seasons: repo.publishedSeasons(series.id, section),
        videos: repo.listPublishedInSeries(series.id, section),
      };
    }
    res.json({ series: { ...series, videoCounts: repo.seriesVideoCounts(series.id) }, sections });
  });

  // Moves the series and its videos to the trash (v1.4).
  router.delete("/series/:id", (req, res) => {
    trash.trashSeries(seriesOr404(req).id);
    res.status(204).end();
  });

  // Renumbers one season's published videos 1..n in the given order.
  router.put("/series/:id/order", (req, res) => {
    const series = seriesOr404(req);
    const order = readOrder(bodyOf(req));
    res.json({ videos: videos.reorder(series.id, order) });
  });

  // ---- videos ----
  // { items, total }; q matches the video title or the series name (accent/case-insensitive).
  router.get("/videos", (req, res) => {
    const query = readListQuery(req.query, (r) => ({
      status: r.oneOf("status", VIDEO_STATUSES),
      availability: r.oneOf("availability", AVAILABILITY),
    }));
    res.json(repo.adminVideosPage(query));
  });

  router.post("/videos", async (req, res) => {
    const v = validator(bodyOf(req));
    const url = v.string("url", { required: true, max: 500 });
    const title = v.string("title", { max: 300 });
    const overrides = readOverrides(v, { nullable: false });
    v.done();
    res.status(201).json({ video: await videos.add({ url, title, overrides }) });
  });

  router.post("/videos/bulk", async (req, res) => {
    const body = bodyOf(req);
    const v = validator(body);
    if (v.has("text") && typeof body.text !== "string") v.fail("text", "Must be a string.");
    if (v.has("urls") && (!Array.isArray(body.urls) || body.urls.some((u) => typeof u !== "string"))) {
      v.fail("urls", "Must be a list of strings.");
    }
    if (v.has("dryRun") && typeof body.dryRun !== "boolean") v.fail("dryRun", "Must be true or false.");
    let overrides = {};
    if (body.defaults != null) {
      if (typeof body.defaults !== "object" || Array.isArray(body.defaults)) v.fail("defaults", "Must be an object.");
      else {
        const dv = validator(body.defaults);
        overrides = readOverrides(dv, { nullable: false, fields: ["section", "seriesSlug", "season"] });
        if (overrides.seriesSlug && !repo.getSeries(overrides.seriesSlug)) {
          dv.fail("seriesSlug", `There is no series with slug "${overrides.seriesSlug}".`);
        }
        for (const [field, message] of Object.entries(dv.errors)) v.fail(`defaults.${field}`, message);
      }
    }
    v.done();

    const inputs = collectBulkInputs(body.text, body.urls);
    if (inputs.length === 0) throw validationError({ text: "No YouTube links or IDs found." });
    if (inputs.length > BULK_MAX) {
      throw validationError({ text: `At most ${BULK_MAX} videos per request (found ${inputs.length}).` });
    }
    res.json({ results: await videos.bulk(inputs, { overrides, dryRun: body.dryRun === true }) });
  });

  router.post("/videos/health-check", async (req, res) => {
    res.json(await videos.healthCheck());
  });

  router.patch("/videos/:id", async (req, res) => {
    const id = videoId(req);
    const v = validator(bodyOf(req));
    const url = v.has("url") ? v.string("url", { required: true, max: 500 }) : undefined;
    const changes = readOverrides(v, { nullable: true });
    v.done();
    res.json({ video: await videos.patch(id, { url, changes }) });
  });

  // Any video that is not purged: pending and trashed ones too (draft preview).
  router.get("/videos/:id/preview", (req, res) => {
    const video = repo.getAnyVideo(videoId(req));
    if (!video) throw notFound("Video not found.");
    res.json({ video, series: video.seriesId != null ? repo.getAnySeriesById(video.seriesId) : null });
  });

  // Moves the video to the trash (v1.4).
  router.delete("/videos/:id", (req, res) => {
    trash.trashVideo(videoId(req));
    res.status(204).end();
  });

  // ---- trash ----
  router.get("/trash", (req, res) => {
    res.json(trash.list());
  });

  router.post("/trash/series/:id/restore", (req, res) => {
    res.json(trash.restoreSeries(trashId(req)));
  });

  router.post("/trash/videos/:id/restore", (req, res) => {
    res.json({ video: trash.restoreVideo(trashId(req)) });
  });

  router.delete("/trash/series/:id", (req, res) => {
    trash.deleteSeriesForever(trashId(req));
    res.status(204).end();
  });

  router.delete("/trash/videos/:id", (req, res) => {
    trash.deleteVideoForever(trashId(req));
    res.status(204).end();
  });

  return router;
}
