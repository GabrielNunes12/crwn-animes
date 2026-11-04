import { resolveWatch } from "./resolveWatch.js";

// Defined statically in router.jsx: the requests start with the lazy page download.
export function loader({ params, request, section }) {
  return {
    section,
    data: resolveWatch({ section, slug: params.slug, season: params.season, number: params.number, signal: request.signal }),
  };
}
