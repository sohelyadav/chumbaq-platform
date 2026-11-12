/**
 * Checks for the impersonation session in `auth.ts` and how `api.ts` reacts to
 * it. Same reasoning as `segment-form.check.mjs`: `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 *
 * What this pins is the admin's own session surviving impersonation. `use-auth`
 * and `api.ts` call `removeTokens()` on any failure, and do so *after* the
 * interceptor has already ended the session, so each scenario below loads the
 * modules afresh (a full page load in the app) and follows that real order.
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

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const realNow = Date.now;
let now = NOW;
Date.now = () => now;

const SESSION = {
  accessToken: 'tenant-access',
  expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
  tenant: { id: 'tenant-1', email: 'tenant@example.com', name: 'Tenant' },
};
// The admin app is its own site now: VITE_ADMIN_APP_URL's default, since this runs outside Vite.
const DETAIL_PAGE = 'https://localhost:5174/tenants/tenant-1';
const LEGACY_ACCESS = 'chumbaq_access_token';
const LEGACY_REFRESH = 'chumbaq_refresh_token';
const SIGNED_IN = 'chumbaq_signed_in';

let navigations;

/** A browser tab: the admin signed in, and a page at `pathname`. */
function freshTab(pathname = '/projects') {
  now = NOW;
  navigations = [];
  globalThis.localStorage = new FakeStorage();
  globalThis.sessionStorage = new FakeStorage();
  localStorage.setItem(SIGNED_IN, '1');
  globalThis.window = {
    location: {
      pathname,
      assign: (url) => navigations.push(url),
      set href(url) { navigations.push(url); },
    },
  };
}

// The refresh cookie is out of script's reach, so all it could lose here is the note that
// it exists. `getToken falls back to the admin token` covers the token in memory.
const adminIntact = () => localStorage.getItem(SIGNED_IN) === '1';

const moduleCache = createRequire(import.meta.url).cache;
const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });

/**
 * `auth.ts` holds per-page state, so dropping it from the cache stands for a
 * page load. `api.ts` goes too, or it would keep the previous page's `auth.ts`;
 * the two returned here must be the same instance, as they are in the app.
 */
async function loadPage({ restored = true } = {}) {
  for (const file of Object.keys(moduleCache)) {
    if (file === path.join(here, 'auth.ts') || file === path.join(here, 'api.ts')) delete moduleCache[file];
  }
  const [api, auth, axiosModule] = await Promise.all([
    jiti.import(path.join(here, 'api.ts')),
    jiti.import(path.join(here, 'auth.ts')),
    jiti.import('axios'),
  ]);
  // The access token is memory only, so a loaded page has one only once it has restored.
  if (restored && localStorage.getItem(SIGNED_IN)) auth.setTokens('admin-access');
  return { auth, api: api.default, apiModule: api, axios: axiosModule.default ?? axiosModule };
}

/** Answers `api` and the bare `axios.post` of the refresh call from `respond`. */
function route({ api, axios }, respond) {
  const requests = [];
  const adapter = async (config) => {
    requests.push({
      url: config.url,
      authorization: config.headers.Authorization,
      client: config.headers['X-Chumbaq-Client'],
      body: config.data,
    });
    const { status, data, unreachable } = respond(config);
    if (unreachable) throw Object.assign(new Error('Network Error'), { config, isAxiosError: true });
    const response = { status, data, statusText: '', headers: {}, config };
    if (status < 400) return response;
    throw Object.assign(new Error(`HTTP ${status}`), { config, response, isAxiosError: true });
  };
  api.defaults.adapter = adapter;
  axios.defaults.adapter = adapter;
  return requests;
}

const failed = (promise) => promise.then(() => null, (error) => error);

// ── auth.ts ───────────────────────────────────────────────────────────

