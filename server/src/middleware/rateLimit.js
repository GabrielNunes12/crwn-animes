import net from "node:net";
import { HttpError } from "../errors.js";

/** Expands an IPv6 address to its 8 hextets (as numbers), or null. */
function ipv6Hextets(ip) {
  const [head, tail = null] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const parse = (part) => (part ? part.split(":") : []);
  let left = parse(head);
  let right = tail === null ? [] : parse(tail);
  // A trailing embedded IPv4 (::ffff:1.2.3.4) counts as two hextets.
  const last = (tail === null ? left : right).at(-1);
  if (last?.includes(".")) {
    const octets = last.split(".").map(Number);
    const extra = [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
    if (tail === null) left = [...left.slice(0, -1), ...extra];
    else right = [...right.slice(0, -1), ...extra];
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === null && missing !== 0)) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map((h) => Number.parseInt(h || "0", 16));
}

/**
 * The rate-limit key for an IP: IPv4 as is, IPv6 by its /64 (one subscriber
 * usually gets a whole /64, so per-address keys would be trivial to rotate).
 */
export function ipKey(ip) {
  if (!ip) return "unknown";
  const plain = ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (!net.isIPv6(plain)) return plain;
  const hextets = ipv6Hextets(plain.split("%")[0]);
  if (!hextets) return plain;
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
}

/**
 * Fixed-window, in-memory rate limiter. Keys (client IPs by default) live only
 * in this Map, never on disk or in logs, and are dropped when their window
 * ends. The Map is capped at `maxEntries`: past that, the oldest key is evicted.
 */
export function rateLimit({
  max,
  windowMs,
  name = "default",
  key = (req) => ipKey(req.ip),
  maxEntries = 10_000,
  message = "Too many attempts. Please wait a few minutes and try again.",
}) {
  const hits = new Map();
  let nextSweep = Date.now() + windowMs;

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
      nextSweep = now + windowMs;
    }
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      hits.delete(k); // re-insert at the end: Map order = age
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
      while (hits.size > maxEntries) hits.delete(hits.keys().next().value);
    }
    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      throw new HttpError(429, message, { retryAfter, limiter: name });
    }
    next();
  };
}
