/**
 * The hosts this deployment serves its own pages from: the dashboard (`APP_URL`, which
 * is also the host of every tenant's short links and of account links), the API, the
 * short-link domain and the admin app.
 *
 * A tenant's app must never be associated with one of these. The association files
 * (`/.well-known/apple-app-site-association`, `assetlinks.json`) are chosen by matching
 * the request's host with `projects.domain`, which any project owner types in; a tenant
 * holding the shared host would be offered every tenant's links and the account links
 * on devices with its app installed.
 */
const PLATFORM_HOST_VARIABLES = ['APP_URL', 'API_BASE_URL', 'SHORT_LINK_DOMAIN', 'ADMIN_APP_URL'] as const;

export const PLATFORM_HOST_MESSAGE =
  'This domain is where this platform serves its own dashboard and short links. Enter your own domain.';

/**
 * The host name in a URL or bare host as someone might type it (`App.Example.com.`,
 * `https://app.example.com/x`, `app.example.com:443`): lower case, no port, no trailing
 * dot. Null when nothing host-like can be read from it.
 */
export function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return host || null;
  } catch {
    return null;
  }
}

export function platformHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const name of PLATFORM_HOST_VARIABLES) {
    const host = env[name] ? hostOf(env[name]!) : null;
    if (host) hosts.add(host);
  }
  return hosts;
}

export function isPlatformHost(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = hostOf(value);
  return host !== null && platformHosts(env).has(host);
}
