/**
 * Checks for the view-as handoff page's logic (`impersonation-handoff.ts`): the admin app
 * opens `/impersonate#code=...` and this page swaps the one-time code for the read-only
 * session. Same approach as `impersonation.check.mjs`.
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

const CODE = 'Ab3_-'.repeat(8) + 'xyz'; // 43 base64url characters
const INVALID = 'This view-as link has expired or was already used.';
const SESSION = {
  accessToken: 'tenant-access',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  tenant: { id: 'tenant-1', email: 'tenant@example.com', name: 'Tenant' },
};

/** Everything the page does to the outside world, in order. */
let events;

function freshTab(hash) {
  events = [];
  globalThis.localStorage = new FakeStorage();
  globalThis.sessionStorage = new FakeStorage();
  // The staff member may also be signed in to the customer app in this browser.
  localStorage.setItem('chumbaq_signed_in', '1');
  globalThis.window = {
    location: {
      pathname: '/impersonate',
      hash,
      href: `https://localhost:5173/impersonate${hash}`,
      replace: (url) => events.push({ kind: 'replace', url }),
      assign: (url) => events.push({ kind: 'assign', url }),
    },
    history: {
      replaceState: (_state, _title, url) => {
        events.push({ kind: 'replaceState', url });
        window.location.hash = '';
        window.location.href = `https://localhost:5173${url}`;
      },
    },
  };
}

const moduleCache = createRequire(import.meta.url).cache;
const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });

async function loadPage() {
  for (const file of Object.keys(moduleCache)) {
    if (file.startsWith(here)) delete moduleCache[file];
  }
  const [handoff, auth, axiosModule] = await Promise.all([
    jiti.import(path.join(here, 'impersonation-handoff.ts')),
    jiti.import(path.join(here, 'auth.ts')),
    jiti.import('axios'),
  ]);
  return { handoff, auth, axios: axiosModule.default ?? axiosModule };
}

function route({ axios }, respond) {
  axios.defaults.adapter = async (config) => {
    events.push({
      kind: 'request',
      url: config.url,
      method: config.method,
      body: config.data,
      client: config.headers['X-Chumbaq-Client'],
      authorization: config.headers.Authorization,
    });
    const { status, data, unreachable } = respond(config);
    if (unreachable) throw Object.assign(new Error('Network Error'), { config, isAxiosError: true });
    const response = { status, data, statusText: '', headers: {}, config };
    if (status < 400) return response;
    throw Object.assign(new Error(`HTTP ${status}`), { config, response, isAxiosError: true });
  };
}

console.log('readHandoffCode');
{
  freshTab('');
  const { handoff } = await loadPage();
  check('takes a 43-character code', handoff.readHandoffCode(`#code=${CODE}`) === CODE);
  check('refuses a short one', handoff.readHandoffCode('#code=short') === null);
  check('refuses a 44-character one', handoff.readHandoffCode(`#code=${CODE}a`) === null);
  check('refuses another name', handoff.readHandoffCode(`#token=${CODE}`) === null);
  check('refuses characters outside base64url', handoff.readHandoffCode(`#code=${CODE.slice(0, 42)}+`) === null);
  check('refuses extra parameters', handoff.readHandoffCode(`#code=${CODE}&next=/x`) === null);
  check('refuses nothing', handoff.readHandoffCode('') === null);
}

console.log('\na good code');
{
  freshTab(`#code=${CODE}`);
  const page = await loadPage();
  route(page, () => ({ status: 200, data: { data: SESSION } }));
  const error = await page.handoff.openHandoff();
  const kinds = events.map((e) => e.kind).join();
  check('succeeds', error === null, String(error));
  check('takes the code out of the address bar before any request', kinds === 'replaceState,request,replace', kinds);
  check('  leaving /impersonate with no fragment', events[0].url === '/impersonate');
  const request = events.find((e) => e.kind === 'request');
  check('posts the code in the body to the exchange route',
    request.method === 'post' && request.url === '/api/auth/impersonation/exchange'
      && JSON.parse(request.body).code === CODE, JSON.stringify(request));
  check('  with the client header', request.client === 'web');
  check('  and no bearer of the customer\'s own', request.authorization === undefined);
  check('the code is in no URL anywhere',
    events.every((e) => !e.url?.includes(CODE)), JSON.stringify(events));
  check('starts the read-only session', page.auth.getToken() === 'tenant-access'
    && page.auth.getImpersonation()?.tenant.id === 'tenant-1');
  check('goes to the projects with a full load', events.at(-1).url === '/projects');
  check('the customer\'s own signed-in note is untouched', localStorage.getItem('chumbaq_signed_in') === '1'
    && localStorage.map.size === 1);
}
{
  freshTab(`#code=${CODE}`);
  const page = await loadPage();
  route(page, () => ({ status: 200, data: { data: SESSION } }));
  const [first, second] = await Promise.all([page.handoff.openHandoff(), page.handoff.openHandoff()]);
  check('asked twice on one page load (a re-run effect), exchanges once',
    first === null && second === null && events.filter((e) => e.kind === 'request').length === 1);
}

console.log('\na refused code');
{
  freshTab(`#code=${CODE}`);
  const page = await loadPage();
  route(page, () => ({ status: 400, data: { message: INVALID } }));
  const error = await page.handoff.openHandoff();
  check('shows the API\'s message', error === INVALID, String(error));
  check('stores nothing', sessionStorage.map.size === 0 && page.auth.getImpersonation() === null);
  check('goes nowhere', !events.some((e) => e.kind === 'replace' || e.kind === 'assign'));
}
{
  freshTab(`#code=${CODE}`);
  const page = await loadPage();
  route(page, () => ({ unreachable: true }));
  const error = await page.handoff.openHandoff();
  check('an outage says so', typeof error === 'string' && error !== INVALID && sessionStorage.map.size === 0, String(error));
}
{
  freshTab('#code=short');
  const page = await loadPage();
  route(page, () => ({ status: 200, data: { data: SESSION } }));
  const error = await page.handoff.openHandoff();
  check('a malformed link sends nothing and says the same as a used one',
    error === INVALID && !events.some((e) => e.kind === 'request'), JSON.stringify(events));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