console.log('while impersonating');
{
  freshTab();
  const { auth } = await loadPage();
  auth.startImpersonation(SESSION);
  check('getToken prefers the impersonation token', auth.getToken() === 'tenant-access');
  check('no refresh is on offer', auth.canRefresh() === false);
  check('getImpersonation names the tenant and expiry', auth.getImpersonation()?.tenant.id === 'tenant-1'
    && auth.getImpersonation()?.expiresAt === SESSION.expiresAt);
  check('getImpersonation does not hand out the token', !('accessToken' in auth.getImpersonation()));
  check('starting it leaves the admin tokens in place', adminIntact());
  check('the session is in sessionStorage, not localStorage',
    sessionStorage.map.size === 1 && localStorage.map.size === 1);

  auth.setTokens('other-access');
  check('setTokens leaves the admin tokens alone', adminIntact());
  check('setTokens does not replace the session token', auth.getToken() === 'tenant-access');

  auth.removeTokens();
  check('removeTokens leaves the admin tokens alone', adminIntact());
  check('removeTokens ends the session', auth.getImpersonation() === null && sessionStorage.map.size === 0);
  check('getToken falls back to the admin token', auth.getToken() === 'admin-access');
  check('a refresh is on offer again', auth.canRefresh() === true);

  auth.removeTokens();
  check('a second removeTokens on the same page still spares the admin', adminIntact());
}

console.log('\nexpiry');
{
  freshTab();
  const { auth } = await loadPage();
  auth.startImpersonation(SESSION);
  now = NOW + 30 * 60_000 - 1;
  check('one millisecond before expiry the session holds', auth.getToken() === 'tenant-access');
  now = NOW + 30 * 60_000;
  check('at expiry getImpersonation is null', auth.getImpersonation() === null);
  check('and the record is gone', sessionStorage.map.size === 0);
  check('getToken falls back to the admin token', auth.getToken() === 'admin-access');
  check('it says which tenant it was', auth.getEndedImpersonationTenantId() === 'tenant-1');
  auth.removeTokens();
  check('removeTokens just after expiry spares the admin', adminIntact());
}
{
  freshTab();
  const { auth } = await loadPage();
  auth.startImpersonation({ ...SESSION, expiresAt: 'not a date' });
  check('an unreadable expiry counts as expired', auth.getToken() === 'admin-access');
}

console.log('\nwithout impersonation nothing changes');
{
  freshTab();
  const { auth } = await loadPage();
  check('getToken is the admin token', auth.getToken() === 'admin-access');
  check('nothing has ended', auth.getEndedImpersonationTenantId() === null);
  auth.setTokens('new-access');
  check('setTokens holds the token in memory', auth.getToken() === 'new-access');
  check('and writes no token to storage', [...localStorage.map.values()].every((value) => value === '1'));
  auth.removeTokens();
  check('removeTokens clears localStorage', localStorage.map.size === 0);
}
{
  freshTab('/login');
  const { auth } = await loadPage();
  auth.startImpersonation(SESSION);
  auth.endImpersonation();
  localStorage.map.clear();
  auth.setTokens('login-access');
  check('a login after a session ended is held', auth.getToken() === 'login-access');
  auth.removeTokens();
  check('and logging out of it really logs out', localStorage.map.size === 0);
}
{
  freshTab();
  const first = await loadPage();
  first.auth.startImpersonation(SESSION);
  first.auth.endImpersonation();
  const { auth } = await loadPage();
  auth.removeTokens();
  check('the next page load is back to normal: removeTokens clears', localStorage.map.size === 0);
}

// ── api.ts ────────────────────────────────────────────────────────────

console.log('\na 401 while impersonating');
{
  freshTab();
  const page = await loadPage();
  page.auth.startImpersonation(SESSION);
  const requests = route(page, () => ({ status: 401, data: { message: 'Unauthorized' } }));
  const error = await failed(page.api.get('/api/auth/me'));
  check('the request carried the tenant token', requests[0].authorization === 'Bearer tenant-access');
  check('the caller gets the rejection', error?.response?.status === 401);
  check('no refresh is attempted', requests.length === 1, JSON.stringify(requests));
  check('it goes to the tenant page', navigations.length === 1 && navigations[0] === DETAIL_PAGE, navigations.join());
  check('the session has ended', page.auth.getImpersonation() === null);
  check('the admin tokens survive', adminIntact());
  // What use-auth does next, in its catch block.
  page.auth.removeTokens();
  check('and survive the removeTokens from the failed /me', adminIntact());
}

console.log('\na 401 for a token that expired in flight');
{
  freshTab();
  const page = await loadPage();
  page.auth.startImpersonation(SESSION);
  const requests = route(page, () => {
    now = NOW + 30 * 60_000 + 1;
    return { status: 401, data: {} };
  });
  await failed(page.api.get('/api/projects'));
  check('no refresh is attempted with the admin refresh token', requests.length === 1, JSON.stringify(requests));
  check('it goes to the tenant page', navigations[0] === DETAIL_PAGE, navigations.join());
  check('the admin tokens survive', adminIntact());
}

