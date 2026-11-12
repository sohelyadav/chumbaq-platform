const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_FACTOR_RESET_DELAY_HOURS = 72;

/**
 * `FACTOR_RESET_DELAY_HOURS`, the time the real owner has to notice and cancel. A value
 * that is not a positive number stops the app rather than falling back, because a typo
 * read as zero would hand the account over at once.
 */
export function factorResetDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_FACTOR_RESET_DELAY_HOURS * HOUR_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`FACTOR_RESET_DELAY_HOURS must be a positive number of hours, not "${raw}"`);
  }
  return Math.round(hours * HOUR_MS);
}
