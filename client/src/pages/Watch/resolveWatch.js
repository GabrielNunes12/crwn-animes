import { ApiError, catalogApi } from "../../api/client.js";

/** Resolves the URL (slug + season + number) to a video, then loads prev/next. */
export async function resolveWatch({ section, slug, season, number, signal }) {
  const { series, videos } = await catalogApi.series(section, slug, { signal });
  const n = Number(number);
  const s = section === "anime" ? Number(season ?? 1) : null;
  const match = videos.find((v) => v.number === n && (s == null || (v.season ?? 1) === s));
  if (!match) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Episode not found" });
  const detail = await catalogApi.video(match.id, { signal });
  return { ...detail, series: detail.series ?? series, videos };
}