console.log('\nthe stale page after a session ended');
{
  freshTab();
  const page = await loadPage();
  page.auth.startImpersonation(SESSION);
  const requests = route(page, () => ({ status: 200, data: {} }));
  now = NOW + 30 * 60_000;
  const error = await failed(page.api.patch('/api/users/me/password', {}));
  check('does not send the request as the admin', requests.length === 0, JSON.stringify(requests));
  check('rejects it', !!error);
  check('goes to the tenant page', navigations[0] === DETAIL_PAGE, navigations.join());
}

console.log('\n403 while impersonating');
{
  freshTab();
  const page = await loadPage();
  page.auth.startImpersonation(SESSION);
  const requests = route(page, () => ({ status: 403, data: { message: 'Impersonation sessions are read-only' } }));
  const error = await failed(page.api.post('/api/projects', {}));
  check('read-only reaches the caller with the server message',
    error?.response?.data?.message === 'Impersonation sessions are read-only');
  check('read-only keeps the session', page.auth.getImpersonation() !== null);
  check('read-only navigates nowhere', navigations.length === 0, navigations.join());
  check('read-only does not retry', requests.length === 1);
}
{
  freshTab();
  const page = await loadPage();
  page.auth.startImpersonation(SESSION);
  route(page, () => ({ status: 403, data: { message: 'Account suspended' } }));
  await failed(page.api.get('/api/projects'));
  check('a tenant suspended mid-session returns to the tenant page', navigations[0] === DETAIL_PAGE, navigations.join());
  check('and the admin is not signed out', adminIntact());
}

console.log('\naccount suspended, not impersonating');
{
  freshTab();
  const page = await loadPage();
  route(page, () => ({ status: 403, data: { message: 'Account suspended' } }));
  await failed(page.api.get('/api/projects'));
  check('tokens are cleared', localStorage.map.size === 0);
  check('it goes to the suspended login page', navigations[0] === '/login?suspended=1', navigations.join());
}
{
  freshTab('/login');
  localStorage.map.clear();
  const page = await loadPage();
  route(page, () => ({ status: 403, data: { message: 'Account suspended' } }));
  const error = await failed(page.api.post('/api/auth/login', {}));
  check('a refused login stays on the form', navigations.length === 0, navigations.join());
  check('with the server message for it to show', error?.response?.data?.message === 'Account suspended');
}
{
  freshTab();
  const page = await loadPage();
  route(page, () => ({ status: 403, data: { message: 'Forbidden' } }));
  await failed(page.api.get('/api/projects'));
  check('any other 403 signs nobody out', adminIntact() && navigations.length === 0, navigations.join());
}

console.log('\nthe ordinary refresh flow');
{
  freshTab();
  const page = await loadPage();
  const requests = route(page, (config) => {
    if (config.url === '/api/auth/refresh') {
      return { status: 200, data: { data: { accessToken: 'new-access' } } };
    }
    return config.headers.Authorization === 'Bearer new-access'
      ? { status: 200, data: { data: 'ok' } }
      : { status: 401, data: {} };
  });
  const response = await page.api.get('/api/projects');
  check('a 401 refreshes and retries', response.status === 200 && requests.length === 3, JSON.stringify(requests));
  check('the new token is held', page.auth.getToken() === 'new-access');
  check('the refresh says it is our client, for the API\'s lock on the cookie', requests[1].client === 'web');
  check('nothing navigates', navigations.length === 0, navigations.join());
}
{
  freshTab();
  const page = await loadPage();
  route(page, () => ({ status: 401, data: {} }));
  await failed(page.api.get('/api/projects'));
  check('a failed refresh still clears tokens and goes to /login',
    localStorage.map.size === 0 && navigations[0] === '/login', navigations.join());
}
{
  freshTab();
  const page = await loadPage();
  route(page, (config) => config.url === '/api/auth/refresh'
    ? { status: 403, data: { message: 'Account suspended' } }
    : { status: 401, data: {} });
  await failed(page.api.get('/api/projects'));
  check('a refresh refused for suspension says so', navigations[0] === '/login?suspended=1', navigations.join());
}

