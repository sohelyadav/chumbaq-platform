/**
 * Checks for `account-links.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { readTokenFromUrl, removeTokenFromUrl, shouldShowVerificationBanner, isSignInAttempt, pendingVerification } = await jiti.import(
  path.join(here, 'account-links.ts'),
);

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

function fakeWindow(hash, search = '') {
  const calls = [];
  return {
    calls,
    location: { pathname: '/reset-password', search, hash },
    history: {
      state: { key: 'router-state' },
      replaceState(state, _unused, url) {
        calls.push({ state, url });
      },
    },
  };
}

console.log('isSignInAttempt');
for (const url of [
  '/api/auth/login',
  '/api/auth/login/totp',
  '/api/auth/login/recovery-code',
  '/api/auth/login/passkey/verify',
  '/api/auth/passkey/verify',
]) {
  check(`a wrong answer at ${url} stays on the form`, isSignInAttempt(url));
}
for (const url of ['/api/auth/me', '/api/auth/factors', '/api/auth/passkeys', '/api/auth/loginx', undefined]) {
  check(`a 401 from ${url} is still a dead session`, !isSignInAttempt(url));
}

console.log('pendingVerification');
{
  const values = new Map();
  const storage = {
    setItem: (key, value) => values.set(key, value),
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
  };
  check('has nothing to begin with', pendingVerification.read(storage) === null);
  pendingVerification.keep(storage, 'abc');
  check('keeps a token through sign-in', pendingVerification.read(storage) === 'abc');
  pendingVerification.clear(storage);
  check('forgets it afterwards', pendingVerification.read(storage) === null);
}

console.log('reading and removing the token');
{
  const win = fakeWindow('#token=abc_-123');
  check('reads the token from the fragment', readTokenFromUrl(win) === 'abc_-123');
  check('reading twice finds it twice, as StrictMode renders do', readTokenFromUrl(win) === 'abc_-123');
  check('reading leaves the URL alone', win.calls.length === 0);
  removeTokenFromUrl(win);
  check('removes it from the URL, leaving no bare #', win.calls[0]?.url === '/reset-password', win.calls[0]?.url);
  check('keeps the router history state', win.calls[0]?.state?.key === 'router-state');
}
{
  const win = fakeWindow('#a=1&token=abc&b=2', '?q=1');
  check('finds the token among other fragment parameters', readTokenFromUrl(win) === 'abc');
  removeTokenFromUrl(win);
  check(
    'keeps the query and the rest of the fragment',
    win.calls[0]?.url === '/reset-password?q=1#a=1&b=2',
    win.calls[0]?.url,
  );
}
{
  const win = fakeWindow('#token=a%26b%3Dc');
  check('decodes what the server encoded', readTokenFromUrl(win) === 'a&b=c');
}
{
  // Links from before the move: the token has already been sent to the server by the
  // time this page runs, so it is not accepted and does not teach anyone the old form.
  const win = fakeWindow('', '?token=abc');
  check('ignores a token in the query string', readTokenFromUrl(win) === null);
}
{
  const win = fakeWindow('#x');
  check('returns null with no token', readTokenFromUrl(win) === null);
  removeTokenFromUrl(win);
  check('leaves the URL alone with no token', win.calls.length === 0);
}

console.log('shouldShowVerificationBanner');
const unverified = { emailVerifiedAt: null };
const base = { user: unverified, impersonating: false, dismissed: false };
check('shows for an unverified user', shouldShowVerificationBanner(base) === true);
check(
  'shows when the field is absent',
  shouldShowVerificationBanner({ ...base, user: {} }) === true,
);
check(
  'hides once verified',
  shouldShowVerificationBanner({ ...base, user: { emailVerifiedAt: '2026-11-04T00:00:00Z' } }) === false,
);
check('hides while impersonating', shouldShowVerificationBanner({ ...base, impersonating: true }) === false);
check('hides once dismissed', shouldShowVerificationBanner({ ...base, dismissed: true }) === false);
check('hides with no user', shouldShowVerificationBanner({ ...base, user: null }) === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
