// Works out where a YouTube video belongs on Crwn Animes: which section
// (anime or manga), which series, which season and which episode/chapter.
// Everything here is pure (no database, no network) so it is easy to test.

export const SECTIONS = ["anime", "manga"];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Accepts a bare 11-char ID or any common YouTube URL; returns the ID or null. */
export function parseYouTubeId(input) {
  if (!input) return null;
  const value = String(input).trim();
  if (YOUTUBE_ID.test(value)) return value;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/]+)/)?.[1];
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/**
 * Lower-cases, strips accents and punctuation, and pads with spaces so that
 * `text.includes(" word ")` is a whole-word match.
 * "Episódio 5 — Dublado!" -> " episodio 5 dublado "
 */
export function normalize(text) {
  const clean = String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${clean} `;
}

// [pattern, weight, reason]. Patterns run against normalize()d text.
// Strong words ("anime", "manga") weigh 3, a numbered episode/chapter weighs 2,
// hints weigh 1. "capitulo"/"cap" only weighs 1 because Spanish uses it for
// anime episodes too.
const SECTION_SIGNALS = {
  manga: [
    [/ (manga|manhwa|manhua|webtoon) /, 3, 'title says "manga"'],
    [/ motion (comic|manga) /, 3, 'title says "motion comic"'],
    [/ (chapter|chap|ch) ?\d+/, 2, "title has a chapter number"],
    [/ (capitulo|cap) ?\d+/, 1, 'title has "capítulo" + number'],
  ],
  anime: [
    [/ anime /, 3, 'title says "anime"'],
    [/ (episode|episodio|ep) ?\d+/, 2, "title has an episode number"],
    [/ (season|temporada) \d+ | \d+(st|nd|rd|th)? (season|temporada) /, 1, "title has a season"],
    [/ s\d{1,2} ?e\d{1,4} /, 2, "title has an SxxEyy code"],
    [/ (dub|dubbed|dublado|sub|subbed|legendado) /, 1, "title says dubbed/subbed"],
  ],
};

// The winner needs this score, and this lead over the other section, to count.
const MIN_SECTION_SCORE = 2;
const MIN_SECTION_LEAD = 2;

export function detectSection(normalizedTitle) {
  const scores = { anime: 0, manga: 0 };
  const reasons = [];
  for (const section of SECTIONS) {
    for (const [pattern, weight, reason] of SECTION_SIGNALS[section]) {
      if (pattern.test(normalizedTitle)) {
        scores[section] += weight;
        reasons.push(`${section} +${weight}: ${reason}`);
      }
    }
  }
  const [first, second] = [...SECTIONS].sort((a, b) => scores[b] - scores[a]);
  const confident =
    scores[first] >= MIN_SECTION_SCORE &&
    scores[first] - scores[second] >= MIN_SECTION_LEAD;
  return { section: confident ? first : null, scores, reasons };
}

/**
 * Finds the catalog series named in the title. The longest matching name or
 * alias wins, so "Naruto Shippuden" beats "Naruto". Equal-length matches for
 * two different series are ambiguous and return null.
 */
export function matchSeries(normalizedTitle, seriesList) {
  let best = null;
  let ambiguous = false;
  for (const series of seriesList) {
    for (const name of [series.name, ...(series.aliases ?? [])]) {
      const needle = normalize(name);
      if (needle.trim() === "" || !normalizedTitle.includes(needle)) continue;
      if (!best || needle.length > best.needle.length) {
        best = { series, needle };
        ambiguous = false;
      } else if (needle.length === best.needle.length && best.series.slug !== series.slug) {
        ambiguous = true;
      }
    }
  }
  return best && !ambiguous ? best : null;
}

const SEASON_PATTERNS = [
  / s(\d{1,2}) ?e\d{1,4} /,
  / (?:season|temporada) (\d{1,2}) /,
  / (\d{1,2})(?:st|nd|rd|th)? (?:season|temporada) /,
];

const NUMBER_PATTERNS = {
  // Spanish titles call anime episodes "Capítulo" too, so it is a last resort here.
  anime: [/ s\d{1,2} ?e(\d{1,4}) /, / (?:episode|episodio|ep) ?(\d{1,4}) /, / (?:capitulo|cap) ?(\d{1,4}) /],
  manga: [/ (?:chapter|chap|ch|capitulo|cap) ?(\d{1,4}) /],
};

const toInt = (value) => (value == null ? null : Number.parseInt(value, 10));

export function extractSeason(normalizedTitle) {
  for (const pattern of SEASON_PATTERNS) {
    const match = normalizedTitle.match(pattern);
    if (match) return toInt(match[1]);
  }
  return null;
}

/**
 * Returns { number, guessed }. A number next to a marker ("episode 5",
 * "chapter 12", "#12") is trusted. A lone number with no marker is only a
 * guess: titles like "Top 10 fights" would otherwise become episode 10.
 */
export function extractNumber(rawTitle, normalizedRemainder, section) {
  const patterns = section ? NUMBER_PATTERNS[section] : [...NUMBER_PATTERNS.anime, ...NUMBER_PATTERNS.manga];
  for (const pattern of patterns) {
    const match = normalizedRemainder.match(pattern);
    if (match) return { number: toInt(match[1]), guessed: false };
  }
  const hash = String(rawTitle).match(/#\s?(\d{1,4})\b/);
  if (hash) return { number: toInt(hash[1]), guessed: false };

  const withoutSeason = SEASON_PATTERNS.reduce((text, p) => text.replace(p, " "), normalizedRemainder);
  const loneNumbers = withoutSeason
    .trim()
    .split(" ")
    .filter((token) => /^\d{1,4}$/.test(token))
    .map(Number)
    .filter((n) => n > 0 && !(n >= 1950 && n <= 2099)); // skip years
  if (loneNumbers.length === 1) return { number: loneNumbers[0], guessed: true };
  return { number: null, guessed: false };
}

/**
 * Classifies one video.
 *
 * @param info      { title } as read from YouTube
 * @param seriesList catalog series: [{ id, slug, name, aliases }]
 * @param overrides  values an admin set by hand: { section, seriesSlug, season, number }.
 *                   They always win over what the title says.
 * @returns { section, seriesId, seriesSlug, season, number, status, classification }
 *          status is "published" only when section, series and number are all known
 *          for sure; anything else is "pending" and waits for an admin.
 */
export function classify(info, seriesList, overrides = {}) {
  const text = normalize(info.title);
  const reasons = [];

  // 1. Section
  const detected = detectSection(text);
  let section = detected.section;
  reasons.push(...detected.reasons);
  if (overrides.section) {
    section = overrides.section;
    reasons.push(`section set by admin: ${section}`);
  } else if (!section) {
    reasons.push("could not tell whether this is anime or manga");
  }

  // 2. Series (and strip its name so numbers inside it, like "Kaiju No. 8", are ignored)
  let series = null;
  let remainder = text;
  if (overrides.seriesSlug) {
    series = seriesList.find((s) => s.slug === overrides.seriesSlug) ?? null;
    reasons.push(series ? `series set by admin: ${series.name}` : `admin picked unknown series "${overrides.seriesSlug}"`);
  } else {
    const match = matchSeries(text, seriesList);
    if (match) {
      series = match.series;
      reasons.push(`title names the series "${series.name}"`);
    } else {
      reasons.push("no series from the catalog is named in the title");
    }
  }
  if (series) {
    for (const name of [series.name, ...(series.aliases ?? [])]) {
      const needle = normalize(name);
      if (needle.trim()) remainder = remainder.split(needle).join(" ");
    }
  }

  // 3. Season. Manga chapters have no seasons (/manga/:slug/chapter/:n), so
  // they are always season 1, even if an admin set another one.
  let season;
  if (section === "manga") {
    season = 1;
    if (overrides.season != null && overrides.season !== 1) reasons.push("manga chapters have no seasons: season override ignored");
  } else {
    season = overrides.season ?? extractSeason(remainder) ?? 1;
  }

  // 4. Episode / chapter number
  let number = null;
  let suggestedNumber = null;
  if (overrides.number != null) {
    number = overrides.number;
    reasons.push(`number set by admin: ${number}`);
  } else {
    const extracted = extractNumber(info.title, remainder, section);
    if (extracted.number != null && !extracted.guessed) {
      number = extracted.number;
      reasons.push(`found ${section === "manga" ? "chapter" : "episode"} number ${number}`);
    } else if (extracted.guessed) {
      suggestedNumber = extracted.number;
      reasons.push(`found a bare number (${suggestedNumber}) but no "episode"/"chapter" marker`);
    } else {
      reasons.push("no episode or chapter number in the title");
    }
  }

  const complete = Boolean(section && series && number != null);
  return {
    section,
    seriesId: series?.id ?? null,
    seriesSlug: series?.slug ?? null,
    season,
    number,
    status: complete ? "published" : "pending",
    classification: { scores: detected.scores, reasons, suggestedNumber },
  };
}
