/**
 * Checks for `factor-reset-pending.ts`: the note that makes the factor reset banner show
 * on every page after a sign-in that could not cancel a waiting reset. Same reasoning as
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

class FakeStorage {
  map = new Map();
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
globalThis.sessionStorage = new FakeStorage();

const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true });
const pending = await jiti.import(path.join(here, 'factor-reset-pending.ts'));

let calls = 0;
const unsubscribe = pending.subscribeFactorResetPending(() => (calls += 1));

// What the API sends when the cancel worked: no field at all.
pending.noteFactorResetPending({ accessToken: 't' });
pending.noteFactorResetPending({ user: {}, tokens: { accessToken: 't' } });
check('a response without the flag notes nothing', !pending.isFactorResetPending() && calls === 0);

pending.noteFactorResetPending({ factorResetPending: 'true' });
check('only a real true counts', !pending.isFactorResetPending());

pending.noteFactorResetPending({ user: {}, tokens: { accessToken: 't' }, factorResetPending: true });
check('a sign-in whose cancel failed is noted', pending.isFactorResetPending());
check('and the banner is told at once', calls === 1, `calls: ${calls}`);

pending.clearFactorResetPending();
check('clearing takes the note away', !pending.isFactorResetPending() && calls === 2, `calls: ${calls}`);
pending.clearFactorResetPending();
check('clearing again tells nobody', calls === 2, `calls: ${calls}`);

unsubscribe();
pending.noteFactorResetPending({ accessToken: 't', factorResetPending: true });
check('an unsubscribed banner is not told', calls === 2 && pending.isFactorResetPending());

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
