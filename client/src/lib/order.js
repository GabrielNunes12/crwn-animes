// Episode ordering on the admin series board. Pure helpers (ids are video ids).

export function sameOrder(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** A copy of `ids` with `id` moved to `index` (clamped). Unknown ids leave it unchanged. */
export function moveTo(ids, id, index) {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  const to = Math.max(0, Math.min(index, ids.length - 1));
  if (to === from) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * A local (unsaved) order checked against what the server has now: ids that left are
 * dropped, new ones are added at the end in server order. Without a draft → the server order.
 */
export function reconcileOrder(draft, server) {
  if (!draft) return server;
  const live = new Set(server);
  const kept = draft.filter((id) => live.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...server.filter((id) => !keptSet.has(id))];
}

/** Whole days left until `date` (rounded up, never negative). */
export function daysUntil(date, now = Date.now()) {
  const ms = new Date(date).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
