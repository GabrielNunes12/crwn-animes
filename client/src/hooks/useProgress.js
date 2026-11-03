import { useMemo, useSyncExternalStore } from "react";
import { PROGRESS_KEY, subscribeProgress } from "../lib/progress.js";
import { readString } from "../lib/storage.js";

const getRaw = () => readString(PROGRESS_KEY, "{}");

/** Live view of all local watch progress ({ [youtubeVideoId]: entry }). */
export function useProgressMap() {
  const raw = useSyncExternalStore(subscribeProgress, getRaw, () => "{}");
  return useMemo(() => {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }, [raw]);
}
