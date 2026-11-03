import { HttpError } from "../errors.js";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const hasBody = (req) =>
  req.headers["transfer-encoding"] !== undefined ||
  (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");

/**
 * Part of the CSRF defence (with SameSite=Lax): a cross-site <form> can only
 * send urlencoded/multipart/text bodies, so any body must be application/json.
 */
export function requireJsonBody(req, res, next) {
  if (BODY_METHODS.has(req.method) && hasBody(req) && !req.is("application/json")) {
    throw new HttpError(415, "Send the request body as application/json.");
  }
  next();
}

/** "https://Example.com/" -> "https://example.com"; null when not a URL. */
function originOf(value) {
  try {
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * CSRF defence for state-changing requests (POST/PUT/PATCH/DELETE), on top of
 * SameSite=Lax and requireJsonBody (which only sees requests with a body):
 *   - Sec-Fetch-Site present: allowed when "same-origin" or "none" (typed URL,
 *     bookmark), or when Origin is a trusted origin; otherwise 403.
 *   - no Sec-Fetch-Site (older browsers) but Origin present: Origin must be trusted.
 *   - neither header (curl, server-to-server, tests): allowed.
 * Trusted origins: the APP_URL origin and every CLIENT_ORIGIN (the CORS allow
 * list). The client always calls a relative /api, so through the Vite dev or
 * preview proxy, or served by this server, its requests are same-origin.
 */
export function requireSameOrigin(config) {
  const trusted = new Set([config.appUrl, ...(config.clientOrigins ?? [])].map(originOf).filter(Boolean));
  return function sameOriginCheck(req, res, next) {
    if (!BODY_METHODS.has(req.method)) return next();
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if (site === "same-origin" || site === "none") return next();
    if (site === undefined && origin === undefined) return next();
    if (origin !== undefined && trusted.has(origin)) return next();
    throw new HttpError(403, "Cross-site requests cannot change anything here.", {}, "CROSS_SITE_REQUEST");
  };
}

export function noStore(req, res, next) {
  res.set("Cache-Control", "private, no-store");
  next();
}

/** Public catalog data: short browser/CDN cache; Express adds a weak ETag and answers 304s. */
export function publicCache(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") {
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
  }
  next();
}
