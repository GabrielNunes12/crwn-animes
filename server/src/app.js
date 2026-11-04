import cors from "cors";
import express from "express";
import helmet from "helmet";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAuthService } from "./authService.js";
import { loadConfig, parseTrustProxy, thumbnailUpstream } from "./config.js";
import { HttpError, notFound } from "./errors.js";
import { createMailer } from "./mail.js";
import { createMetricsService } from "./metricsService.js";
import { noStore, requireJsonBody, requireSameOrigin } from "./middleware/security.js";
import { loadSession } from "./middleware/session.js";
import { createRatingService } from "./ratingService.js";
import { createRepository } from "./repository.js";
import { createSitemap, createTemplate, renderPage, resolvePage, robotsTxt } from "./seo.js";
import { createTrashService } from "./trashService.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { devRoutes } from "./routes/dev.js";
import { meRoutes } from "./routes/me.js";
import { ratingRoutes } from "./routes/ratings.js";
import { coverHash, createCoverSource, fetchCover as fetchCoverImage, parseCoverKey } from "./covers.js";
import { createImageCache } from "./imageCache.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { imageRoutes } from "./routes/images.js";
import { createThumbnailSource, fetchYoutubeThumbnail, parseThumbKey, thumbKeys } from "./thumbnails.js";
import { createVideoService } from "./videoService.js";
import { fetchVideoInfo as youtubeFetchVideoInfo } from "./youtube.js";

// Content-Security-Policy from docs/API.md (v1.1, v1.5). YouTube embeds need the
// youtube(-nocookie) frames and scripts; every image is same-origin (thumbnails
// and series covers go through /api/thumbs and /api/covers); the service worker
// and the web manifest come from this origin.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://www.youtube.com", "https://s.ytimg.com"],
  frameSrc: ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
  imgSrc: ["'self'", "data:"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
};

/** Maps body-parser and unknown errors to the API's error shape. */
export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  switch (err?.type) {
    case "entity.too.large":
      return new HttpError(413, "The request body is too large.");
    case "entity.parse.failed":
      return new HttpError(400, "The request body is not valid JSON.", { body: "Invalid JSON." }, "VALIDATION_ERROR");
    case "charset.unsupported":
    case "encoding.unsupported":
      return new HttpError(415, err.message);
    default: {
      // A malformed %-escape in a route parameter ("/api/videos/%FF"): the router throws a URIError (status 400).
      if (err instanceof URIError) {
        return new HttpError(400, "The URL contains an invalid %-escape.", { url: "Malformed percent-encoding." }, "VALIDATION_ERROR");
      }
      // Any other client error raised by Express or a middleware: its status, no stack in the log.
      const status = Number(err?.status ?? err?.statusCode);
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return new HttpError(status, err.expose && err.message ? err.message : (http.STATUS_CODES[status] ?? "Bad request."));
      }
      console.error(err);
      return new HttpError(500, "Something went wrong on our side.", {}, "INTERNAL_ERROR");
    }
  }
}

/**
 * Same-origin images (v1.5): one disk cache (THUMB_CACHE_DIR / THUMB_CACHE_MB) for
 * thumbnails and covers, a source for each (single-flight, 4 upstream fetches at
 * once, failure memory) and one per-IP limit on cache misses.
 */
function createImages({ repo, config, fetchThumbnail, fetchCover }) {
  // A cached file stays only while it belongs to something: a video (live or trashed)
  // with that YouTube ID (either size, "<id>" or "<id>-m"), or a series (live or trashed)
  // whose CURRENT cover URL has that hash.
  const belongs = (key) => {
    const cover = parseCoverKey(key);
    if (cover) {
      const source = repo.coverSource(cover.seriesId)?.sourceUrl;
      return Boolean(source) && coverHash(source) === cover.hash;
    }
    const thumb = parseThumbKey(key);
    return Boolean(thumb) && repo.thumbnailState(thumb.id) !== null;
  };
  const cache = createImageCache({
    dir: config.thumbCacheDir,
    maxBytes: Math.floor(config.thumbCacheMb * 1024 * 1024),
    isKnown: belongs,
  });
  const thumbnails = createThumbnailSource({ cache, fetchThumbnail });
  const covers = createCoverSource({ cache, fetchCover });
  return {
    cache,
    thumbnails,
    covers,
    misses: rateLimit({
      ...config.imageMissRateLimit,
      name: "images",
      message: "Too many images requested. Please wait a few minutes.",
    }),
    /** Files of videos/series deleted for good (delete-forever, the 7-day purge): every thumbnail size. */
    purge({ youtubeIds = [], seriesIds = [] } = {}) {
      cache.remove(thumbKeys(youtubeIds));
      const gone = new Set(seriesIds);
      if (gone.size > 0) cache.removeMatching((key) => gone.has(parseCoverKey(key)?.seriesId));
    },
    /** Files that belong to nothing any more (swapped uploads, replaced covers, a crash mid-purge). */
    prune: () => cache.prune(),
    stats: () => ({ ...cache.stats(), thumbnails: thumbnails.stats(), covers: covers.stats() }),
  };
}

