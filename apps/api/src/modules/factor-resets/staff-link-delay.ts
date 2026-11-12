const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_STAFF_LINK_DELAY_HOURS = 24;
const MIN_STAFF_LINK_DELAY_HOURS = 1;

/**
 * How long a link from `admin:password-reset-link` stays usable once its wait is over.
 * Longer than an emailed link's 30 minutes, because the operator hands it over by hand
 * and the person may not be at a keyboard the moment the wait ends.
 */
export const STAFF_LINK_USABLE_FOR_MS = 24 * HOUR_MS;

/**
 * `STAFF_LINK_DELAY_HOURS`: how long a staff-issued reset link waits before it works,
 * which is the real owner's time to see the notice and sign in, voiding it. Read by the
 * CLI from its own environment. Anything below an hour, or not a number, is refused
 * rather than read as a shorter wait, since a typo read as zero is an instant handover.
 */
export function staffLinkDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STAFF_LINK_DELAY_HOURS * HOUR_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < MIN_STAFF_LINK_DELAY_HOURS) {
    throw new Error(
      `STAFF_LINK_DELAY_HOURS must be a number of hours, at least ${MIN_STAFF_LINK_DELAY_HOURS}, not "${raw}"`,
    );
  }
  return Math.round(hours * HOUR_MS);
}
