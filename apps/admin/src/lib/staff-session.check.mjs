/**
 * Checks for the staff session in `staff-session.ts` and how `api.ts` reacts to the admin
 * API's answers. Same approach as apps/web's `impersonation.check.mjs`: the admin app has
 * no test runner, so this loads the TypeScript with jiti against fake storage, a fake
 * `window` and a fake HTTP adapter.
 *
 *     npm run test:logic -w @chumbaq/admin
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

const IDLE = 'Signed out after a period of inactivity.';
const ENDED = 'Your staff session has ended. Sign in again.';
const REAUTH = 'Confirm it is you to continue.';
const ENROLMENT_ONLY = 'Finish setting up your sign-in methods first.';
const NOTE = 'chumbaq_staff_signed_in';

const SESSION = {
  id: 'session-1',
  enrolmentOnly: false,
  accessExpiresAt: '2026-11-08T12:10:00.000Z',
  expiresAt: '2026-11-08T20:00:00.000Z',
  idleTimeoutSeconds: 1800,
};

let navigations;

function freshTab() {
  navigations = [];
  globalThis.localStorage = new FakeStorage();
  globalThis.sessionStorage = new FakeStorage();
  globalThis.window = {
    location: {
      pathname: '/tenants',
      assign: (url) => navigations.push(url),
      replace: (url) => navigations.push(url),
      set href(url) { navigations.push(url); },
    },
  };
}

const moduleCache = createRequire(import.meta.url).cache;
const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });

/** Both modules hold per-page state, so dropping them from the cache stands for a page load. */
async function loadPage() {
  for (const file of Object.keys(moduleCache)) {
    if (file === path.join(here, 'api.ts') || file === path.join(here, 'staff-session.ts')) delete moduleCache[file];
  }
  const [api, session] = await Promise.all([
    jiti.import(path.join(here, 'api.ts')),
    jiti.import(path.join(here, 'staff-session.ts')),
  ]);
  return { apiModule: api, api: api.default, session };
}

function route({ api }, respond) {
  const requests = [];
  api.defaults.adapter = async (config) => {
    requests.push({
      url: config.url,
      method: config.method,
      authorization: config.headers.Authorization,
      client: config.headers['X-Chumbaq-Client'],
      body: config.data,
    });
    const { status, data, unreachable } = respond(config, requests.length);
    if (unreachable) throw Object.assign(new Error('Network Error'), { config, isAxiosError: true });
    const response = { status, data, statusText: '', headers: {}, config };
    if (status < 400) return response;
    throw Object.assign(new Error(`HTTP ${status}`), { config, response, isAxiosError: true });
  };
  return requests;
}

const failed = (promise) => promise.then(() => null, (error) => error);
const axiosError = (status, message) => ({ isAxiosError: true, response: { status, data: { message } } });
const noTokenStored = () =>
  [...localStorage.map.values(), ...sessionStorage.map.values()].every((value) => !value.includes('access'));

// ── staff-session.ts ─────────────────────────────────────────────────

console.log('signOutReason');
{
  freshTab();
  const { session } = await loadPage();
  check('a 401 for inactivity is idle', session.signOutReason(axiosError(401, IDLE)) === 'idle');
  check('a 401 for an ended session is ended', session.signOutReason(axiosError(401, ENDED)) === 'ended');
  check('another 401 is neither', session.signOutReason(axiosError(401, 'Unauthorized')) === null);
  check('the idle text on a 403 is neither', session.signOutReason(axiosError(403, IDLE)) === null);
  check('no response is neither', session.signOutReason(new Error('Network Error')) === null);
}

console.log('\nwhere the token lives');
{
  freshTab();
  const { session } = await loadPage();
  check('nothing at first', session.getStaffToken() === null && session.hasSignedInNote() === false);
  session.setStaffToken('staff-access', SESSION);
  check('held in memory', session.getStaffToken() === 'staff-access');
  check('the only note in storage is the signed-in flag',
    sessionStorage.getItem(NOTE) === '1' && sessionStorage.map.size === 1 && localStorage.map.size === 0);
  check('no token is written to either storage', noTokenStored());
  session.clearStaffToken();
  check('clearing forgets the token and the note',
    session.getStaffToken() === null && sessionStorage.map.size === 0);
}
{
  freshTab();
  const { session } = await loadPage();
  session.setStaffToken('enrol-access', { ...SESSION, enrolmentOnly: true });
  check('an enrolment-only session leaves no note, since it has no cookie to refresh with',
    session.getStaffToken() === 'enrol-access' && sessionStorage.map.size === 0);
}
{
  freshTab();
  const first = await loadPage();
  first.session.setStaffToken('staff-access', SESSION);
  const { session } = await loadPage();
  check('a page load starts with no token', session.getStaffToken() === null);
  check('but knows a refresh is worth trying', session.hasSignedInNote() === true);
}

