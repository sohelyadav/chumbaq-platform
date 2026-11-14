/**
 * The most rows a list route returns at once. Rows can carry large caller-written jsonb
 * (event properties, traits), and a list is buffered and serialised in the shared API
 * process, so one member asking for `limit=10000000` must not load a whole table.
 */
export const MAX_LIST_LIMIT = 200;

/** A raw `limit` query value as a whole number in 1..max, or the fallback. */
export function queryLimit(raw: string | undefined, fallback: number, max = MAX_LIST_LIMIT): number {
  const parsed = raw === undefined ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return Math.min(fallback, max);
  return Math.min(parsed, max);
}
