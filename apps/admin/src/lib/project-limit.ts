/** The API's `PROJECT_LIMIT_MAX` (admin-tenants.dto.ts). */
export const PROJECT_LIMIT_MAX = 1000;

/** "3 of 10 projects". */
export function projectCountLabel(count: number, limit: number): string {
  return `${count} of ${limit} project${limit === 1 ? '' : 's'}`;
}

/** Whether the account may create another; one already over its limit may not. */
export function canCreateProject(count: number, limit: number | undefined): boolean {
  return limit === undefined || count < limit;
}

export type ProjectLimitInput = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * What staff typed in the limit field. Blank means the default (null), so clearing
 * the field is how an override is removed. Anything else must be a whole number the
 * API accepts, so "1e3" or "10.5" are refused here rather than read as something else.
 */
export function parseProjectLimitInput(text: string): ProjectLimitInput {
  const value = text.trim();
  if (value === '') return { ok: true, value: null };
  if (!/^\d+$/.test(value)) return { ok: false, error: 'Enter a whole number, or leave it blank for the default.' };
  const limit = Number(value);
  if (limit > PROJECT_LIMIT_MAX) return { ok: false, error: `The most is ${PROJECT_LIMIT_MAX}.` };
  return { ok: true, value: limit };
}

/** "2 of 5 used", or "2 used, no limit". */
export function seatCountLabel(used: number, limit: number | null): string {
  return limit === null ? `${used} used, no limit` : `${used} of ${limit} used`;
}
