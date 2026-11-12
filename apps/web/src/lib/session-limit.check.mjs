/**
 * Checks for `session-limit.ts` and how `api.ts` uses it when a refresh is refused.
 * Same reasoning as `segment-form.check.mjs`: `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import { createRequire } from 'module';
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

class FakeStorage {
  map = new Map();
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const DAY = 86_400;
const realNow = Date.now;
let now = NOW;
Date.now = () => now;

/** An unsigned token with these claims: the dashboard only ever reads them. */
const token = (claims) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const SESSION_END = Math.floor(NOW / 1000) + 2 * DAY;
const ISSUED = token({ sub: 'u', session_exp: SESSION_END, session_max_age: 30 * DAY });

let navigations;
function freshTab(pathname = '/projects') {
  now = NOW;
  navigations = [];
  globalThis.localStorage = new FakeStorage();
  globalThis.sessionStorage = new FakeStorage();
  localStorage.setItem('chumbaq_signed_in', '1');
  globalThis.window = {
    location: {
      pathname,
      assign: (url) => navigations.push(url),
      set href(url) { navigations.push(url); },
    },
  };
}

const moduleCache = createRequire(import.meta.url).cache;
const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });
const FRESH = ['auth.ts', 'api.ts', 'session-limit.ts'].map((f) => path.join(here, f));

async function loadPage() {
  for (const file of Object.keys(moduleCache)) if (FRESH.includes(file)) delete moduleCache[file];
  const [api, auth, limit, axiosModule] = await Promise.all([
    jiti.import(path.join(here, 'api.ts')),
    jiti.import(path.join(here, 'auth.ts')),
    jiti.import(path.join(here, 'session-limit.ts')),
    jiti.import('axios'),
  ]);
  return { auth, limit, api: api.default, apiModule: api, axios: axiosModule.default ?? axiosModule };
}

function route({ api, axios }, respond) {
  const adapter = async (config) => {
    const { status, data } = respond(config);
    const response = { status, data, statusText: '', headers: {}, config };
    if (status < 400) return response;
    throw Object.assign(new Error(`HTTP ${status}`), { config, response, isAxiosError: true });
  };
  api.defaults.adapter = adapter;
  axios.defaults.adapter = adapter;
}

console.log('labels and the login notice');
{
  freshTab();
  const { limit } = await loadPage();
  check('30 days', limit.sessionLimitLabel(30 * DAY) === '30-day');
  check('12 hours', limit.sessionLimitLabel(12 * 3600) === '12-hour');
  check('90 minutes', limit.sessionLimitLabel(90 * 60) === '90-minute');
  check('names the limit', limit.sessionLimitNotice('30-day')
    === 'You were signed out because your session reached its 30-day limit. Sign in again to continue.');
  check('no parameter, no notice', limit.sessionLimitNotice(null) === null);
  const crafted = limit.sessionLimitNotice('call 0800 now to keep your account');
  check('a crafted parameter shows none of its own words', crafted !== null && !crafted.includes('0800'), crafted);
  check('nor does a zero', !limit.sessionLimitNotice('0-day').includes('0-day'));
}

console.log('\nnoting the session end');
{
  freshTab();
  const { auth, limit } = await loadPage();
  auth.setTokens(ISSUED);
  check('nothing before the end', limit.sessionLimitLoginPath('Invalid or expired refresh token') === null);
  now = SESSION_END * 1000;
  check('at the end, the reason is the limit', limit.sessionLimitLoginPath('Invalid or expired refresh token')
    === '/login?sessionLimit=30-day');
  auth.setTokens(token({ sub: 'u', amr: ['pwd'] }));
  check('a token without the claims keeps the note', limit.sessionLimitLoginPath(undefined) === '/login?sessionLimit=30-day');
  auth.removeTokens();
  check('signing out forgets it', limit.sessionLimitLoginPath(undefined) === null);
  check('the API saying so is enough without a note', limit.sessionLimitLoginPath('Session reached its maximum length')
    === '/login?sessionLimit=1');
  check('a non-JWT token is ignored', (auth.setTokens('opaque'), localStorage.getItem('chumbaq_session_limit') === null));
}

console.log('\nwhen a refresh is refused');
{
  freshTab();
  const page = await loadPage();
  page.auth.setTokens(ISSUED);
  now = SESSION_END * 1000 + 1000;
  // The cookie has expired with the session, so the API has nothing to go on.
  route(page, () => ({ status: 401, data: { message: 'Invalid or expired refresh token' } }));
  page.auth.removeTokens(); // a page load: the access token is gone, the notes are not
  localStorage.setItem('chumbaq_signed_in', '1');
  page.limit.rememberSessionLimit(ISSUED);
  await page.apiModule.restoreSession();
  check('on page load, the login page explains', navigations[0] === '/login?sessionLimit=30-day', JSON.stringify(navigations));
  check('and the session is gone', page.auth.canRefresh() === false);
}
{
  freshTab();
  const page = await loadPage();
  page.auth.setTokens(ISSUED);
  route(page, () => ({ status: 401, data: { message: 'Invalid or expired refresh token' } }));
  page.auth.removeTokens();
  localStorage.setItem('chumbaq_signed_in', '1');
  page.limit.rememberSessionLimit(ISSUED);
  await page.apiModule.restoreSession();
  check('a refusal before the end says nothing about limits', navigations.length === 0, JSON.stringify(navigations));
}
{
  freshTab();
  const page = await loadPage();
  page.auth.setTokens(ISSUED);
  route(page, (config) =>
    config.url === '/api/auth/refresh'
      ? { status: 401, data: { message: 'Session reached its maximum length' } }
      : { status: 401, data: { message: 'Unauthorized' } },
  );
  await page.api.get('/api/projects').catch(() => undefined);
  check('mid-session, the API naming the limit sends there too', navigations[0] === '/login?sessionLimit=30-day', JSON.stringify(navigations));
}
{
  freshTab();
  const page = await loadPage();
  page.auth.setTokens(ISSUED);
  route(page, (config) =>
    config.url === '/api/auth/refresh'
      ? { status: 401, data: { message: 'Invalid or expired refresh token' } }
      : { status: 401, data: { message: 'Unauthorized' } },
  );
  await page.api.get('/api/projects').catch(() => undefined);
  check('any other refusal goes to the plain login page', navigations[0] === '/login', JSON.stringify(navigations));
}

Date.now = realNow;
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
