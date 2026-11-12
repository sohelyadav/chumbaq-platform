import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * The admin app loads nothing from anywhere but its own origin: no fonts, images or
 * scripts from third parties (Inter is bundled), and it talks only to /api on the same
 * host. Written into the built page so every deployment gets it; build only, because the
 * dev server relies on inline scripts for hot reload. A meta tag cannot carry
 * frame-ancestors: scripts/deploy-setup.sh sends that, with X-Frame-Options, as headers.
 *
 * style-src allows inline because Recharts and Radix set style attributes; there is no
 * inline script, and no way to add one without changing this.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * No Referer at all, not even the origin: admin paths name tenants, and nothing the
 * admin app links to (the customer app's view-as page included) needs to know where a
 * click came from. Also in index.html; the dev server and `vite preview` send it too.
 */
const SECURITY_HEADERS = { 'Referrer-Policy': 'no-referrer' };

function contentSecurityPolicy(): Plugin {
  return {
    name: 'chumbaq-admin-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  // Optional, unlike the customer app's API_PORT: the admin API has a default.
  const adminApiPort = process.env.ADMIN_API_PORT || env.ADMIN_API_PORT || '3011';
  const apiTarget = `http://localhost:${adminApiPort}`;

  return {
    envDir: repoRoot,
    plugins: [react(), basicSsl(), tailwindcss(), contentSecurityPolicy()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5174,
      strictPort: true,
      headers: SECURITY_HEADERS,
      // Same origin as the app, so the staff cookie (host-only, Path=/api/staff/auth/session)
      // is set and sent exactly as it will be behind nginx.
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: {
      port: 5174,
      strictPort: true,
      headers: SECURITY_HEADERS,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
