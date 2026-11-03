import { HttpError } from "../errors.js";

/**
 * Fixed-window, in-memory rate limiter keyed by client IP. IPs live only in
 * this Map (never written to disk or logs) and are dropped when their window ends.
 */
export function rateLimit({ max, windowMs, name = "default" }) {
  const hits = new Map();
  let nextSweep = Date.now() + windowMs;

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
      nextSweep = now + windowMs;
    }
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", { retryAfter, limiter: name });
    }
    next();
  };
}
