// Watch progress lives ONLY in this browser (localStorage), never on the server.
// Shape: { [youtubeVideoId]: { t, d, at, route, title, thumb } }
//   t = position (s), d = duration (s), at = last update (ms epoch)
// Capped at MAX_ENTRIES, evicting the least recently updated (LRU).
import { readJSON, writeJSON, removeKey } from "./storage.js";

export const PROGRESS_KEY = "crwn:progress:v1";
export const MAX_ENTRIES = 200;
export const COMPLETE_RATIO = 0.9;
/** Below this many seconds there is nothing worth resuming. */
export const MIN_RESUME_SECONDS = 5;

const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

export function subscribeProgress(fn) {
  listeners.add(fn);
  const onStorage = (e) => {
    if (e.key === PROGRESS_KEY || e.key === null) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function isCompleted(position, duration) {
  if (!(duration > 0)) return false;
  return position / duration >= COMPLETE_RATIO;
}

export function getAllProgress() {
  const data = readJSON(PROGRESS_KEY, {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export function getProgress(youtubeVideoId) {
  return getAllProgress()[youtubeVideoId] ?? null;
}

/** Keep the newest `max` entries by `at`. Pure. */
export function pruneLRU(entries, max = MAX_ENTRIES) {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  const keep = keys.sort((a, b) => (entries[b].at ?? 0) - (entries[a].at ?? 0)).slice(0, max);
  return Object.fromEntries(keep.map((k) => [k, entries[k]]));
}

/**
 * Save the position for a video. `ended: true` (player ENDED) marks it complete.
 * Returns the stored entry.
 */
export function saveProgress(youtubeVideoId, { position, duration, ended = false, route, title, thumb, now = Date.now() }) {
  if (!youtubeVideoId) return null;
  const all = getAllProgress();
  const prev = all[youtubeVideoId] ?? {};
  const d = Number.isFinite(duration) && duration > 0 ? duration : prev.d ?? 0;
  let t = Number.isFinite(position) && position >= 0 ? position : prev.t ?? 0;
  if (ended && d > 0) t = d;
  const entry = {
    t: Math.round(t * 10) / 10,
    d: Math.round(d * 10) / 10,
    at: now,
    route: route ?? prev.route ?? null,
    title: title ?? prev.title ?? null,
    thumb: thumb ?? prev.thumb ?? null,
  };
  // Re-insert so it counts as most recent, then cap.
  delete all[youtubeVideoId];
  all[youtubeVideoId] = entry;
  writeJSON(PROGRESS_KEY, pruneLRU(all));
  emit();
  return entry;
}

export function entryCompleted(entry) {
  return Boolean(entry) && isCompleted(entry.t, entry.d);
}

/** Seconds to resume from, or 0 when there is nothing to resume / it was finished. */
export function resumePosition(entry) {
  if (!entry || entryCompleted(entry)) return 0;
  if (!(entry.t >= MIN_RESUME_SECONDS)) return 0;
  if (entry.d > 0 && entry.d - entry.t < MIN_RESUME_SECONDS) return 0;
  return Math.floor(entry.t);
}

/** Started but unfinished videos, most recent first. */
export function continueWatching(limit = 12) {
  const all = getAllProgress();
  return Object.entries(all)
    .filter(([, e]) => e.route && resumePosition(e) > 0)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, limit)
    .map(([youtubeVideoId, e]) => ({ youtubeVideoId, ...e }));
}

// ------------------------------------------------- export / import (portability)
export const EXPORT_FILENAME = "crwn-animes-progress.json";
export const EXPORT_VERSION = 1;
/** Import files bigger than this are refused before being read. */
export const MAX_IMPORT_BYTES = 1024 * 1024;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Only our own front-end routes (see docs/API.md) — never an arbitrary URL.
const ROUTE = /^\/(anime|manga)\/([a-z0-9-]+)\/(?:episode\/\d+|season\/(\d+)\/episode\/\d+|chapter\/\d+)$/;
// Thumbnails must stay first-party YouTube images: an imported file must not make
// the browser fetch from arbitrary hosts.
const THUMB = /^https:\/\/i\.ytimg\.com\/[^\s"'<>]{1,300}$/;
const MAX_TITLE = 300;

/** `{ version: 1, exportedAt, entries }` — what "Export watch history" downloads. */
export function exportProgress(now = new Date()) {
  return { version: EXPORT_VERSION, exportedAt: now.toISOString(), entries: getAllProgress() };
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** A clean copy of one imported entry (unknown keys dropped), or null when it is invalid. */
export function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { t, d, at, route = null, title = null, thumb = null } = raw;
  if (!num(t) || !num(d) || !num(at) || t < 0 || d < 0 || at <= 0) return null;
  if (d > 0 && t > d + 1) return null;
  if (route !== null && (typeof route !== "string" || !ROUTE.test(route))) return null;
  if (title !== null && typeof title !== "string") return null;
  if (thumb !== null && typeof thumb !== "string") return null;
  return {
    t: Math.round(t * 10) / 10,
    d: Math.round(d * 10) / 10,
    at: Math.round(at),
    route,
    title: title === null ? null : title.slice(0, MAX_TITLE),
    thumb: thumb !== null && THUMB.test(thumb) ? thumb : null,
  };
}

/**
 * Merges an exported file (its text) into local progress. Never throws.
 * Newest `at` wins per video; invalid entries are skipped; the 200-entry cap is kept
 * (entries evicted by the cap count as skipped).
 * → { ok: true, imported, skipped } | { ok: false, error: "tooLarge" | "invalid" }
 */
export function importProgress(text, { size } = {}) {
  try {
    const bytes = size ?? new Blob([text ?? ""]).size;
    if (bytes > MAX_IMPORT_BYTES) return { ok: false, error: "tooLarge" };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "invalid" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== EXPORT_VERSION) return { ok: false, error: "invalid" };
    const incoming = data.entries;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return { ok: false, error: "invalid" };

    const all = getAllProgress();
    const applied = new Set();
    let seen = 0;
    for (const [id, raw] of Object.entries(incoming)) {
      seen += 1;
      if (!VIDEO_ID.test(id)) continue;
      const entry = sanitizeEntry(raw);
      if (!entry) continue;
      const local = all[id];
      if (local && (local.at ?? 0) >= entry.at) continue;
      all[id] = entry;
      applied.add(id);
    }
    const kept = pruneLRU(all);
    const imported = [...applied].filter((id) => id in kept).length;
    if (imported > 0) {
      writeJSON(PROGRESS_KEY, kept);
      emit();
    }
    return { ok: true, imported, skipped: seen - imported };
  } catch {
    return { ok: false, error: "invalid" };
  }
}

// ------------------------------------------------------ per-series lookups
/** "/anime/naruto/season/2/episode/3" → { section: "anime", slug: "naruto", season: 2 }, else null. */
export function parseRoute(route) {
  const m = typeof route === "string" ? ROUTE.exec(route) : null;
  return m ? { section: m[1], slug: m[2], season: m[3] ? Number(m[3]) : 1 } : null;
}

export const seriesKey = (section, slug) => `${section}/${slug}`;

/** { "anime/naruto": { watched, started } } — how many episodes of each series were finished / touched. Pure. */
export function buildSeriesIndex(entries) {
  const index = {};
  for (const e of Object.values(entries ?? {})) {
    const r = parseRoute(e?.route);
    if (!r) continue;
    const key = seriesKey(r.section, r.slug);
    const row = (index[key] ??= { watched: 0, started: 0 });
    row.started += 1;
    if (entryCompleted(e)) row.watched += 1;
  }
  return index;
}

/**
 * What a series page shows for local progress. Pure.
 * `videos` are the series' published videos in that section (season, number order).
 * → { watched, total, target, resume, allWatched }
 *   target = the in-progress episode (most recently watched) if any, else the first unwatched playable one.
 */
export function seriesProgress(videos, entries) {
  const list = videos ?? [];
  const map = entries ?? {};
  const playable = list.filter((v) => v.route && v.availability !== "unavailable");
  const watched = list.filter((v) => entryCompleted(map[v.youtubeVideoId])).length;
  const touched = list.some((v) => map[v.youtubeVideoId]);
  let inProgress = null;
  for (const v of playable) {
    const e = map[v.youtubeVideoId];
    if (resumePosition(e) > 0 && (!inProgress || e.at > map[inProgress.youtubeVideoId].at)) inProgress = v;
  }
  const firstUnwatched = playable.find((v) => !entryCompleted(map[v.youtubeVideoId])) ?? null;
  const target = inProgress ?? firstUnwatched;
  return {
    watched,
    total: list.length,
    target,
    /** True when the target has a saved position (the Watch page resumes it). */
    resume: Boolean(inProgress),
    /** Any local progress for this series at all. */
    touched,
    allWatched: playable.length > 0 && !firstUnwatched,
  };
}

export function removeProgress(youtubeVideoId) {
  const all = getAllProgress();
  if (!(youtubeVideoId in all)) return;
  delete all[youtubeVideoId];
  writeJSON(PROGRESS_KEY, all);
  emit();
}

export function clearProgress() {
  removeKey(PROGRESS_KEY);
  emit();
}

/** 754 -> "12:34", 3723 -> "1:02:03" */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
