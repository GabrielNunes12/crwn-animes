// Shared by the /search page, the /genre page and the ⌘K palette (docs/API.md v1.2).

export const SEARCH_SECTIONS = ["anime", "manga"];
export const SEARCH_SORTS = ["relevance", "top", "new", "az"];
export const MAX_Q = 80;
export const DEBOUNCE_MS = 250;

/** URL search params → normalised search state. `sort` falls back to the server default. */
export function readSearchParams(sp) {
  const q = (sp.get("q") ?? "").trim().slice(0, MAX_Q);
  const rawSection = sp.get("section") ?? "";
  const section = SEARCH_SECTIONS.includes(rawSection) ? rawSection : "";
  const genre = (sp.get("genre") ?? "").trim();
  const rawSort = sp.get("sort") ?? "";
  const sort = SEARCH_SORTS.includes(rawSort) && !(rawSort === "relevance" && !q) ? rawSort : q ? "relevance" : "az";
  return { q, section, genre, sort };
}

/** /search URL for a query (used by the palette's "See all results" option). */
export function searchHref(q) {
  const s = new URLSearchParams(q ? { q } : {}).toString();
  return s ? `/search?${s}` : "/search";
}

/** Genre page URL. */
export function genreHref(genre) {
  return `/genre/${encodeURIComponent(genre)}`;
}
