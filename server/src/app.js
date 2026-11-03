import cors from "cors";
import express from "express";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { createAuthService } from "./authService.js";
import { loadConfig, parseTrustProxy } from "./config.js";
import { HttpError, notFound } from "./errors.js";
import { createMailer } from "./mail.js";
import { noStore, requireJsonBody } from "./middleware/security.js";
import { loadSession } from "./middleware/session.js";
import { createRatingService } from "./ratingService.js";
import { createRepository } from "./repository.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { devRoutes } from "./routes/dev.js";
import { meRoutes } from "./routes/me.js";
import { ratingRoutes } from "./routes/ratings.js";
import { createVideoService } from "./videoService.js";
import { fetchVideoInfo as youtubeFetchVideoInfo } from "./youtube.js";

// Content-Security-Policy from docs/API.md (v1.1). YouTube embeds need the
// youtube(-nocookie) frames and scripts; thumbnails come from i.ytimg.com.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://www.youtube.com", "https://s.ytimg.com"],
  frameSrc: ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
  imgSrc: ["'self'", "data:", "https:"], // series covers can live on any https host
  styleSrc: ["'self'", "'unsafe-inline'"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
};

/** Maps body-parser and unknown errors to the API's error shape. */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  switch (err?.type) {
    case "entity.too.large":
      return new HttpError(413, "The request body is too large.");
    case "entity.parse.failed":
      return new HttpError(400, "The request body is not valid JSON.", { body: "Invalid JSON." }, "VALIDATION_ERROR");
    case "charset.unsupported":
    case "encoding.unsupported":
      return new HttpError(415, err.message);
    default:
      if (err?.expose && err.status >= 400 && err.status < 500) return new HttpError(err.status, err.message);
      console.error(err);
      return new HttpError(500, "Something went wrong on our side.", {}, "INTERNAL_ERROR");
  }
}

/**
 * Builds the Express app without listening, so tests can start it on port 0.
 * @param db              better-sqlite3 database from openDatabase()
 * @param config          settings from loadConfig() (missing keys get defaults)
 * @param mailer          { send(message), outbox } (default: createMailer(config))
 * @param fetchVideoInfo  async (youtubeVideoId) => { title, channel } (default: YouTube oEmbed)
 */
export function createApp({ db, config: overrides = {}, mailer, fetchVideoInfo = youtubeFetchVideoInfo } = {}) {
  const config = { ...loadConfig({}), ...overrides };
  mailer ??= createMailer(config);

  const repo = createRepository(db);
  const videos = createVideoService({ repo, fetchVideoInfo });
  const ratings = createRatingService({ db });
  const auth = createAuthService({ db, config, mailer, beforeDeleteUser: ratings.removeAllForUser });

  const app = express();
  app.locals.services = { repo, videos, auth, ratings, mailer, config };
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
  app.use("/api", requireJsonBody, express.json({ limit: "20kb" }));
  app.use("/api", loadSession(auth));

  app.use("/api/auth", authRoutes({ auth, config }));
  app.use("/api/me", meRoutes({ auth, ratings, config }));
  app.use("/api/admin", adminRoutes({ repo, videos }));
  // The dev outbox only exists when e-mails are not really sent.
  if (!config.isProduction && !config.smtp) app.use("/api/dev", devRoutes({ mailer }));
  app.use("/api", ratingRoutes({ repo, ratings }));
  app.use("/api", catalogRoutes({ repo }));
  app.use("/api", () => {
    throw notFound("There is no API endpoint here.");
  });

  // ---- built React app (production) ----
  const indexHtml = path.join(config.clientDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.clientDist, {
        setHeaders(res, file) {
          const relative = path.relative(config.clientDist, file).split(path.sep);
          if (relative[0] === "assets") res.set("Cache-Control", "public, max-age=31536000, immutable");
          else if (file.endsWith(".html")) res.set("Cache-Control", "no-cache");
        },
      })
    );
    // Client-side routes (/anime/one-piece/episode/5, ...) all get index.html.
    // A missing asset or any other path with a file extension is a real 404:
    // answering it with index.html would hide broken deploys and break caches.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/assets/") || path.extname(req.path) !== "") {
        res.set("Cache-Control", "no-cache");
        return res.status(404).type("text/plain").send("Not found");
      }
      res.set("Cache-Control", "no-cache");
      res.sendFile(indexHtml);
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
