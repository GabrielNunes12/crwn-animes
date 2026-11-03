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
