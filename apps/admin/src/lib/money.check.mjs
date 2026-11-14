/**
 * Checks for `money.ts`. The admin app has no test runner, so these run with
 * nothing but node. A price typed by staff becomes what the provider's plan must
 * charge, so a rounding slip here is a plan that can never be added, or worse.
 *
 *     npm run test:logic -w @chumbaq/admin
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { parseRupees, formatPaise, priceWithGst } = await jiti.import(path.join(here, 'money.ts'));
const { parseLimit, limitLabel, projectLimitLabel, safeProviderUrl } = await jiti.import(path.join(here, 'billing-view.ts'));

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

for (const [input, expected] of [
  ['1499', 149900],
  ['1,499.50', 149950],
  ['₹ 1,499.5', 149950],
  ['₹1499', 149900],
  ['  1499.05 ', 149905],
  ['1499.05', 149905],
  ['1,49,999', 14999900],
  ['149,999', 14999900],
  ['0.1', 10],
  ['0.01', 1],
  ['1000000', 100000000],
]) {
  const got = parseRupees(input);
  check(`parseRupees(${JSON.stringify(input)}) is ${expected}`, got === expected, String(got));
}

for (const input of [
  '1499.505',
  '-1',
  '+1',
  '1e3',
  '',
  '   ',
  'abc',
  '10000000000',
  '1000000.01',
  '1,49,9',
  '12,34',
  '1,4999',
  '1499.',
  '.5',
  '1 499',
  '₹',
  'Infinity',
  '0x10',
]) {
  const got = parseRupees(input);
  check(`parseRupees(${JSON.stringify(input)}) is refused`, got === null, String(got));
}

{
  const got = priceWithGst(99900);
  check('priceWithGst(99900) adds 18% GST', got.taxPaise === 17982 && got.amountPaise === 117882, JSON.stringify(got));
}
{
  // 18% of 2 paise is 0.36: rounds down; of 25 paise, 4.5: rounds half up.
  const small = priceWithGst(2);
  const half = priceWithGst(25);
  check('priceWithGst rounds half up', small.taxPaise === 0 && half.taxPaise === 5, JSON.stringify({ small, half }));
}
{
  const got = priceWithGst(100000000);
  check('priceWithGst is exact at the largest price', got.amountPaise === 118000000, JSON.stringify(got));
}

check('formatPaise groups the Indian way', formatPaise(1234567800) === '₹1,23,45,678.00', formatPaise(1234567800));
check('formatPaise keeps the paise', formatPaise(117882) === '₹1,178.82', formatPaise(117882));
check('formatPaise pads small amounts', formatPaise(5) === '₹0.05', formatPaise(5));
{
  let threw = false;
  try {
    formatPaise(1.5);
  } catch {
    threw = true;
  }
  check('formatPaise refuses a fractional paisa', threw);
}

// Limits typed into the plan form.
check('a blank limit is no limit', parseLimit('  ') === null);
check('a limit is a whole number', parseLimit('25,000') === 25000 && parseLimit('3') === 3);
for (const bad of ['0', '-1', '1.5', '1e3', 'ten']) {
  check(`a limit of ${JSON.stringify(bad)} is refused`, parseLimit(bad) === undefined, String(parseLimit(bad)));
}
check('a limit over its maximum is refused', parseLimit('1001', 1000) === undefined);
check('null limits read as unlimited, or the default for projects', limitLabel(null) === 'Unlimited' && projectLimitLabel(null, 10) === 'Default (10)');

// Invoice links only ever open the provider's https pages.
check('an https invoice link is kept', safeProviderUrl('https://rzp.io/i/abc') === 'https://rzp.io/i/abc');
for (const bad of ['javascript:alert(1)', 'http://rzp.io/i/abc', 'https://user:pw@rzp.io/i/abc', 'not a url', null]) {
  check(`invoice link ${JSON.stringify(bad)} is dropped`, safeProviderUrl(bad) === null);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
