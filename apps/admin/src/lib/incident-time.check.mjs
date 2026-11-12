/**
 * Checks for `incident-time.ts` (the Incidents page's deadline and times).
 *
 *     npm run test:logic -w @chumbaq/admin
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { deadlineOf, remaining, formatIstAndUtc, toLocalInputValue, fromLocalInputValue } = await jiti.import(
  path.join(here, 'incident-time.ts'),
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
const eq = (label, actual, expected) => check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

console.log('deadlineOf');
eq('is 6 hours after noticing', deadlineOf('2026-11-11T08:00:00.000Z').toISOString(), '2026-11-11T14:00:00.000Z');

console.log('remaining');
const deadline = new Date('2026-11-11T14:00:00Z');
eq('hours and minutes left', remaining(deadline, new Date('2026-11-11T08:48:00Z')).text, '5 h 12 min left');
eq('minutes only under an hour', remaining(deadline, new Date('2026-11-11T13:20:00Z')).text, '40 min left');
check('not overdue before the deadline', remaining(deadline, new Date('2026-11-11T13:59:00Z')).overdue === false);
eq('overdue after it', remaining(deadline, new Date('2026-11-11T14:40:00Z')).text, 'Overdue by 40 min');
check('overdue flag', remaining(deadline, new Date('2026-11-11T14:40:00Z')).overdue === true);
eq('overdue by hours', remaining(deadline, new Date('2026-11-11T17:05:00Z')).text, 'Overdue by 3 h 5 min');

console.log('formatIstAndUtc');
eq('IST with UTC', formatIstAndUtc('2026-11-11T08:35:00Z'), '11 Nov 2026, 14:05 IST (08:35 UTC)');
eq('across midnight UTC', formatIstAndUtc('2026-11-11T20:00:00Z'), '12 Nov 2026, 01:30 IST (20:00 UTC)');

console.log('local input values');
const value = toLocalInputValue(new Date('2026-11-11T08:35:00Z'));
check('a datetime-local value', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value), value);
eq('round-trips to the same minute', fromLocalInputValue(value), '2026-11-11T08:35:00.000Z');
eq('empty stays empty', fromLocalInputValue(''), null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
