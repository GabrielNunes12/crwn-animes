import { catalogApi } from "../../api/client.js";

/** Rows fail soft: a broken row is hidden instead of breaking the page. */
const soft = (p, fallback = []) => p.catch(() => fallback);

// Route loaders live outside the page modules: router.jsx defines them statically so the
// data requests start together with the lazy page download (docs/API.md v1.7).
export function loader() {
  let rows = null;
  return {
    sections: soft(catalogApi.sections(), null),
    // The card rows and genres are below the fold: Home asks for them once the hero has painted
    // (`rows()` starts the requests, once per loader run), so on HTTP/1.1 they do not compete
    // with the page's own critical requests (docs/API.md v1.7).
    rows: () =>
      (rows ??= {
        genres: soft(catalogApi.genres()),
        latest: soft(catalogApi.latest({ limit: 24 })),
        trending: soft(catalogApi.trending(undefined, 12)),
        topAnime: soft(catalogApi.topRated("anime", 12)),
        topManga: soft(catalogApi.topRated("manga", 12)),
      }),
  };
}
