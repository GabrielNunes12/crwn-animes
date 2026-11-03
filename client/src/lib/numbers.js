/** "" → undefined, "3" → 3 */
export function numOrUndef(v) {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
