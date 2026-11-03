/** "Episode 5", "Season 2 · Episode 5", "Chapter 1100" (translated). */
export function videoLabel(t, video) {
  if (!video) return "";
  const n = video.number;
  if (video.section === "manga") return n == null ? t("common.chapterUnknown") : t("common.chapter", { n });
  const ep = n == null ? t("common.episodeUnknown") : t("common.episode", { n });
  return video.season > 1 ? `${t("common.season", { n: video.season })} · ${ep}` : ep;
}

export function sectionLabel(t, section) {
  return section === "manga" ? t("common.manga") : t("common.anime");
}

export function seriesRoute(section, slug) {
  return `/${section}/${slug}`;
}
