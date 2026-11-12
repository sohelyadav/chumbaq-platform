/**
 * Checks for `password.ts`, the client's copy of the API's new-password rule. Same
 * reasoning as `segment-form.check.mjs`: `apps/web` has no test runner. The cases are the
 * ones `apps/api/src/modules/users/password.spec.ts` puts through the real pipe.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { newPassword, optionalNewPassword, PASSWORD_TOO_LONG, PASSWORD_TOO_SHORT } = await jiti.import(
  path.join(here, 'password.ts'),
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

const messages = (value, schema = newPassword()) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('accepts 8 characters', same(messages('12345678'), []));
check('accepts exactly 72 bytes', same(messages('a'.repeat(72)), []));
check('refuses 7 characters', same(messages('1234567'), [PASSWORD_TOO_SHORT]));
check('refuses 73 bytes', same(messages('a'.repeat(73)), [PASSWORD_TOO_LONG]));
// 37 characters, 74 bytes: a character count would let this through.
check('counts bytes, not characters', same(messages('é'.repeat(37)), [PASSWORD_TOO_LONG]));
check('counts an emoji as four', same(messages('😀'.repeat(19)), [PASSWORD_TOO_LONG]));
check('and 18 of them as 72', same(messages('😀'.repeat(18)), []));

const optional = optionalNewPassword();
check('optional: blank or missing is fine', same(messages('', optional), []) && same(messages(undefined, optional), []));
check('optional: says which rule a short one breaks', same(messages('1234567', optional), [PASSWORD_TOO_SHORT]));
check('optional: and a long one', same(messages('é'.repeat(37), optional), [PASSWORD_TOO_LONG]));

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
