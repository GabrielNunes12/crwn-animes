import { catalogApi } from "../../api/client.js";

// Defined statically in router.jsx: the request starts with the lazy page download.
export function loader({ request, section }) {
  const url = new URL(request.url);
  const genre = url.searchParams.get("genre") ?? "";
  const q = url.searchParams.get("q") ?? "";
  return {
    section,
    genre,
    q,
    series: catalogApi.seriesList(section, { genre, q }, { signal: request.signal }),
    genres: catalogApi.genres().catch(() => []),
  };
}
