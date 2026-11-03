import { useEffect, useState } from "react";
import { catalogApi } from "../api/client.js";

let cache = null;

/** Every genre (GET /api/genres), fetched once per page load; [] until it arrives or on error. */
export function useGenres() {
  const [genres, setGenres] = useState(() => (Array.isArray(cache) ? cache : []));
  useEffect(() => {
    if (Array.isArray(cache)) return undefined;
    let live = true;
    catalogApi
      .genres()
      .then((list) => {
        cache = Array.isArray(list) ? list : [];
        if (live) setGenres(cache);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return genres;
}

/** Test helper: forget the cached list. */
export function resetGenresCache() {
  cache = null;
}