// ── api.ts ───────────────────────────────────────────────────────────

console.log('\nevery request');
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('staff-access', SESSION);
  const requests = route(page, () => ({ status: 200, data: { data: [] } }));
  await page.apiModule.apiGet('/api/admin/tenants');
  check('carries the staff bearer', requests[0].authorization === 'Bearer staff-access');
  check('says it is the admin app', requests[0].client === 'admin');
}

console.log('\na 401 refreshes once and retries once');
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  const requests = route(page, (config) => {
    if (config.url === '/api/staff/auth/session/refresh') {
      return { status: 200, data: { data: { accessToken: 'new-access', session: SESSION } } };
    }
    return config.headers.Authorization === 'Bearer new-access'
      ? { status: 200, data: { data: 'ok' } }
      : { status: 401, data: { message: 'Unauthorized' } };
  });
  const result = await page.apiModule.apiGet('/api/admin/overview');
  check('the caller gets the answer', result === 'ok');
  check('original, refresh, retry', requests.map((r) => r.url).join() ===
    '/api/admin/overview,/api/staff/auth/session/refresh,/api/admin/overview', JSON.stringify(requests));
  check('the refresh says it is the admin app', requests[1].client === 'admin');
  check('the refresh sends no token in its body', !requests[1].body || requests[1].body === '{}', requests[1].body);
  check('the new token is held', page.session.getStaffToken() === 'new-access');
  check('nothing navigates', navigations.length === 0, navigations.join());
}
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  const requests = route(page, (config) =>
    config.url === '/api/staff/auth/session/refresh'
      ? { status: 200, data: { data: { accessToken: 'new-access', session: SESSION } } }
      : { status: 401, data: {} });
  const error = await failed(page.apiModule.apiGet('/api/admin/overview'));
  check('a second 401 after the retry is the answer', error?.response?.status === 401);
  check('only one refresh and one retry', requests.length === 3, JSON.stringify(requests.map((r) => r.url)));
}
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  const requests = route(page, (config) => {
    if (config.url === '/api/staff/auth/session/refresh') {
      return { status: 200, data: { data: { accessToken: 'new-access', session: SESSION } } };
    }
    return config.headers.Authorization === 'Bearer new-access' ? { status: 200, data: {} } : { status: 401, data: {} };
  });
  await Promise.all([
    page.apiModule.apiGet('/api/admin/a'),
    page.apiModule.apiGet('/api/admin/b'),
    page.apiModule.apiGet('/api/admin/c'),
  ]);
  check('three 401s, one refresh, since each rotates the cookie',
    requests.filter((r) => r.url === '/api/staff/auth/session/refresh').length === 1);
}

console.log('\na refused refresh signs out');
for (const [message, reason] of [[IDLE, 'idle'], [ENDED, 'ended'], ['Unauthorized', 'ended']]) {
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  const requests = route(page, () => ({ status: 401, data: { message } }));
  const error = await failed(page.apiModule.apiGet('/api/admin/overview'));
  check(`"${message}" goes to /sign-in?reason=${reason}`, navigations.length === 1 && navigations[0] === `/sign-in?reason=${reason}`, navigations.join());
  check('  and clears the token and the note', page.session.getStaffToken() === null && sessionStorage.map.size === 0);
  check('  and the caller still gets a rejection', !!error);
  check('  and the refresh is not itself refreshed', requests.filter((r) => r.url === '/api/staff/auth/session/refresh').length === 1);
}
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  route(page, (config) => config.url === '/api/staff/auth/session/refresh' ? { unreachable: true } : { status: 401, data: {} });
  await failed(page.apiModule.apiGet('/api/admin/overview'));
  check('an unreachable refresh signs nobody out', navigations.length === 0 && sessionStorage.getItem(NOTE) === '1');
}

console.log('\nsign-in steps keep their own errors');
for (const url of [
  '/api/staff/auth/login',
  '/api/staff/auth/login/totp',
  '/api/staff/auth/login/passkey/verify',
  '/api/staff/auth/passkey/verify',
]) {
  freshTab();
  const page = await loadPage();
  const requests = route(page, () => ({ status: 401, data: { message: 'Invalid email or password' } }));
  const error = await failed(page.apiModule.apiPost(url, {}));
  check(`a 401 from ${url} is not refreshed`, requests.length === 1 && navigations.length === 0, JSON.stringify(requests.map((r) => r.url)));
  check('  and reaches the form with the message', error?.response?.data?.message === 'Invalid email or password');
}

