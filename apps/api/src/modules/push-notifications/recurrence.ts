import { localDateIn, zonedTimeToUtc, DEFAULT_TIMEZONE, isValidTimezone } from './local-send-time';

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export interface PushRecurrence {
  frequency: RecurrenceFrequency;
  /** Every N periods. 1 = every day / week / month. */
  interval: number;
  /** `HH:MM` the occurrence should fire at. */
  atTime: string;
  /** 0 = Sunday. Weekly only; empty means the same weekday each time. */
  daysOfWeek?: number[];
  /** Timezone the schedule is expressed in. Defaults to UTC. */
  timezone?: string;
  /** Stop after this instant. Null means it runs until cancelled. */
  endsAt?: string | null;
}

/**
 * The next occurrence strictly after `from`.
 *
 * Computed on the schedule's own calendar rather than by adding milliseconds,
 * so a daily 09:00 stays at 09:00 across a DST change instead of drifting to
 * 08:00 or 10:00 for half the year.
 */
export function nextOccurrence(
  recurrence: PushRecurrence,
  from: Date,
): Date | null {
  const timezone = recurrence.timezone || DEFAULT_TIMEZONE;
  const interval = Math.max(1, Math.floor(recurrence.interval || 1));
  const endsAt = recurrence.endsAt ? new Date(recurrence.endsAt) : null;

  const candidate = findNext(recurrence, from, timezone, interval);
  if (endsAt && candidate.getTime() > endsAt.getTime()) return null;
  return candidate;
}

/** About eight years of a daily schedule, so walking one stays cheap. */
const MAX_STEPS_TO_CATCH_UP = 3000;

/**
 * The first occurrence after `now`, stepping along from `from` to stay in phase with an
 * every-N schedule. A schedule further behind than the limit jumps straight there
 * instead: its start date is the tenant's to set, and this runs inside a scheduler tick.
 */
export function nextOccurrenceAfterNow(
  recurrence: PushRecurrence,
  from: Date,
  now: Date,
): Date | null {
  let next = nextOccurrence(recurrence, from);
  for (let steps = 0; next !== null && next.getTime() <= now.getTime(); steps += 1) {
    if (steps >= MAX_STEPS_TO_CATCH_UP) return nextOccurrence(recurrence, now);
    next = nextOccurrence(recurrence, next);
  }
  return next;
}

function findNext(
  recurrence: PushRecurrence,
  from: Date,
  timezone: string,
  interval: number,
): Date {
  const start = localDateIn(from, timezone);

  if (recurrence.frequency === 'weekly' && recurrence.daysOfWeek?.length) {
    // Scan forward a day at a time. Bounded by a fortnight, which always
    // contains the next matching weekday even at interval 1.
    const wanted = new Set(recurrence.daysOfWeek);
    for (let offset = 0; offset <= 14; offset++) {
      const date = addDays(start, offset);
      const at = zonedTimeToUtc(date, recurrence.atTime, timezone);
      if (at.getTime() <= from.getTime()) continue;
      const weekday = new Date(
        Date.UTC(date.year, date.month - 1, date.day),
      ).getUTCDay();
      if (wanted.has(weekday)) return at;
    }
  }

  // Today's slot if it is still ahead, otherwise step by the interval.
  const todaysSlot = zonedTimeToUtc(start, recurrence.atTime, timezone);
  if (todaysSlot.getTime() > from.getTime()) return todaysSlot;

  const step = (periods: number) =>
    recurrence.frequency === 'daily'
      ? addDays(start, interval * periods)
      : recurrence.frequency === 'weekly'
        ? addDays(start, 7 * interval * periods)
        : addMonths(start, interval * periods);

  // A slot just after midnight on a day whose midnight a clock change skips can land
  // back before `from`, and a caller stepping along would then never move again.
  const stepped = zonedTimeToUtc(step(1), recurrence.atTime, timezone);
  return stepped.getTime() > from.getTime()
    ? stepped
    : zonedTimeToUtc(step(2), recurrence.atTime, timezone);
}

function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Adds months, clamping to the end of a shorter month.
 *
 * The 31st plus one month has no 31st in November, and JavaScript's Date would
 * roll it into December — turning a monthly campaign into one that skips a
 * month and then fires on the wrong day forever after.
 */
function addMonths(
  date: { year: number; month: number; day: number },
  months: number,
): { year: number; month: number; day: number } {
  const totalMonths = date.month - 1 + months;
  const year = date.year + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12 + 12) % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { year, month: month + 1, day: Math.min(date.day, daysInMonth) };
}

/** Validates a recurrence definition. Returns a message, or null when valid. */
export function validateRecurrence(recurrence: PushRecurrence): string | null {
  if (!RECURRENCE_FREQUENCIES.includes(recurrence.frequency)) {
    return `Frequency must be one of ${RECURRENCE_FREQUENCIES.join(', ')}.`;
  }
  if (
    !Number.isInteger(recurrence.interval) ||
    recurrence.interval < 1 ||
    recurrence.interval > 52
  ) {
    return 'Interval must be a whole number between 1 and 52.';
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(recurrence.atTime ?? '')) {
    return 'Time must be HH:MM in 24-hour form.';
  }
  if (recurrence.daysOfWeek?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return 'Days of week must be integers from 0 (Sunday) to 6.';
  }
  if (recurrence.frequency !== 'weekly' && recurrence.daysOfWeek?.length) {
    return 'Days of week only apply to a weekly schedule.';
  }
  if (recurrence.timezone && !isValidTimezone(recurrence.timezone)) {
    return 'Timezone is not recognised.';
  }
  if (recurrence.endsAt && Number.isNaN(Date.parse(recurrence.endsAt))) {
    return 'End date must be a valid date.';
  }
  return null;
}
