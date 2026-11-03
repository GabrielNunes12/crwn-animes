/** "Episode 5", "Season 2 · Episode 5", "Chapter 1100" (translated). */
// Episode/chapter/season numbers are identifiers, not quantities: never group
// them ("Episódio 1100", not "Episódio 1.100"), so they are passed as strings.
export function videoLabel(t, video) {
  if (!video) return "";
  const n = video.number == null ? null : String(video.number);
  if (video.section === "manga") return n == null ? t("common.chapterUnknown") : t("common.chapter", { n });
  const ep = n == null ? t("common.episodeUnknown") : t("common.episode", { n });
  return video.season > 1 ? `${t("common.season", { n: String(video.season) })} · ${ep}` : ep;
}

export function sectionLabel(t, section) {
  return section === "manga" ? t("common.manga") : t("common.anime");
}

export function seriesRoute(section, slug) {
  return `/${section}/${slug}`;
}

/**
 * Meta-description copy: whitespace collapsed, cut to `max` characters on a word
 * boundary with a trailing "…" (the server truncates synopses the same way).
 */
export function truncateWords(text, max = 160) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...s]; // count code points, like the server
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  const head = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?—–-]+$/u, "");
  return `${head}…`;
}