console.log('\nre-authentication');
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  let asked = 0;
  page.apiModule.setReauthHandler(async () => {
    asked += 1;
    page.session.replaceStaffAccessToken('fresh-access');
    return 'fresh-access';
  });
  const requests = route(page, (config) =>
    config.headers.Authorization === 'Bearer fresh-access'
      ? { status: 200, data: { data: 'done' } }
      : { status: 403, data: { message: REAUTH } });
  const result = await page.apiModule.apiPost('/api/admin/tenants/t1/suspend', { reason: 'abuse report' });
  check('the prompt is opened once', asked === 1);
  check('the request is resent once with the new token', result === 'done' && requests.length === 2
    && requests[1].authorization === 'Bearer fresh-access', JSON.stringify(requests));
  check('  with the same body', requests[1].body === requests[0].body);
}
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  let asked = 0;
  page.apiModule.setReauthHandler(async () => { asked += 1; return 'fresh-access'; });
  const requests = route(page, () => ({ status: 403, data: { message: REAUTH } }));
  const error = await failed(page.apiModule.apiPost('/api/admin/tenants/t1/suspend', {}));
  check('a second refusal is an answer, not another prompt', asked === 1 && requests.length === 2);
  check('  and reaches the caller', error?.response?.data?.message === REAUTH);
}
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  page.apiModule.setReauthHandler(() => Promise.reject(new Error('Cancelled')));
  const requests = route(page, () => ({ status: 403, data: { message: REAUTH } }));
  const error = await failed(page.apiModule.apiPost('/api/admin/tenants/t1/suspend', {}));
  check('cancelling the prompt sends nothing more', requests.length === 1);
  check('  and the caller gets the refusal', error?.response?.status === 403);
}

console.log('\nan enrolment-only session');
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('enrol-access', { ...SESSION, enrolmentOnly: true });
  const inApp = [];
  page.apiModule.setNavigator((to) => inApp.push(to));
  route(page, () => ({ status: 403, data: { message: ENROLMENT_ONLY } }));
  await failed(page.apiModule.apiGet('/api/admin/overview'));
  check('is sent to /enrol inside the app, keeping its in-memory token',
    inApp.join() === '/enrol' && navigations.length === 0 && page.session.getStaffToken() === 'enrol-access',
    `${inApp.join()} | ${navigations.join()}`);
}
{
  freshTab();
  const page = await loadPage();
  page.session.setStaffToken('old-access', SESSION);
  route(page, () => ({ status: 403, data: { message: 'Forbidden' } }));
  await failed(page.apiModule.apiGet('/api/admin/overview'));
  check('any other 403 signs nobody out and goes nowhere',
    navigations.length === 0 && page.session.getStaffToken() === 'old-access');
}

console.log('\nrestoring on page load');
{
  freshTab();
  const first = await loadPage();
  first.session.setStaffToken('staff-access', SESSION);
  const page = await loadPage();
  const requests = route(page, () => ({ status: 200, data: { data: { accessToken: 'new-access', session: SESSION } } }));
  const outcome = await page.apiModule.restoreStaffSession();
  check('asks the cookie for a token', outcome === 'restored' && requests[0]?.url === '/api/staff/auth/session/refresh');
  check('and holds it', page.session.getStaffToken() === 'new-access');
}
{
  freshTab();
  const page = await loadPage();
  const requests = route(page, () => ({ status: 200, data: {} }));
  const outcome = await page.apiModule.restoreStaffSession();
  check('with no note, asks nothing', outcome === 'none' && requests.length === 0);
}
for (const [message, reason] of [[IDLE, 'idle'], [ENDED, 'ended']]) {
  freshTab();
  const first = await loadPage();
  first.session.setStaffToken('staff-access', SESSION);
  const page = await loadPage();
  route(page, () => ({ status: 401, data: { message } }));
  const outcome = await page.apiModule.restoreStaffSession();
  check(`a refused cookie (${reason}) says why and forgets the note`, outcome === reason && sessionStorage.map.size === 0);
  check('  without navigating, so the sign-in page can say it', navigations.length === 0);
}
{
  freshTab();
  const first = await loadPage();
  first.session.setStaffToken('staff-access', SESSION);
  const page = await loadPage();
  route(page, () => ({ unreachable: true }));
  const outcome = await page.apiModule.restoreStaffSession();
  check('an unreachable API keeps the note for a retry', outcome === 'unreachable' && sessionStorage.getItem(NOTE) === '1');
}

check('no token was ever written to storage along the way', noTokenStored());

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
