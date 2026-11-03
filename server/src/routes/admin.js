import { Router } from "express";
import { SECTIONS, parseYouTubeId } from "../classifier.js";
import { HttpError, notFound, validationError } from "../errors.js";
import { requireAdmin } from "../middleware/session.js";
import { slugify } from "../routing.js";
import { bodyOf, idParam, validator } from "../validation.js";

const BULK_MAX = 50;
const VIDEO_STATUSES = ["published", "pending"];
const AVAILABILITY = ["ok", "unavailable"];

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
      const clean = token.replace(/^[<("'[]+|[>)"'\].]+$/g, "");
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

export function adminRoutes({ repo, videos }) {
  const router = Router();
  router.use(requireAdmin);

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
  const slugConflict = (slug) =>
    new HttpError(409, `A series with slug "${slug}" already exists.`, { slug: "This slug is already used." });

  // ---- series ----
  router.get("/series", (req, res) => {
    res.json(repo.listSeries());
  });

  router.post("/series", (req, res) => {
    const fields = readSeries(bodyOf(req), { partial: false });
    const slug = fields.slug ?? slugify(fields.name);
    if (repo.getSeries(slug)) throw slugConflict(slug);
    const series = repo.createSeries({ aliases: [], genres: [], ...fields, slug });
    res.status(201).json({ series, published: videos.reclassifyPending() });
  });

  router.patch("/series/:id", (req, res) => {
    const current = seriesOr404(req);
    const fields = readSeries(bodyOf(req), { partial: true });
    if (fields.slug && fields.slug !== current.slug && repo.getSeries(fields.slug)) throw slugConflict(fields.slug);
    const series = repo.updateSeries(current.id, { ...current, ...fields });
    res.json({ series, published: videos.reclassifyPending() });
  });

  router.delete("/series/:id", (req, res) => {
    repo.deleteSeries(seriesOr404(req).id);
    res.status(204).end();
  });

  // ---- videos ----
  router.get("/videos", (req, res) => {
    const { status, availability } = req.query;
    const errors = {};
    if (status != null && !VIDEO_STATUSES.includes(status)) errors.status = `Must be one of: ${VIDEO_STATUSES.join(", ")}.`;
    if (availability != null && !AVAILABILITY.includes(availability)) errors.availability = `Must be one of: ${AVAILABILITY.join(", ")}.`;
    if (Object.keys(errors).length) throw validationError(errors);
    res.json(repo.listVideos(status ?? null, availability ?? null));
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
    let video = repo.getVideo(id);
    if (!video) throw notFound("Video not found.");
    if (url) video = await videos.swapUrl(id, url);
    if (Object.keys(changes).length) video = videos.update(id, changes);
    res.json({ video });
  });

  router.delete("/videos/:id", (req, res) => {
    videos.remove(videoId(req));
    res.status(204).end();
  });

  return router;
}
