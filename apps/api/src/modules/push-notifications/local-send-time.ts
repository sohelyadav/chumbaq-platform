/**
 * Working out when "09:00 in the recipient's own timezone" actually is.
 *
 * Node ships full IANA data via Intl, so no dependency is needed — but the
 * arithmetic has to be done carefully, because a zone's offset is a function
 * of the instant, and the instant is what we are trying to find.
 */

/** Fallback for a device whose timezone we never learned. */
export const DEFAULT_TIMEZONE = 'UTC';

/** `HH:MM`, 24-hour. */
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidLocalTime(value: string): boolean {
  return LOCAL_TIME_PATTERN.test(value);
}

/** True when Intl recognises the zone, so a bad value never reaches a send. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * How far `timezone` is from UTC at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in that zone and reading the wall clock
 * back, which is the only way to get a zone's offset — including its DST
 * state — without shipping a timezone library.
 */
function offsetMsAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // `hour` comes back as 24 at midnight under hour12: false in some Node
  // versions; %24 normalises it to 0 so the date does not jump a day.
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant at which the wall clock in `timezone` reads `localTime` on
 * `localDate`.
 *
 * Solved in two passes. The first guess treats the wall clock as if it were
 * UTC and subtracts the zone's offset; but that offset was measured at the
 * wrong instant, so near a DST transition it can be off by an hour. Measuring
 * again at the corrected instant and re-applying converges — one correction is
 * always enough, because offsets change by at most a couple of hours and never
 * twice within that window.
 */
export function zonedTimeToUtc(
  localDate: { year: number; month: number; day: number },
  localTime: string,
  timezone: string,
): Date {
  const [hours, minutes] = localTime.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day,
    hours,
    minutes,
    0,
  );

  const firstGuess = new Date(wallClockAsUtc - offsetMsAt(new Date(wallClockAsUtc), timezone));
  return new Date(wallClockAsUtc - offsetMsAt(firstGuess, timezone));
}

/** The calendar date currently showing on `timezone`'s wall clock. */
export function localDateIn(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: read('year'), month: read('month'), day: read('day') };
}

/**
 * The next instant at which `timezone` reads `localTime`, at or after `from`.
 *
 * If today's slot has already passed in that zone, it rolls to tomorrow —
 * scheduling "09:00 local" at 10am must not fire immediately for everyone
 * already past nine.
 */
export function nextLocalOccurrence(
  localTime: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  const today = localDateIn(from, timezone);
  const todaysSlot = zonedTimeToUtc(today, localTime, timezone);
  if (todaysSlot.getTime() > from.getTime()) return todaysSlot;

  // Step a day forward in that zone's own calendar rather than adding 24h to
  // the UTC instant, which would skip or repeat a day across a DST change.
  const tomorrow = localDateIn(
    new Date(todaysSlot.getTime() + 36 * 60 * 60 * 1000),
    timezone,
  );
  return zonedTimeToUtc(tomorrow, localTime, timezone);
}

/**
 * Shifts an instant out of a project's quiet window, in the recipient's zone.
 *
 * Quiet hours are expressed on the recipient's own clock, so this is only
 * meaningful once a campaign has been split per timezone — which is exactly
 * what per-timezone expansion produces.
 *
 * A window may wrap midnight (22:00–08:00), which is the common case and the
 * one a naive `start <= t < end` comparison gets wrong.
 */
export function shiftOutOfQuietHours(
  instant: Date,
  timezone: string,
  quietStart: string | null,
  quietEnd: string | null,
): Date {
  if (!quietStart || !quietEnd) return instant;
  if (!isValidLocalTime(quietStart) || !isValidLocalTime(quietEnd)) return instant;
  if (quietStart === quietEnd) return instant;

  const minutesOf = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };

  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
  const nowMinutes = minutesOf(local);
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);

  const inQuiet =
    start < end
      ? nowMinutes >= start && nowMinutes < end
      : // Wraps midnight: quiet if after the start OR before the end.
        nowMinutes >= start || nowMinutes < end;

  if (!inQuiet) return instant;

  // Move to the end of the window. `nextLocalOccurrence` already rolls to
  // tomorrow when today's slot has passed, which is what a late-night instant
  // needs.
  return nextLocalOccurrence(quietEnd, timezone, instant);
}
