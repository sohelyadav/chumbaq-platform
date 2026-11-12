/** Longest an email address can be, and plenty for any other single value. */
const LOGGED_VALUE_CHARS = 320;

/**
 * A value someone else wrote (a tenant's credentials, a provider's reply),
 * quoted for a log line.
 *
 * Interpolated raw, a newline in it starts a new line that looks like one of
 * ours. JSON escaping covers newlines, carriage returns and terminal escape
 * codes; the Unicode line breaks JSON leaves alone are escaped too, because
 * some log viewers break lines on them.
 *
 * `maxChars` is for a value that needs more room to be useful, such as a
 * provider's error reply.
 */
export function logValue(value: unknown, maxChars: number = LOGGED_VALUE_CHARS): string {
  return JSON.stringify(String(value).slice(0, maxChars)).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
