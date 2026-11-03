import { MIN_PASSWORD } from "./password.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns { field: translationKey } for every invalid registration field. */
export function validateRegistration({ email, displayName, password, consent }) {
  const errors = {};
  if (!EMAIL_RE.test(email.trim())) errors.email = "auth.errors.email";
  const name = displayName.trim();
  if (name.length < 2 || name.length > 30) errors.displayName = "auth.errors.displayName";
  if (password.length < MIN_PASSWORD) errors.password = "auth.errors.passwordLength";
  if (!consent) errors.consent = "auth.errors.consent";
  return errors;
}

/** Only allow same-site relative redirects (?next=). */
export function safeNext(next) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
