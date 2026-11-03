// Page title + description copy shared with the server's first render
// (server/src/seo.js). In pt-BR the strings must stay identical.
import { truncateWords } from "./format.js";

/** [title, description] for an episode / chapter page; the title gets " · Crwn Animes" from useTitle. */
export function watchMeta(t, video, series) {
  const name = series?.name ?? video.seriesName ?? "";
  const manga = video.section === "manga";
  const n = video.number == null ? "" : String(video.number);
  const season = video.season > 1 && !manga ? String(video.season) : null;
  let where;
  if (season) where = t("meta.video.seasonEpisode", { season, n });
  else if (manga) where = n ? t("common.chapter", { n }) : t("common.chapterUnknown");
  else where = n ? t("common.episode", { n }) : t("common.episodeUnknown");
  const lead = t(manga ? "meta.video.lead.manga" : season ? "meta.video.lead.animeSeason" : "meta.video.lead.anime", { n, season, series: name });
  const synopsis = series?.synopsis?.trim();
  return [t("meta.video.title", { series: name, where }), truncateWords(synopsis ? `${lead} ${synopsis}` : lead)];
}
