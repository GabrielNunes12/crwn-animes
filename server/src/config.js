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

function trustProxy(value) {
  if (value == null || value === "" || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // "loopback", "10.0.0.0/8", ...
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
    adminEmails: list(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
    trustProxy: trustProxy(env.TRUST_PROXY),
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
    clientDist: path.resolve(SERVER_DIR, "../client/dist"),
  };
}