/**
 * Builds the Express app without listening, so tests can start it on port 0.
 * @param db              better-sqlite3 database from openDatabase()
 * @param config          settings from loadConfig() (missing keys get defaults)
 * @param mailer          { send(message), outbox } (default: createMailer(config))
 * @param fetchVideoInfo  async (youtubeVideoId) => { title, channel } (default: YouTube oEmbed)
 * @param fetchThumbnail  async (youtubeVideoId, size) => Buffer of a JPEG ≤ 512 KB, throws on failure;
 *                        size "hq" (GET /api/thumbs/<id>.jpg) or "mq" (<id>-m.jpg) (default:
 *                        <size>default.jpg from i.ytimg.com, or from THUMB_UPSTREAM outside
 *                        production; src/thumbnails.js)
 * @param fetchCover      async (sourceUrl) => { body, type }, throws on failure (default: the
 *                        SSRF-guarded fetch of src/covers.js)
 */
export function createApp({
  db,
  config: overrides = {},
  mailer,
  fetchVideoInfo = youtubeFetchVideoInfo,
  fetchThumbnail,
  fetchCover = (sourceUrl) => fetchCoverImage(sourceUrl),
} = {}) {
  const config = { ...loadConfig({}), ...overrides };
  mailer ??= createMailer(config);
  const thumbBaseUrl = thumbnailUpstream(config); // i.ytimg.com in production, whatever THUMB_UPSTREAM says
  fetchThumbnail ??= (id, size) => fetchYoutubeThumbnail(id, { size, baseUrl: thumbBaseUrl });

  const repo = createRepository(db);
  const videos = createVideoService({ repo, fetchVideoInfo });
  const ratings = createRatingService({ db });
  const images = createImages({ repo, config, fetchThumbnail, fetchCover });
  const trash = createTrashService({ db, repo, videos, onPurged: images.purge });
  const auth = createAuthService({ db, config, mailer, beforeDeleteUser: ratings.removeAllForUser });
  const metrics = createMetricsService({ db, repo, images }); // anonymous aggregates only (v1.6)

  const app = express();
  app.locals.services = { repo, videos, trash, auth, ratings, mailer, config, images, metrics };
  app.set("trust proxy", parseTrustProxy(config.trustProxy)); // throws on "true"/garbage
  app.set("etag", "weak");

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" }, // "no-referrer" breaks YouTube embeds
      crossOriginEmbedderPolicy: false,
    })
  );

  // ---- API ----
  app.use("/api", cors({ origin: config.clientOrigins, credentials: true }));
  app.use("/api", noStore); // catalog GETs switch to a public cache in their router
  // Bodies must be JSON (415) and writes must come from the app's own origin (403 CROSS_SITE_REQUEST).
  app.use("/api", requireJsonBody, requireSameOrigin(config), express.json({ limit: "20kb" }));
  // Same-origin thumbnails and covers (v1.5): anonymous, so before the session lookup (no cookie work per image).
  app.use("/api", imageRoutes({ repo, thumbnails: images.thumbnails, covers: images.covers, misses: images.misses }));
  app.use("/api", loadSession(auth));

  app.use("/api/auth", authRoutes({ auth, config }));
  app.use("/api/me", meRoutes({ auth, ratings, config }));
  app.use("/api/admin", adminRoutes({ repo, videos, trash, metrics }));
  // The dev outbox only exists when e-mails are not really sent.
  if (!config.isProduction && !config.smtp) app.use("/api/dev", devRoutes({ mailer }));
  app.use("/api", ratingRoutes({ repo, ratings }));
  app.use("/api", catalogRoutes({ repo }));
  app.use("/api", () => {
    throw notFound("There is no API endpoint here.");
  });

  // ---- crawlers (served with or without a built client) ----
  app.get("/robots.txt", (req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.type("text/plain").send(robotsTxt(config.appUrl));
  });
  // /sitemap.xml, plus /sitemap-<n>.xml children once there are more than
  // 50,000 URLs (then /sitemap.xml is an index). Rebuilt only on catalog changes.
  const sitemap = createSitemap({ repo, appUrl: config.appUrl, maxUrls: config.sitemapMaxUrls });
  const sendSitemap = (n) => (req, res, next) => {
    const xml = sitemap.get(n ?? Number(req.params.n));
    if (!xml) return next();
    res.set("Cache-Control", "public, max-age=3600");
    res.type("application/xml").send(xml);
  };
  app.get("/sitemap.xml", sendSitemap(0));
  app.get(/^\/sitemap-(?<n>[1-9]\d{0,5})\.xml$/, sendSitemap());

  // ---- built React app (production) ----
  // config.clientDist defaults to ../client/dist; tests point it at a temp dir.
  const indexHtml = path.join(config.clientDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    // In production the file is stat()ed at most every 5 s (a deploy swaps it).
    const template = createTemplate(indexHtml, { checkEveryMs: config.isProduction ? 5000 : 0 });
    // index.html is only ever sent through the SEO renderer below.
    app.get("/index.html", (req, res) => {
      const query = req.originalUrl.indexOf("?");
      res.set("Cache-Control", "no-cache");
      res.redirect(301, `/${query >= 0 ? req.originalUrl.slice(query) : ""}`);
    });
    // Any other spelling that resolves to index.html (//index.html, /%69ndex.html,
    // /./index.html, /assets/../index.html) is redirected too, never served raw.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      let decoded;
      try {
        decoded = decodeURIComponent(req.path);
      } catch {
        return next(); // malformed escapes are answered by the 400 handling
      }
      if (path.posix.basename(path.posix.normalize(decoded)).toLowerCase() !== "index.html") return next();
      res.set("Cache-Control", "no-cache");
      res.redirect(301, "/");
    });
    app.use(
      express.static(config.clientDist, {
        index: false, // "/" goes through the SEO fallback below, like every other page
        setHeaders(res, file) {
          const relative = path.relative(config.clientDist, file).split(path.sep);
          const root = relative.length === 1 ? relative[0] : null;
          if (relative[0] === "assets") res.set("Cache-Control", "public, max-age=31536000, immutable");
          // PWA (v1.5): the browser must always see the current service worker and manifest.
          else if (root === "sw.js") {
            res.set({
              "Cache-Control": "no-cache",
              "Content-Type": "text/javascript; charset=utf-8",
              "Service-Worker-Allowed": "/",
            });
          } else if (root === "manifest.webmanifest") {
            res.set("Cache-Control", "no-cache");
            res.setHeader("Content-Type", "application/manifest+json"); // res.set() would add a charset JSON types do not have
          } else if (file.endsWith(".html")) res.set("Cache-Control", "no-cache"); // offline.html too
        },
      })
    );
    // Client-side routes (/anime/one-piece/episode/5, ...) all get index.html.
    // A missing asset or any other path with a file extension is a real 404:
    // answering it with index.html would hide broken deploys and break caches.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      // Genre names may contain dots (/genre/Sci.Fi): those are pages, not files.
      if (req.path.startsWith("/assets/") || (path.extname(req.path) !== "" && !req.path.startsWith("/genre/"))) {
        res.set("Cache-Control", "no-cache");
        return res.status(404).type("text/plain").send("Not found");
      }
      // index.html with the page's <title>, meta, Open Graph and JSON-LD (src/seo.js).
      res.set("Cache-Control", "no-cache");
      const page = resolvePage(repo, req.path);
      if (page.status === 301) {
        const query = req.originalUrl.indexOf("?");
        return res.redirect(301, page.location + (query >= 0 ? req.originalUrl.slice(query) : ""));
      }
      res.status(page.status).type("html").send(renderPage(template(), page, config.appUrl));
    });
  }

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const error = toHttpError(err);
    res.set("Cache-Control", "private, no-store");
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details ?? {} } });
  });

  return app;
}
