import type { ActivityInput } from '../project-activity/project-activity.service';

/** A short link as the target of an entry: its name, or its short code when it has none. */
export function linkTarget(link: { id: string; title?: string | null; shortCode: string }): {
  type: 'link';
  id: string;
  label: string;
} {
  return { type: 'link', id: link.id, label: link.title || link.shortCode };
}

/** A value as the comparison sees it: null for absent, ISO for a time, sorted JSON for an object. */
function normalised(key: string, value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  // The DTO carries `expiresAt` as a string; the row holds a Date.
  if (key === 'expiresAt' && typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? value : new Date(time).toISOString();
  }
  if (typeof value === 'object') return sortedJson(value);
  return value as string | number | boolean;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The names of the `allowed` fields `next` sets to something other than what `current`
 * holds, in `allowed`'s order. Names only: the log never sees a URL or any other value.
 */
export function changedLinkFields(
  current: object,
  next: object,
  allowed: readonly string[],
): string[] {
  const before = current as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  return allowed.filter(
    (key) => key in after && after[key] !== undefined && normalised(key, before[key]) !== normalised(key, after[key]),
  );
}

/**
 * What a variant create or update may set. The variant PATCH body is validated by
 * `UpdateLinkVariantDto` (an unknown key is a 400), and this list is the allow-list for
 * both the comparison and the copy onto the row: only these are compared and written.
 */
export const VARIANT_FIELDS = ['name', 'longUrl', 'iosUrl', 'androidUrl', 'weight'] as const;

/** What happened to a variant: `change` in a variant's `link.changed` entry. */
export type VariantChange = 'added' | 'changed' | 'removed';

/**
 * `link.changed` for a link's own fields (no `change`), or for one of its A/B variants:
 * `change` says whether it was added, changed or removed, and `variant` is its name,
 * else its id; never its URL. A variant removal has no `fields`.
 */
export function linkChanged(
  projectId: string,
  link: { id: string; title?: string | null; shortCode: string },
  change: { change?: VariantChange; fields?: string[]; variant?: { id: string; name?: string | null } },
): Omit<ActivityInput, 'actor'> {
  return {
    projectId,
    action: 'link.changed',
    target: linkTarget(link),
    details: {
      ...(change.change ? { change: change.change } : {}),
      ...(change.fields ? { fields: change.fields } : {}),
      ...(change.variant ? { variant: change.variant.name || change.variant.id } : {}),
    },
  };
}
