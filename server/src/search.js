// Accent- and case-insensitive series search (docs/API.md v1.2).
//
// series.search_text holds every name of a series (name first, then aliases),
// each run through searchNormalize() and wrapped in "|":
//   Pokémon + ["Pocket Monsters", "ポケモン"] -> "|pokemon|pocket monsters|ホケモン|"
// searchNormalize() strips accents (any combining mark) and case, folds
// compatibility forms (full-width letters) and keeps letters and digits of
// every script, so Japanese/Korean/... names stay findable. Everything else
// becomes a single space, so "|" can never appear inside a name and a query
// never matches across two names. Queries go through the same function. The
// SQL uses instr(), which takes the needle literally (no LIKE wildcards).

/** Lower-case, accent-free, letters/digits of any script separated by single spaces. */
export function searchNormalize(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The search_text value for a series. */
export function searchText(name, aliases = []) {
  const list = Array.isArray(aliases) ? aliases : [];
  const names = [name, ...list.filter((a) => typeof a === "string")].map(searchNormalize).filter(Boolean);
  return `|${names.join("|")}|`;
}

/**
 * What a ?q= asks for:
 *   null        no text filter (q absent or blank)
 *   ""          q has text but nothing searchable (only punctuation/emoji): matches nothing
 *   "pokemon"   the needle
 */
export function searchNeedle(q) {
  if (q == null || String(q).trim() === "") return null;
  return searchNormalize(q);
}

// SQL snippets shared by the search and section-list queries. They expect
// `s` (series) and a bound @needle (null = no text filter; "" never reaches SQL).
export const NEEDLE_MATCH = "(@needle IS NULL OR instr(s.search_text, @needle) > 0)";

// 0 exact name, 1 exact alias, 2 a name starts with it, 3 a word starts with it, 4 anywhere.
export const NEEDLE_RANK = `CASE
    WHEN @needle IS NULL THEN 0
    WHEN substr(s.search_text, 1, length(@needle) + 2) = '|' || @needle || '|' THEN 0
    WHEN instr(s.search_text, '|' || @needle || '|') > 0 THEN 1
    WHEN instr(s.search_text, '|' || @needle) > 0 THEN 2
    WHEN instr(s.search_text, ' ' || @needle) > 0 THEN 3
    ELSE 4 END`;
