import { useMemo, useSyncExternalStore } from "react";
import { buildSeriesIndex, PROGRESS_KEY, seriesKey, subscribeProgress } from "../lib/progress.js";
import { readString } from "../lib/storage.js";

const getRaw = () => readString(PROGRESS_KEY, "{}");

function parse(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Live view of all local watch progress ({ [youtubeVideoId]: entry }). */
export function useProgressMap() {
  const raw = useSyncExternalStore(subscribeProgress, getRaw, () => "{}");
  return useMemo(() => parse(raw), [raw]);
}

// One index shared by every card on the page, rebuilt only when storage changes.
let cache = { raw: null, index: {} };
function seriesIndexFor(raw) {
  if (cache.raw !== raw) cache = { raw, index: buildSeriesIndex(parse(raw)) };
  return cache.index;
}

/**
 * `{ watched, started }` for one series from local progress (derived from each
 * entry's stored `route`), or null when this browser has no progress for it.
 */
export function useSeriesProgress(section, slug) {
  const raw = useSyncExternalStore(subscribeProgress, getRaw, () => "{}");
  return seriesIndexFor(raw)[seriesKey(section, slug)] ?? null;
}
