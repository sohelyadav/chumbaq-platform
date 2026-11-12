/**
 * Checks for `pending-invite.ts`: the invite token kept in this tab while a signed-out
 * invitee signs in or creates an account. Same reasoning as `segment-form.check.mjs`:
 * `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { pendingInvite, PENDING_INVITE_KEY } = await jiti.import(path.join(here, 'pending-invite.ts'));

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

const values = new Map();
const storage = {
  setItem: (key, value) => values.set(key, String(value)),
  getItem: (key) => (values.has(key) ? values.get(key) : null),
  removeItem: (key) => values.delete(key),
};

// What the API issues: 32 random bytes, base64url, 43 characters.
const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

check('has nothing to begin with', pendingInvite.read(storage) === null);
pendingInvite.keep(storage, token);
check('keeps a token through sign-in', pendingInvite.read(storage) === token, pendingInvite.read(storage));
check('reading does not spend it', pendingInvite.read(storage) === token);
pendingInvite.clear(storage);
check('forgets it afterwards', pendingInvite.read(storage) === null);

// Whatever else is in that slot (another version, a hand edit) is not a token.
for (const garbage of ['', 'abc', '{"token":1}', `${token}x`, 'A'.repeat(42) + '!', 'undefined']) {
  values.set(PENDING_INVITE_KEY, garbage);
  check(`garbage ${JSON.stringify(garbage)} reads as null`, pendingInvite.read(storage) === null, pendingInvite.read(storage));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
