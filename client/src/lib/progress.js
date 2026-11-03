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
