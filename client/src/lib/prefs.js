// Per-device preferences (localStorage). None of this is personal data on the server.
import { readString, writeString } from "./storage.js";

export const THEME_KEY = "crwn:theme";
export const ALWAYS_LOAD_KEY = "crwn:yt-always-load";
export const AUTOPLAY_KEY = "crwn:autoplay-next";
export const LOCALE_KEY = "crwn:locale";

export function getBool(key, fallback = false) {
  const v = readString(key);
  return v == null ? fallback : v === "1";
}

export function setBool(key, value) {
  writeString(key, value ? "1" : "0");
}

export function getTheme() {
  const v = readString(THEME_KEY);
  return v === "light" || v === "dark" ? v : null;
}

export function effectiveTheme() {
  const saved = getTheme();
  if (saved) return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setTheme(theme) {
  writeString(THEME_KEY, theme);
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}
