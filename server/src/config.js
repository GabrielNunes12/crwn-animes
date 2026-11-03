import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the server/ directory, whatever the current working directory is. */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const list = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const NAMED_SUBNETS = new Set(["loopback", "linklocal", "uniquelocal"]);
const IP_OR_CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]*:[0-9a-f:.]*)(?:\/\d{1,3})?$/i;

/**
 * TRUST_PROXY must say exactly which proxies to trust: a hop count ("1") or a
 * comma-separated list of addresses/subnets ("10.0.0.0/8, loopback").
 * "true" (trust any X-Forwarded-For) would let clients pick their own IP and
 * dodge rate limiting, so it is refused.
 */
export function parseTrustProxy(value) {
  if (value == null || value === false || value === "" || value === "false" || value === 0 || value === "0") return false;
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  const entries = typeof value === "string" ? list(value) : Array.isArray(value) ? value : null;
  if (entries?.length && entries.every((e) => NAMED_SUBNETS.has(e) || IP_OR_CIDR.test(e))) return entries;
  throw new Error(
    `TRUST_PROXY must be a hop count (e.g. 1) or a list of proxy addresses/subnets (e.g. "10.0.0.0/8, loopback"); got ${JSON.stringify(value)}.`
  );
}

/** Settings that are fine in development but unsafe in production. Throws with the reason. */
export function assertSafeConfig(config) {
  parseTrustProxy(config.trustProxy);
  if (config.isProduction && !config.smtp) {
    throw new Error(
      "NODE_ENV=production needs SMTP_HOST: without it e-mails (verification, password reset) would never reach users."
    );
  }
  if (config.isProduction) {
    let url = null;
    try {
      url = config.appUrlSet === false ? null : new URL(config.appUrl);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:") {
      throw new Error(
        "NODE_ENV=production needs APP_URL set to the site's public https:// address: it is used for canonical URLs, the sitemap and e-mail links."
      );
    }
  }
}

/** Reads every setting from environment variables (see .env.example). */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: int(env.PORT, 4000),
    databaseFile: env.DATABASE_FILE || "./data/crwn-animes.db",
    clientOrigins: env.CLIENT_ORIGIN ? list(env.CLIENT_ORIGIN) : ["http://localhost:5173"],
    appUrl: (env.APP_URL || "http://localhost:5173").replace(/\/+$/, ""),
    appUrlSet: Boolean(env.APP_URL),
    adminEmails: list(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimit: { max: int(env.RATE_LIMIT_MAX, 10), windowMs: 15 * 60 * 1000 },
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: int(env.SMTP_PORT, 587),
          secure: env.SMTP_SECURE === "true",
          user: env.SMTP_USER || null,
          pass: env.SMTP_PASS || null,
        }
      : null,
    mailFrom: env.MAIL_FROM || "Crwn Animes <no-reply@localhost>",
    sitemapMaxUrls: 50_000, // per sitemap file (protocol limit); tests lower it
    // Built React app served in production; relative paths resolve from server/.
    clientDist: path.resolve(SERVER_DIR, env.CLIENT_DIST || "../client/dist"),
  };
}
