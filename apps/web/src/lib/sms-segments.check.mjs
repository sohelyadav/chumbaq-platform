/**
 * Checks for `sms-segments.ts`, the composer's segment counter.
 *
 * The count is what a send costs, so it must agree with the API's
 * `countSegments`. These are the API spec's cases; run with
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });

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

const { countSegments, withOptOut } = await jiti.import(path.join(here, 'sms-segments.ts'));

const a = (n) => 'a'.repeat(n);
check('160 GSM characters are one segment', countSegments(a(160)).segments === 1);
check('161 GSM characters are two', countSegments(a(161)).segments === 2);
check('306 GSM characters are still two', countSegments(a(306)).segments === 2);
check('307 GSM characters are three', countSegments(a(307)).segments === 3);
check('the euro sign costs two septets', countSegments('€'.repeat(80)).units === 160);
check('81 euro signs need two segments', countSegments('€'.repeat(81)).segments === 2);

const curly = `${a(69)}’`;
const ucs = countSegments(curly);
check('a curly apostrophe switches to UCS-2', ucs.encoding === 'UCS-2' && ucs.segments === 1);
check('and is named as the reason', ucs.unicodeCharacter === '’');
check('71 UCS-2 units are two segments', countSegments(`${curly}b`).segments === 2);
check('an emoji is two units', countSegments('🎉').units === 2);
check('Hindi is UCS-2', countSegments('नमस्ते').encoding === 'UCS-2');
check('remaining counts down within a segment', countSegments(a(150)).remaining === 10);
check('an empty text is no segments', countSegments('').segments === 0);

check(
  'the opt-out line is appended',
  withOptOut('Sale', 'Reply STOP to opt out.') === 'Sale\nReply STOP to opt out.',
);
check(
  'but not twice',
  withOptOut('Sale. reply stop to opt out.', 'Reply STOP to opt out.') === 'Sale. reply stop to opt out.',
);
check('and not at all when there is none', withOptOut('Sale', null) === 'Sale');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