console.log('\nrefreshing happens once however many ask');
{
  freshTab();
  const page = await loadPage();
  const requests = route(page, (config) => {
    if (config.url === '/api/auth/refresh') return { status: 200, data: { data: { accessToken: 'new-access' } } };
    return config.headers.Authorization === 'Bearer new-access'
      ? { status: 200, data: {} }
      : { status: 401, data: {} };
  });
  await Promise.all([page.api.get('/a'), page.api.get('/b'), page.api.get('/c')]);
  check('three 401s, one refresh', requests.filter((r) => r.url === '/api/auth/refresh').length === 1);
}

console.log('\nrestoring a session on page load');
{
  freshTab();
  const page = await loadPage({ restored: false });
  check('a new page starts with no access token', page.auth.getToken() === null);
  const requests = route(page, () => ({ status: 200, data: { data: { accessToken: 'new-access' } } }));
  await page.apiModule.restoreSession();
  check('asks the cookie for one', page.auth.getToken() === 'new-access' && requests[0].url === '/api/auth/refresh');
  check('sending no token of its own', requests[0].body === '{}', requests[0].body);
  await page.apiModule.restoreSession();
  check('and does not ask again once it has one', requests.length === 1);
}
{
  freshTab();
  localStorage.map.clear();
  const page = await loadPage({ restored: false });
  const requests = route(page, () => ({ status: 200, data: {} }));
  await page.apiModule.restoreSession();
  check('someone never signed in makes no request', requests.length === 0);
}
{
  freshTab();
  const page = await loadPage({ restored: false });
  page.auth.startImpersonation(SESSION);
  const requests = route(page, () => ({ status: 200, data: {} }));
  await page.apiModule.restoreSession();
  check('a view-as tab never touches the admin cookie', requests.length === 0);
}
{
  freshTab();
  const page = await loadPage({ restored: false });
  route(page, () => ({ status: 401, data: {} }));
  await page.apiModule.restoreSession();
  check('a refused cookie ends the session', page.auth.canRefresh() === false && navigations.length === 0);
}
for (const [label, answer] of [
  ['an unreachable server', { unreachable: true }],
  ['a throttled reload', { status: 429, data: {} }],
  ['a server error', { status: 500, data: {} }],
]) {
  freshTab();
  const page = await loadPage({ restored: false });
  route(page, () => answer);
  await page.apiModule.restoreSession();
  check(`${label} signs nobody out`, page.auth.canRefresh() === true);
}
{
  freshTab();
  const page = await loadPage({ restored: false });
  route(page, () => ({ status: 403, data: { message: 'Account suspended' } }));
  await page.apiModule.restoreSession();
  check('a suspended account goes to the suspended page', navigations[0] === '/login?suspended=1', navigations.join());
}

console.log('\nleft over from before the cookie');
{
  // The API takes a refresh token only from the cookie now, so one left in storage is
  // useless to us and readable by any script: it goes on load, whatever the server says.
  freshTab();
  localStorage.map.clear();
  localStorage.setItem(LEGACY_ACCESS, 'old-access');
  localStorage.setItem(LEGACY_REFRESH, 'old-refresh');
  const page = await loadPage({ restored: false });
  check('the old access token is not used', page.auth.getToken() === null);
  check('the old refresh token alone is no reason to try', page.auth.canRefresh() === false);
  const requests = route(page, () => ({ status: 200, data: { data: { accessToken: 'new-access' } } }));
  await page.apiModule.restoreSession();
  check('nothing is sent', requests.length === 0);
  check('and no token is left in storage', localStorage.getItem(LEGACY_ACCESS) === null && localStorage.getItem(LEGACY_REFRESH) === null);
}
{
  freshTab();
  const page = await loadPage({ restored: false });
  localStorage.setItem(LEGACY_REFRESH, 'old-refresh');
  const requests = route(page, () => ({ status: 200, data: { data: { accessToken: 'new-access' } } }));
  await page.apiModule.restoreSession();
  check('a refresh sends no token in its body', requests.length === 1 && JSON.parse(requests[0].body || '{}').refreshToken === undefined, requests[0]?.body);
  check('and still restores the session from the cookie', page.auth.getToken() === 'new-access');
}

Date.now = realNow;
console.log(`\n${passed} passed, ${failures.length} failed`);
// A toast above leaves its removal timer running, so exit rather than wait for it.
process.exit(failures.length > 0 ? 1 : 0);
