import { registerAs } from '@nestjs/config';

/** India's CERT-In directions (April 2022) require ICT logs to be kept for 180 days. */
export const AUTH_EVENT_RETENTION_FLOOR_DAYS = 180;
export const AUTH_EVENT_RETENTION_DEFAULT_DAYS = 365;

/**
 * The project activity log is one of those logs. The `project_activity` trigger holds the
 * same 180 days on its own, so a retention job misconfigured past this check still
 * cannot delete a younger row.
 */
export const ACTIVITY_LOG_RETENTION_FLOOR_DAYS = 180;
export const ACTIVITY_LOG_RETENTION_DEFAULT_DAYS = 365;

/**
 * Reads a retention period in days. Throws below the floor rather than clamping, so a
 * mistyped value stops the worker before it deletes evidence the law says to keep.
 */
function retentionDays(variable: string, raw: string | undefined, floor: number, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${variable} must be a whole number of days, not "${raw}"`);
  }
  const days = Number(value);
  if (days < floor) {
    throw new Error(`${variable} must be at least ${floor} (CERT-In requires 180 days of logs), not ${days}`);
  }
  return days;
}

/** Days of `auth_events` to keep. */
export function authEventRetentionDays(raw: string | undefined): number {
  return retentionDays(
    'AUTH_EVENT_RETENTION_DAYS',
    raw,
    AUTH_EVENT_RETENTION_FLOOR_DAYS,
    AUTH_EVENT_RETENTION_DEFAULT_DAYS,
  );
}

/** Days of `project_activity` to keep. */
export function activityLogRetentionDays(raw: string | undefined): number {
  return retentionDays(
    'ACTIVITY_LOG_RETENTION_DAYS',
    raw,
    ACTIVITY_LOG_RETENTION_FLOOR_DAYS,
    ACTIVITY_LOG_RETENTION_DEFAULT_DAYS,
  );
}

export default registerAs('retention', () => ({
  authEventDays: authEventRetentionDays(process.env.AUTH_EVENT_RETENTION_DAYS),
  activityLogDays: activityLogRetentionDays(process.env.ACTIVITY_LOG_RETENTION_DAYS),
}));
