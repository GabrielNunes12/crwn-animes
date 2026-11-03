// Season selection for series pages (?season=). Pure helpers.

/** The API's `seasons`, or (older server) the distinct seasons of `videos`. */
export function seasonsOf(seasons, videos) {
  if (Array.isArray(seasons) && seasons.length) return [...seasons].sort((a, b) => a - b);
  return [...new Set((videos ?? []).map((v) => v.season ?? 1))].sort((a, b) => a - b);
}

/** `?season=` when it names a real season; else the Continue target's season; else the first. */
export function pickSeason(seasons, param, target) {
  const n = Number(param);
  if (param != null && param !== "" && seasons.includes(n)) return n;
  if (target && seasons.includes(target.season ?? 1)) return target.season ?? 1;
  return seasons[0] ?? 1;
}
