import { catalogApi } from "../../api/client.js";

/** Rows fail soft: a broken row is hidden instead of breaking the page. */
const soft = (p, fallback = []) => p.catch(() => fallback);

// Route loaders live outside the page modules: router.jsx defines them statically so the
// data requests start together with the lazy page download (docs/API.md v1.7).
export function loader() {
  return {
    sections: soft(catalogApi.sections(), null),
    genres: soft(catalogApi.genres()),
    latest: soft(catalogApi.latest({ limit: 24 })),
    trending: soft(catalogApi.trending(undefined, 12)),
    topAnime: soft(catalogApi.topRated("anime", 12)),
    topManga: soft(catalogApi.topRated("manga", 12)),
  };
}
