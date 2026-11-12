import { registerAs } from '@nestjs/config';

/**
 * Projects an account may own unless staff set its own limit. Per-project caps
 * (webhook slots, SNS certificate fetches, per-project memory) only bound an
 * account if its projects are bounded too.
 */
export const DEFAULT_MAX_PROJECTS_PER_ACCOUNT = 10;

/**
 * `MAX_PROJECTS_PER_ACCOUNT`, or the default when unset. A value that is set but
 * not a positive whole number stops the app, rather than quietly meaning no limit.
 */
export function maxProjectsPerAccount(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_MAX_PROJECTS_PER_ACCOUNT;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`MAX_PROJECTS_PER_ACCOUNT must be a whole number of at least 1, not "${raw}"`);
  }
  return Number(value);
}

/**
 * `MAX_SEATS_PER_ACCOUNT`: how many other people an account's projects may hold. Unset
 * means no limit (null). A value that is set but not a positive whole number stops the app.
 */
export function maxSeatsPerAccount(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`MAX_SEATS_PER_ACCOUNT must be a whole number of at least 1, not "${raw}"`);
  }
  return Number(value);
}

export default registerAs('projects', () => ({
  maxPerAccount: maxProjectsPerAccount(process.env.MAX_PROJECTS_PER_ACCOUNT),
  maxSeatsPerAccount: maxSeatsPerAccount(process.env.MAX_SEATS_PER_ACCOUNT),
}));
