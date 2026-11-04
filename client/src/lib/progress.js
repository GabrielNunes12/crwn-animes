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
/** Longest believable position/duration (≈ 11.5 days of video). */
export const MAX_SECONDS = 1e6;
/** Imported `at` may be at most this far in the future (clock skew between devices). */
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/** `{ version: 1, exportedAt, entries }` — what "Export watch history" downloads. */
export function exportProgress(now = new Date()) {
  return { version: EXPORT_VERSION, exportedAt: now.toISOString(), entries: getAllProgress() };
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * A clean copy of one imported entry (unknown keys dropped), or null when it is invalid.
 * Rejects absurd numbers: a far-future `at` would pin the entry as "most recent" forever
 * (and make the LRU evict every real entry), a huge `t`/`d` would overflow to Infinity.
 */
export function sanitizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { t, d, at, route = null, title = null, thumb = null } = raw;
  if (!num(t) || !num(d) || !num(at)) return null;
  if (t < 0 || d < 0 || t > MAX_SECONDS || d > MAX_SECONDS) return null;
  if (at <= 0 || at > now + MAX_FUTURE_MS) return null;
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
 * → { ok: true, imported, skipped } | { ok: false, error: "tooLarge" | "invalid" | "storage" }
 *   ("storage": the merged history could not be saved, e.g. the storage quota is full).
 */
export function importProgress(text, { size, now = Date.now() } = {}) {
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
      const entry = sanitizeEntry(raw, now);
      if (!entry) continue;
      const local = all[id];
      if (local && (local.at ?? 0) >= entry.at) continue;
      all[id] = entry;
      applied.add(id);
    }
    const kept = pruneLRU(all);
    const imported = [...applied].filter((id) => id in kept).length;
    if (imported > 0) {
      if (!writeJSON(PROGRESS_KEY, kept)) return { ok: false, error: "storage" };
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

/**
 * Distinct episode routes with local progress: { watched: Set<route>, started: Set<route> }.
 * The one derivation behind both the series cards and the series page: counting routes
 * (not entries) means a swapped YouTube link (old and new ID share a route) counts once. Pure.
 */
export function progressRoutes(entries) {
  const watched = new Set();
  const started = new Set();
  for (const e of Object.values(entries ?? {})) {
    if (!e || !parseRoute(e.route)) continue;
    started.add(e.route);
    if (entryCompleted(e)) watched.add(e.route);
  }
  return { watched, started };
}

/**
 * { "anime/naruto": { watched, started } } — distinct episodes finished / touched per series.
 * Cards compare `watched` with the series' videoCount and cap it there (a deleted episode
 * can still be in local history). Pure.
 */
export function buildSeriesIndex(entries) {
  const { watched, started } = progressRoutes(entries);
  const index = {};
  for (const route of started) {
    const r = parseRoute(route);
    const row = (index[seriesKey(r.section, r.slug)] ??= { watched: 0, started: 0 });
    row.started += 1;
    if (watched.has(route)) row.watched += 1;
  }
  return index;
}

/**
 * What a series page shows for local progress. Pure.
 * `videos` are ALL the series' published videos in that section (season, number order),
 * so N and M match the cards' videoCount.
 * → { watched, total, target, resume, touched, allWatched, unavailableLeft, isWatched }
 *   target = the in-progress episode (most recently watched) if any, else the first unwatched
 *   playable one; null when nothing playable is left.
 *   allWatched only when watched === total. unavailableLeft = unwatched episodes that can't be
 *   played right now (unavailable on YouTube).
 */
export function seriesProgress(videos, entries) {
  const list = videos ?? [];
  const map = entries ?? {};
  // Entries of videos in this list count for that video only (by YouTube ID): after a reorder
  // their stored route may be another episode's. The route match is only for entries whose
  // ID is unknown here (a swapped YouTube link keeps the episode's route).
  const ids = new Set(list.map((v) => v.youtubeVideoId));
  const routes = progressRoutes(Object.fromEntries(Object.entries(map).filter(([id]) => !ids.has(id))));
  const isWatched = (v) => entryCompleted(map[v.youtubeVideoId]) || (v.route != null && routes.watched.has(v.route));
  const isPlayable = (v) => Boolean(v.route) && v.availability !== "unavailable";
  const playable = list.filter(isPlayable);
  const watched = list.filter(isWatched).length;
  const touched = list.some((v) => map[v.youtubeVideoId] || (v.route != null && routes.started.has(v.route)));
  let inProgress = null;
  for (const v of playable) {
    const e = map[v.youtubeVideoId];
    if (resumePosition(e) > 0 && !isWatched(v) && (!inProgress || e.at > map[inProgress.youtubeVideoId].at)) inProgress = v;
  }
  const firstUnwatched = playable.find((v) => !isWatched(v)) ?? null;
  return {
    watched,
    total: list.length,
    target: inProgress ?? firstUnwatched,
    /** True when the target has a saved position (the Watch page resumes it). */
    resume: Boolean(inProgress),
    /** Any local progress for this series at all. */
    touched,
    allWatched: list.length > 0 && watched === list.length,
    unavailableLeft: list.filter((v) => !isPlayable(v) && !isWatched(v)).length,
    isWatched,
  };
}

/**
 * Called by a series / watch page with the FULL published list of that series in that section.
 * An entry whose YouTube ID is in the list gets that video's current route (episodes get
 * renumbered: after a reorder every old route still exists but may be another video's).
 * Entries with an unknown ID whose route belongs to this series+section are kept when the route
 * still exists (a swapped YouTube link) and removed when it doesn't (episode deleted).
 * Other series are never touched. Afterwards the cards' route-based counts and the
 * "Continue watching" links agree with the page. Returns how many changed.
 */
export function pruneSeriesProgress(section, slug, videos) {
  if (!section || !slug || !Array.isArray(videos) || videos.length === 0) return 0;
  const routes = new Set(videos.map((v) => v.route).filter(Boolean));
  const routeById = new Map(videos.filter((v) => v.route).map((v) => [v.youtubeVideoId, v.route]));
  const all = getAllProgress();
  let changed = 0;
  for (const [id, e] of Object.entries(all)) {
    const current = routeById.get(id);
    if (current) {
      if (e?.route !== current) {
        all[id] = { ...e, route: current };
        changed += 1;
      }
      continue;
    }
    const r = parseRoute(e?.route);
    if (!r || r.section !== section || r.slug !== slug || routes.has(e.route)) continue;
    delete all[id];
    changed += 1;
  }
  if (changed && writeJSON(PROGRESS_KEY, all)) emit();
  return changed;
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
