import { normalize } from "./classifier.js";

// Accent- and case-insensitive series search (docs/API.md v1.2).
//
// series.search_text holds every name of a series (name first, then aliases),
// each run through normalize() and wrapped in "|":
//   Pokémon + ["Pocket Monsters"] -> "|pokemon|pocket monsters|"
// normalize() only leaves [a-z0-9 ], so "|" can never appear inside a name and
// a query can never match across two names. Queries go through the same
// normalize(), so "POKÉMON!" -> "pokemon". The SQL uses instr(), which takes
// the needle literally (no LIKE wildcards to escape).

/** The search_text value for a series. */
export function searchText(name, aliases = []) {
  const names = [name, ...(aliases ?? [])].map((n) => normalize(n).trim()).filter(Boolean);
  return `|${names.join("|")}|`;
}

/** Normalised query text, or null when nothing searchable is left. */
export function searchNeedle(q) {
  if (q == null) return null;
  const needle = normalize(q).trim();
  return needle === "" ? null : needle;
}

// SQL snippets shared by the search and section-list queries. They expect
// `s` (series) and a bound @needle (null = no text filter).
export const NEEDLE_MATCH = "(@needle IS NULL OR instr(s.search_text, @needle) > 0)";

// 0 exact name, 1 exact alias, 2 a name starts with it, 3 a word starts with it, 4 anywhere.
export const NEEDLE_RANK = `CASE
    WHEN @needle IS NULL THEN 0
    WHEN substr(s.search_text, 1, length(@needle) + 2) = '|' || @needle || '|' THEN 0
    WHEN instr(s.search_text, '|' || @needle || '|') > 0 THEN 1
    WHEN instr(s.search_text, '|' || @needle) > 0 THEN 2
    WHEN instr(s.search_text, ' ' || @needle) > 0 THEN 3
    ELSE 4 END`;
