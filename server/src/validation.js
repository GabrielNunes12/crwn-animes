import { validationError } from "./errors.js";
import { DEFAULT_LOCALE, LOCALES } from "./mail.js";

// Small, dependency-free validators. Each `check` collects a message per field
// and `done()` throws one 400 VALIDATION_ERROR listing all of them.

// No whitespace and no control characters (\p{Cc}: NUL, ESC, DEL, C1 controls, ...).
export const EMAIL_RE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const REACTIONS = ["fire", "laugh", "cry", "wow", "love"];

const length = (s) => [...s].length;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The JSON body as a plain object (an empty one when there is no body). */
export function bodyOf(req) {
  const body = req.body ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw validationError({ body: "Expected a JSON object." }, "Expected a JSON object.");
  }
  return body;
}

export function validator(body) {
  const errors = {};
  const fail = (field, message) => {
    errors[field] ??= message;
    return undefined;
  };
  const v = {
    errors,
    has: (field) => has(body, field),
    fail,

    email(field = "email") {
      const value = body[field];
      if (typeof value !== "string") return fail(field, "Enter your e-mail.");
      const email = value.trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return fail(field, "Enter a valid e-mail address.");
      return email;
    },

    password(field = "password", { checkStrength = true } = {}) {
      const value = body[field];
      if (typeof value !== "string" || value.length === 0) return fail(field, "Enter a password.");
      if (checkStrength && length(value) < 10) return fail(field, "Use at least 10 characters.");
      if (length(value) > 256) return fail(field, "Use at most 256 characters.");
      return value;
    },

    displayName(field = "displayName") {
      const value = body[field];
      if (typeof value !== "string") return fail(field, "Enter a display name.");
      const name = value.trim().replace(/\s+/g, " ");
      if (CONTROL_CHARS.test(name)) return fail(field, "The name has invalid characters.");
      if (length(name) < 2 || length(name) > 30) return fail(field, "Use 2 to 30 characters.");
      return name;
    },

    locale(field = "locale") {
      const value = body[field];
      if (value == null) return DEFAULT_LOCALE;
      if (!LOCALES.includes(value)) return fail(field, `Must be one of: ${LOCALES.join(", ")}.`);
      return value;
    },

    token(field = "token") {
      const value = body[field];
      if (typeof value !== "string" || value.length === 0 || value.length > 200) return fail(field, "Missing token.");
      return value;
    },

    /** Trimmed string; `null`/"" become null when nullable. */
    string(field, { required = false, min = 1, max = 200, nullable = false } = {}) {
      const value = body[field];
      if (value == null || (nullable && typeof value === "string" && value.trim() === "")) {
        if (required) return fail(field, "This field is required.");
        return nullable ? null : undefined;
      }
      if (typeof value !== "string") return fail(field, "Must be a string.");
      const text = value.trim();
      if (length(text) < min) return fail(field, required ? "This field is required." : `Use at least ${min} characters.`);
      if (length(text) > max) return fail(field, `Use at most ${max} characters.`);
      return text;
    },

    int(field, { min, max, nullable = false } = {}) {
      const value = body[field];
      if (value === null && nullable) return null;
      if (!Number.isInteger(value) || value < min || value > max) {
        return fail(field, `Must be a whole number from ${min} to ${max}.`);
      }
      return value;
    },

    oneOf(field, options, { nullable = false } = {}) {
      const value = body[field];
      if (value === null && nullable) return null;
      if (!options.includes(value)) return fail(field, `Must be one of: ${options.join(", ")}.`);
      return value;
    },

    slug(field, { nullable = false } = {}) {
      const value = body[field];
      if (value === null && nullable) return null;
      if (typeof value !== "string" || value.length > 100 || !SLUG_RE.test(value)) {
        return fail(field, "Use lower-case letters, digits and single dashes (e.g. one-piece).");
      }
      return value;
    },

    /** Array of trimmed, non-empty strings, de-duplicated (case-insensitive). */
    stringList(field, { maxItems = 50, maxLength = 100 } = {}) {
      const value = body[field];
      if (!Array.isArray(value)) return fail(field, "Must be a list of strings.");
      if (value.length > maxItems) return fail(field, `Use at most ${maxItems} items.`);
      const seen = new Set();
      const out = [];
      for (const item of value) {
        if (typeof item !== "string" || item.trim() === "") return fail(field, "Every item must be a non-empty string.");
        const text = item.trim();
        if (length(text) > maxLength) return fail(field, `Every item must have at most ${maxLength} characters.`);
        if (seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        out.push(text);
      }
      return out;
    },

    httpUrl(field, { nullable = false } = {}) {
      const value = body[field];
      if ((value === null || value === "") && nullable) return null;
      if (typeof value !== "string" || value.length > 2048) return fail(field, "Must be an http(s) URL.");
      try {
        const url = new URL(value.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        return url.toString();
      } catch {
        return fail(field, "Must be an http(s) URL.");
      }
    },

    done() {
      if (Object.keys(errors).length) throw validationError(errors);
    },
  };
  return v;
}

/** Positive integer route parameter, or null. */
export function idParam(value) {
  return /^[1-9]\d{0,15}$/.test(String(value)) ? Number(value) : null;
}

/** ?limit= with a default; clamped to `max`; 400 when not a positive integer. */
export function limitParam(value, { fallback = 12, max = 50 } = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1) {
    throw validationError({ limit: `Must be a whole number from 1 to ${max}.` });
  }
  return Math.min(Number(value), max);
}

/**
 * Reads query-string parameters, collecting one message per bad field;
 * `done()` throws a single 400 VALIDATION_ERROR listing all of them.
 * A repeated parameter (?q=a&q=b arrives as an array) is always an error.
 */
export function queryReader(query) {
  const errors = {};
  const fail = (field, message) => void (errors[field] ??= message);
  const reader = {
    errors,
    fail,
    /** Trimmed text of at most `max` characters; absent/blank → null. */
    text(field, max) {
      const value = query[field];
      if (value == null) return null;
      if (typeof value !== "string") return fail(field, "Send this parameter once, as text.");
      const trimmed = value.trim();
      if (length(trimmed) > max) return fail(field, `Use at most ${max} characters.`);
      return trimmed === "" ? null : trimmed;
    },
    /** Whole number in [min, max]; absent/blank → fallback. `clamp` turns values above max into max. */
    int(field, { min, max, fallback, clamp = false }) {
      const value = query[field];
      if (value == null || value === "") return fallback;
      const message = `Must be a whole number from ${min} to ${max}.`;
      if (typeof value !== "string" || !/^\d+$/.test(value)) return fail(field, message);
      const n = Number(value);
      if (n < min || (n > max && !clamp)) return fail(field, message);
      return Math.min(n, max);
    },
    /** One of `options`; absent/blank → null. */
    oneOf(field, options) {
      const value = reader.text(field, 40);
      if (value != null && !options.includes(value)) return fail(field, `Must be one of: ${options.join(", ")}.`);
      return value ?? null;
    },
    done() {
      if (Object.keys(errors).length) throw validationError(errors);
    },
  };
  return reader;
}
