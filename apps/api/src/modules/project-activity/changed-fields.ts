/**
 * What a settings save really changes, worked out before it is written, so the log can
 * name the fields (never their values) and a save that changes nothing logs nothing.
 */

function sameValue(a: unknown, b: unknown): boolean {
  // A column the form leaves empty is stored as null; the DTO may say undefined.
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  return a === b;
}

/**
 * The keys of `next` whose value differs from `current`'s, in `next`'s order. With no
 * `current` (the first save, which creates the row) every key counts as changed.
 */
export function changedFields<T extends object>(current: object | null | undefined, next: T): (keyof T & string)[] {
  const keys = Object.keys(next) as (keyof T & string)[];
  if (!current) return keys;
  const before = current as Record<string, unknown>;
  return keys.filter((key) => !sameValue(before[key], next[key]));
}

/** JSON with every object's keys sorted, so key order and whitespace do not count as a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Whether two credential blobs say the same thing. Both are JSON as pasted; one that will
 * not parse is compared as text. Only a yes or no leaves here, never either value.
 */
export function sameCredentials(stored: string, incoming: string): boolean {
  try {
    return canonicalJson(JSON.parse(stored)) === canonicalJson(JSON.parse(incoming));
  } catch {
    return stored === incoming;
  }
}
