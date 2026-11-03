import { HttpError } from "../errors.js";
import { SESSION_TTL_MS } from "../authService.js";

export const COOKIE_NAME = "sid";

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

const cookieOptions = (config) => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.isProduction,
  path: "/",
});

export function setSessionCookie(res, config, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(config), maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res, config) {
  res.clearCookie(COOKIE_NAME, cookieOptions(config));
}

/** Sets req.sessionToken and req.user (the raw user row, or null). */
export function loadSession(auth) {
  return function sessionLoader(req, res, next) {
    req.sessionToken = readCookie(req, COOKIE_NAME);
    req.user = auth.userForSession(req.sessionToken);
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) throw new HttpError(401, "Log in to do this.");
  next();
}

export function requireVerified(req, res, next) {
  if (!req.user) throw new HttpError(401, "Log in to do this.");
  if (!req.user.email_verified_at) {
    throw new HttpError(403, "Confirm your e-mail first.", {}, "EMAIL_NOT_VERIFIED");
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) throw new HttpError(401, "Log in to do this.");
  if (req.user.role !== "admin") throw new HttpError(403, "Only admins can do this.");
  next();
}
