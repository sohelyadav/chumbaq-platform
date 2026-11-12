import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { productionAdminAppUrlProblem } from './src/lib/admin-app-build';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * Written into the built page rather than left to the server, so every deployment gets
 * it. Build only, because the dev server relies on inline scripts for hot reload. A meta
 * tag cannot carry frame-ancestors: scripts/deploy-setup.sh sends that as a header.
 *
 * style-src allows inline because charts and the map set style attributes. img-src
 * allows any https because tenants' banners and link previews come from their own hosts.
 * Email previews are sandboxed srcdoc frames, which inherit this policy.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Also in index.html, but the dev server puts its client script ahead of that tag, so
 * everything it loads would go out under the browser default. `vite preview` inherits
 * it. Kept in step with the header in scripts/deploy-setup.sh.
 */
const REFERRER_POLICY = { 'Referrer-Policy': 'strict-origin' };

function contentSecurityPolicy(): Plugin {
  return {
    name: 'chumbaq-content-security-policy',
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

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  // Only a production build: dev and `--mode development` builds keep the localhost
  // default. loadEnv with no prefix also returns process.env, so an inline value counts.
  if (command === 'build' && mode === 'production') {
    const problem = productionAdminAppUrlProblem(env.VITE_ADMIN_APP_URL);
    if (problem) throw new Error(problem);
  }
  const apiPort = env.API_PORT || process.env.API_PORT;
  if (!apiPort) {
    throw new Error('Missing required environment variable: API_PORT');
  }
  const apiTarget = `http://localhost:${apiPort}`;

  return {
    envDir: repoRoot,
    plugins: [react(), basicSsl(), tailwindcss(), contentSecurityPolicy()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: true,
      port: 5173,
      allowedHosts: true,
      headers: REFERRER_POLICY,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        // Short links: the API serves the redirect at /api/<code> (nginx does the same).
        '/redirect': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/redirect\//, '/api/'),
        },
      },
    },
  };
});
