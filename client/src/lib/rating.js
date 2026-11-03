export const REACTIONS = [
  { key: "fire", emoji: "🔥" },
  { key: "laugh", emoji: "😂" },
  { key: "cry", emoji: "😭" },
  { key: "wow", emoji: "😮" },
  { key: "love", emoji: "❤️" },
];

export function emptySummary() {
  return {
    average: null,
    count: 0,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    reactions: { fire: 0, laugh: 0, cry: 0, wow: 0, love: 0 },
    mine: null,
  };
}

/**
 * Optimistically apply the current user's rating (or removal when `mine` is null)
 * to a RatingSummary. Pure; mirrors what the server will compute.
 */
export function applyMyRating(summary, mine) {
  const base = summary ?? emptySummary();
  const distribution = { ...emptySummary().distribution, ...base.distribution };
  const reactions = { ...emptySummary().reactions, ...base.reactions };
  let count = base.count ?? 0;
  let sum = base.average != null ? base.average * count : 0;

  const old = base.mine;
  if (old) {
    distribution[old.score] = Math.max(0, (distribution[old.score] ?? 0) - 1);
    if (old.reaction) reactions[old.reaction] = Math.max(0, (reactions[old.reaction] ?? 0) - 1);
    count -= 1;
    sum -= old.score;
  }
  if (mine) {
    distribution[mine.score] = (distribution[mine.score] ?? 0) + 1;
    if (mine.reaction) reactions[mine.reaction] = (reactions[mine.reaction] ?? 0) + 1;
    count += 1;
    sum += mine.score;
  }
  const average = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
  return { ...base, distribution, reactions, count, average, mine: mine ? { score: mine.score, reaction: mine.reaction ?? null } : null };
}
