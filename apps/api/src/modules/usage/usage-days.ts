/**
 * UTC days as `YYYY-MM-DD` strings. Usage is counted per UTC day whatever the
 * server's or the database session's time zone, and a day travels as a string
 * so no `Date` at local midnight can move it.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 3600 * 1000;

/** UTC midnight at the start of `day`. Throws on anything but a real `YYYY-MM-DD`. */
export function dayStart(day: string): Date {
  const m = DAY.exec(day);
  if (!m) throw new Error(`Not a day: ${day}`);
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (utcDay(start) !== day) throw new Error(`Not a day: ${day}`);
  return start;
}

/** The UTC day an instant falls on. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return utcDay(new Date(dayStart(day).getTime() + n * DAY_MS));
}

/** The first day of the UTC month `day` is in, `YYYY-MM-01`. */
export function monthStart(day: string): string {
  dayStart(day);
  return `${day.slice(0, 7)}-01`;
}

/** The first day of the month `n` months from the month `day` is in. */
export function addMonths(day: string, n: number): string {
  const start = dayStart(monthStart(day));
  return utcDay(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, 1)));
}

/** The last day of the UTC month `day` is in. */
export function monthEnd(day: string): string {
  return addDays(addMonths(day, 1), -1);
}
