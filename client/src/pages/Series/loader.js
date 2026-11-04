import { catalogApi } from "../../api/client.js";

// Defined statically in router.jsx: the request starts with the lazy page download.
export function loader({ params, request, section }) {
  // Every season at once: "watched N of M" and the Continue target span the whole
  // series, and switching seasons (?season=) then needs no request.
  return { section, data: catalogApi.series(section, params.slug, { signal: request.signal }) };
}

/** Changing only `?season=` filters what is already loaded — don't refetch. */
export function shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }) {
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const strip = (url) => {
    const p = new URLSearchParams(url.search);
    p.delete("season");
    return p.toString();
  };
  return strip(currentUrl) === strip(nextUrl) ? false : defaultShouldRevalidate;
}
