// Genres are free text typed by admins ("Ação", "AÇÃO", "ação "). They are
// compared in JS only (SQLite's lower() is ASCII-only), with one key
// function, and stored in one canonical spelling: the first one the catalog
// used. Comparisons in SQL are then exact string matches on that spelling.

/** Unicode-composed, trimmed, single-spaced. */
export const cleanGenre = (genre) => String(genre).normalize("NFC").trim().replace(/\s+/g, " ");

/** Case-insensitive identity of a genre. */
export const genreKey = (genre) => cleanGenre(genre).toLocaleLowerCase("pt-BR");

/**
 * Map genreKey -> first spelling seen, from series rows in id order
 * (`rows` = [{ genres: string[] }]).
 */
export function genreSpellings(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const genre of row.genres ?? []) {
      if (typeof genre !== "string" || cleanGenre(genre) === "") continue;
      const key = genreKey(genre);
      if (!map.has(key)) map.set(key, cleanGenre(genre));
    }
  }
  return map;
}

/** `genres` in their canonical spellings (from `spellings`), de-duplicated, order kept. */
export function canonicalGenres(genres, spellings) {
  const out = [];
  const seen = new Set();
  for (const genre of Array.isArray(genres) ? genres : []) {
    if (typeof genre !== "string" || cleanGenre(genre) === "") continue;
    const key = genreKey(genre);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spellings.get(key) ?? cleanGenre(genre));
  }
  return out;
}

/** Sorted list of canonical spellings. */
export const sortGenres = (genres) => [...genres].sort((a, b) => a.localeCompare(b, "pt-BR"));
