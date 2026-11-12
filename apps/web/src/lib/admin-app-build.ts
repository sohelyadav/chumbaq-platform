/**
 * Read by `vite.config.ts` for production builds. `admin-app.ts` falls back to the dev
 * admin app (https://localhost:5174) so `dev:web` needs nothing set, but a production
 * build on that fallback sends super admins' "Admin app" link, the end of every view-as
 * session and the view-as error page's link to localhost, with a tenant id in the path.
 * The value is baked in at build, so the build is the place to refuse it.
 *
 * Returns why the value cannot go into a production build, or null when it can.
 */
export function productionAdminAppUrlProblem(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) {
    return 'VITE_ADMIN_APP_URL is required for a production build: set it to the admin app address, e.g. https://admin.example.com, then build again';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `VITE_ADMIN_APP_URL "${raw}" is not a URL: use the admin app address, e.g. https://admin.example.com`;
  }
  if (url.protocol !== 'https:') {
    return `VITE_ADMIN_APP_URL "${raw}" must be https: the admin app needs it for its sign-in cookie`;
  }
  // One trailing dot is the same host to a resolver (localhost. is localhost). The URL
  // parser writes IPv4 as four decimal parts and IPv6 compressed, in hex.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    // IPv4-mapped 127.x.x.x and 0.0.0.0 (::ffff:7f00:1, ::ffff:0:0).
    /^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(host);
  if (local) {
    return `VITE_ADMIN_APP_URL "${raw}" points at this machine: set it to the admin app address, e.g. https://admin.example.com`;
  }
  return null;
}
