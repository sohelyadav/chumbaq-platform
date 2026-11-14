/**
 * A request path as it may go into the application log. Some routes carry their only
 * secret in the path (provider webhook tokens, unsubscribe and invitation tokens), and
 * nginx's log format masks them but the API's own error log did not. Any segment that
 * looks like a token (24 or more URL-safe characters) is masked, except a uuid, which
 * names a row rather than authorising anything.
 */
const TOKEN_LIKE = /^[A-Za-z0-9_.~-]{24,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function maskPathSecrets(path: string): string {
  return path
    .split('/')
    .map((segment) => (TOKEN_LIKE.test(segment) && !UUID.test(segment) ? '[masked]' : segment))
    .join('/');
}
