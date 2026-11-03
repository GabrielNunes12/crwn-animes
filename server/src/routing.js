// The front-end path a published video lives at. The server sends this with
// every video so the React app never has to work out routes itself.
//   anime, season 1: /anime/one-piece/episode/5
//   anime, season 2: /anime/one-piece/season/2/episode/5
//   manga:           /manga/one-piece/chapter/1100
export function videoRoute({ section, seriesSlug, season, number }) {
  if (!section || !seriesSlug || number == null) return null;
  if (section === "manga") return `/manga/${seriesSlug}/chapter/${number}`;
  const seasonPart = season > 1 ? `/season/${season}` : "";
  return `/anime/${seriesSlug}${seasonPart}/episode/${number}`;
}

export function seriesRoute(section, seriesSlug) {
  return `/${section}/${seriesSlug}`;
}

export function slugify(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
