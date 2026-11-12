/**
 * Checks for `admin-app-build.ts`: a production build must not bake the dev admin app
 * address into the "Admin app" link and the end-of-view-as redirect, which would send
 * staff to localhost with a tenant id in the path. Same reasoning as
 * `segment-form.check.mjs`: `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });
const { productionAdminAppUrlProblem: problem } = await jiti.import(path.join(here, 'admin-app-build.ts'));

check('a real https host passes', problem('https://admin.example.com') === null);
check('a trailing slash passes', problem('https://admin.example.com/') === null);

const unset = problem(undefined);
check('unset is refused, naming the variable', unset !== null && unset.includes('VITE_ADMIN_APP_URL'), unset);
check('empty is refused', problem('') !== null && problem('   ') !== null);

for (const local of [
  'https://localhost:5174',
  'https://LOCALHOST',
  'https://admin.localhost',
  'https://127.0.0.1:5174',
  'https://[::1]:5174',
  'https://0.0.0.0',
  // Still this machine: a trailing dot, the unspecified IPv6 address, IPv4-mapped loopback.
  'https://localhost.:5174',
  'https://a.localhost.',
  'https://127.0.0.1.',
  'https://[::]',
  'https://[::ffff:127.0.0.1]',
  'https://[::ffff:127.1.2.3]',
  'https://[::ffff:0.0.0.0]',
]) {
  const found = problem(local);
  check(`${local} is refused`, found !== null && found.includes('VITE_ADMIN_APP_URL'), String(found));
}

check('plain http is refused', problem('http://admin.example.com') !== null);
check('something that is not a URL is refused', problem('admin.example.com') !== null);
check('a public mapped address passes', problem('https://[::ffff:203.0.113.7]') === null);

// The wiring: vite.config.ts must refuse a production build itself, not just have the
// helper above. Loaded through jiti and called as vite would. loadEnv lets process.env
// win over the .env files, so setting it here decides the value whatever the repo has.
const { default: viteConfig } = await jiti.import(path.join(here, '../../vite.config.ts'));
const saved = { VITE_ADMIN_APP_URL: process.env.VITE_ADMIN_APP_URL, API_PORT: process.env.API_PORT };
process.env.API_PORT = saved.API_PORT || '3000';

function buildError(command, mode, value) {
  process.env.VITE_ADMIN_APP_URL = value;
  try {
    viteConfig({ command, mode });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const empty = buildError('build', 'production', '');
check('vite build (production) refuses an empty VITE_ADMIN_APP_URL', empty !== null && empty.includes('VITE_ADMIN_APP_URL'), String(empty));
const local = buildError('build', 'production', 'https://localhost:5174');
check('vite build (production) refuses a localhost VITE_ADMIN_APP_URL', local !== null && local.includes('VITE_ADMIN_APP_URL'), String(local));
check('vite build (production) accepts a real admin host', buildError('build', 'production', 'https://admin.example.com') === null);
check('vite build --mode development keeps the localhost default', buildError('build', 'development', '') === null);
check('the dev server keeps the localhost default', buildError('serve', 'development', '') === null);

for (const [key, value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
