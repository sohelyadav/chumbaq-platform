/**
 * Checks for `staff-link.ts`: the way back from sign-in to the page that cancels a
 * support-issued reset link, and the note that shows its banner after a sign-in that
 * could not void it. Same reasoning as `segment-form.check.mjs`: `apps/web` has no
 * test runner.
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

class FakeStorage {
  map = new Map();
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
globalThis.sessionStorage = new FakeStorage();

const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });
const link = await jiti.import(path.join(here, 'staff-link.ts'));

const CANCEL = '/account/cancel-support-link';
check('the cancel page is the one the email names', link.CANCEL_SUPPORT_LINK_PATH === CANCEL);

// The way back through sign-in.
const back = link.loginPathFor(CANCEL);
check('signing in from the cancel page keeps the way back', back === `/login?next=${encodeURIComponent(CANCEL)}`, back);
check('and the sign-in page reads it', link.nextAfterSignIn(new URL(back, 'https://x.test').search) === CANCEL);
check('any other page signs in plainly', link.loginPathFor('/projects') === '/login');
for (const next of ['https://evil.test', '//evil.test', '/projects', `${CANCEL}/x`, `${CANCEL}?a=1`, '']) {
  const result = link.nextAfterSignIn(`?next=${encodeURIComponent(next)}`);
  check(`no return to ${JSON.stringify(next)}`, result === null, String(result));
}
check('no next at all', link.nextAfterSignIn('') === null);

// The note from a sign-in whose void failed.
let calls = 0;
const unsubscribe = link.subscribeStaffLinkPending(() => (calls += 1));

link.noteStaffLinkPending({ user: {}, tokens: { accessToken: 't' } });
link.noteStaffLinkPending({ accessToken: 't', factorResetPending: true });
check('a response without the flag notes nothing', !link.isStaffLinkPending() && calls === 0);

link.noteStaffLinkPending({ staffLinkPending: 'true' });
check('only a real true counts', !link.isStaffLinkPending());

link.noteStaffLinkPending({ user: {}, tokens: { accessToken: 't' }, staffLinkPending: true });
check('a sign-in whose void failed is noted', link.isStaffLinkPending());
check('and the banner is told at once', calls === 1, `calls: ${calls}`);

link.clearStaffLinkPending();
check('clearing takes the note away', !link.isStaffLinkPending() && calls === 2, `calls: ${calls}`);
link.clearStaffLinkPending();
check('clearing again tells nobody', calls === 2, `calls: ${calls}`);

unsubscribe();
link.noteStaffLinkPending({ accessToken: 't', staffLinkPending: true });
check('an unsubscribed banner is not told', calls === 2 && link.isStaffLinkPending());

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
