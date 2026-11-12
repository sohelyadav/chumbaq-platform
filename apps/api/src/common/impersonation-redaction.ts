export const HIDDEN_DURING_IMPERSONATION = 'hidden while viewing as tenant';

/**
 * Impersonation is read-only, but a value that authenticates a caller elsewhere
 * (a webhook signing secret, a token inside a webhook URL) would let a viewer
 * act as the tenant somewhere the read-only rule cannot reach. So these are
 * withheld from impersonators, and the tenant's own responses are unchanged.
 *
 * Fields that hold an object have each of their values hidden, which keeps the
 * shape the settings pages read.
 */
export function redactForImpersonator<T extends object>(
  body: T,
  impersonatedBy: string | undefined,
  fields: string[],
): T {
  if (!impersonatedBy) return body;
  return hideFields(body, fields);
}

/** `fields` of a shallow copy of `body` replaced by `HIDDEN_DURING_IMPERSONATION`. */
export function hideFields<T extends object>(body: T, fields: string[]): T {
  const copy = { ...body } as Record<string, unknown>;
  for (const field of fields) {
    const value = copy[field];
    if (value === undefined || value === null) continue;
    copy[field] =
      typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as object).map((key) => [key, HIDDEN_DURING_IMPERSONATION]),
          )
        : HIDDEN_DURING_IMPERSONATION;
  }
  return copy as T;
}
