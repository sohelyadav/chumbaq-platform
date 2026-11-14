/**
 * Checks for `billing-format.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner. Money is integer paise; nothing here may go through a float.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { formatPaise, priceLine, mauShare, canBuy, BILLING_STATE_LABELS, intervalLabel } = await jiti.import(
  path.join(here, 'billing-format.ts'),
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

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('formatPaise');
for (const [paise, text] of [
  [117882, '₹1,178.82'],
  [100, '₹1.00'],
  [0, '₹0.00'],
  [5, '₹0.05'],
  [99, '₹0.99'],
  [99900, '₹999.00'],
  [100000, '₹1,000.00'],
  [1234567800, '₹1,23,45,678.00'],
  [10000000, '₹1,00,000.00'],
  [-17982, '-₹179.82'],
  // The largest safe integer still formats exactly, digit for digit.
  [Number.MAX_SAFE_INTEGER, '₹9,00,71,99,25,47,409.91'],
]) {
  check(`${paise} → ${text}`, formatPaise(paise) === text, formatPaise(paise));
}
for (const bad of [1.5, 0.1 + 0.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, '100', null]) {
  check(`throws on ${String(bad)}`, throws(() => formatPaise(bad)));
}

console.log('priceLine');
const monthly = { id: 'p1', interval: 'monthly', pricePaise: 99900, taxPaise: 17982, amountPaise: 117882, taxRateBps: 1800 };
const yearly = { ...monthly, id: 'p2', interval: 'yearly', pricePaise: 999000, taxPaise: 179820, amountPaise: 1178820 };
check('a month', priceLine(monthly) === '₹999.00 + GST (₹179.82) a month', priceLine(monthly));
check('a year', priceLine(yearly) === '₹9,990.00 + GST (₹1,798.20) a year', priceLine(yearly));
check('interval labels', intervalLabel('monthly') === 'Monthly' && intervalLabel('yearly') === 'Yearly');

console.log('mauShare');
const share = (used, limit) => JSON.stringify(mauShare(used, limit));
check('79 of 100 is ok', mauShare(79, 100).level === 'ok', share(79, 100));
check('80 of 100 is near', mauShare(80, 100).level === 'near', share(80, 100));
check('99 of 100 is near', mauShare(99, 100).level === 'near', share(99, 100));
check('100 of 100 is over', JSON.stringify(mauShare(100, 100)) === JSON.stringify({ percent: 100, level: 'over' }), share(100, 100));
check('250 of 100 caps the bar at 100', JSON.stringify(mauShare(250, 100)) === JSON.stringify({ percent: 100, level: 'over' }), share(250, 100));
check('a percent is whole', mauShare(1, 3).percent === 33, share(1, 3));
// 2,499 of 2,500 is 99.96%: rounding up would show a full bar while still under.
check('never rounds up to full', mauShare(2499, 2500).percent === 99, share(2499, 2500));
check('no limit: no percent', mauShare(5, null).percent === null && mauShare(5, null).level === 'ok', share(5, null));
check('not counted yet: no percent', mauShare(null, 100).percent === null && mauShare(null, 100).level === 'ok', share(null, 100));
check('a zero limit with no use is ok', mauShare(0, 0).level === 'ok', share(0, 0));
check('a zero limit with use is over', mauShare(1, 0).level === 'over' && mauShare(1, 0).percent === 100, share(1, 0));

console.log('canBuy');
const plan = { code: 'paid', name: 'Paid', sortOrder: 1, mauLimit: 1, projectLimit: 1, seatLimit: 1, monthly, yearly: null };
check('priced interval', canBuy(plan, 'monthly') === true);
check('unpriced interval', canBuy(plan, 'yearly') === false);
check('free never', canBuy({ ...plan, code: 'free' }, 'monthly') === false);

console.log('BILLING_STATE_LABELS');
for (const state of ['free', 'checkout', 'active', 'past_due', 'halted', 'cancelling', 'change_scheduled', 'upgrade_pending', 'comped']) {
  check(`labels ${state}`, typeof BILLING_STATE_LABELS[state] === 'string' && BILLING_STATE_LABELS[state].length > 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
