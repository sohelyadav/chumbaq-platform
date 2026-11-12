/**
 * Checks for `enrolment-code.ts`: when the sign-in page asks for an operator's enrolment
 * code, and what it sends. The admin app has no test runner, so this loads the
 * TypeScript with jiti, as the other checks here do.
 *
 *     npm run test:logic -w @chumbaq/admin
 */
import { createJiti } from 'jiti';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { needsEnrolmentCode, staffLoginBody } = await jiti.import(path.join(here, 'enrolment-code.ts'));

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

// The API's own text, read from its source, so a change on one side fails here.
const apiMessages = readFileSync(
  path.join(here, '../../../api/src/modules/staff-auth/staff-messages.ts'),
  'utf8',
);
const blocked = /STAFF_ENROLMENT_BLOCKED_MESSAGE =\s*'([^']+)'/.exec(apiMessages)?.[1];

console.log('needsEnrolmentCode');
check('the API still declares the message', typeof blocked === 'string');
check('asks for the code on the API answer', needsEnrolmentCode(blocked ?? '') === true);
check('not on a wrong password', needsEnrolmentCode('Invalid email or password') === false);
check('not on the sign-in limit', needsEnrolmentCode('Too many failed attempts. Try again in a few minutes.') === false);
check('not with no error', needsEnrolmentCode(null) === false);

console.log('staffLoginBody');
const plain = staffLoginBody('a@x.test', 'pw', null);
check('sends no code until asked', !('enrolmentCode' in plain), JSON.stringify(plain));
const blank = staffLoginBody('a@x.test', 'pw', '   ');
check('sends no empty code', !('enrolmentCode' in blank), JSON.stringify(blank));
const withCode = staffLoginBody('a@x.test', 'pw', '  abc_DEF-123  ');
check('sends the code trimmed', withCode.enrolmentCode === 'abc_DEF-123', JSON.stringify(withCode));
check('keeps email and password', withCode.email === 'a@x.test' && withCode.password === 'pw');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
