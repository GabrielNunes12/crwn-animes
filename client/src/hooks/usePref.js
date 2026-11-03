import { useCallback, useSyncExternalStore } from "react";
import { readString } from "../lib/storage.js";
import { setBool } from "../lib/prefs.js";

const EVENT = "crwn:pref-change";

function subscribe(cb) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** A boolean localStorage preference shared live between components: [value, set]. */
export function useBoolPref(key, fallback) {
  const raw = useSyncExternalStore(subscribe, () => readString(key), () => null);
  const value = raw == null ? fallback : raw === "1";
  const set = useCallback(
    (next) => {
      setBool(key, next);
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  return [value, set];
}
