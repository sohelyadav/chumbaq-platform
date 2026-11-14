/**
 * Checks for `billing-route.ts` and `gst-states.ts`. Same reasoning as
 * `segment-form.check.mjs`: `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { BILLING_PATH, showBillingNav, planAction, paymentConfirmed, POLL_INTERVAL_MS, POLL_LIMIT_MS } = await jiti.import(
  path.join(here, 'billing-route.ts'),
);
const { GST_STATES } = await jiti.import(path.join(here, 'gst-states.ts'));
const { GST_STATE_CODES } = await jiti.import(path.join(here, '../../../api/src/modules/billing/gstin.ts'));

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

console.log('the route');
check('the billing path', BILLING_PATH === '/account/billing', BILLING_PATH);
const router = readFileSync(path.join(here, '../router.tsx'), 'utf8');
check('the router declares it', /path:\s*BILLING_PATH\b/.test(router));
// A short link whose code is the page's first segment would be shadowed by the page.
const links = readFileSync(path.join(here, '../../../api/src/modules/links/links.service.ts'), 'utf8');
const reserved = links.slice(links.indexOf('RESERVED_SHORT_CODES'), links.indexOf(']);', links.indexOf('RESERVED_SHORT_CODES')));
const first = BILLING_PATH.split('/')[1];
check(`"${first}" is a reserved short code`, new RegExp(`'${first}'`).test(reserved));

console.log('showBillingNav');
check('on when billing is on', showBillingNav(true, false) === true);
check('off while viewing as a tenant', showBillingNav(true, true) === false);
check('off when billing is off', showBillingNav(false, false) === false);
check('off until the profile says', showBillingNav(undefined, false) === false);

console.log('planAction');
const price = { id: 'p', interval: 'monthly', pricePaise: 99900, taxPaise: 17982, amountPaise: 117882, taxRateBps: 1800 };
const free = { code: 'free', name: 'Free', sortOrder: 0, mauLimit: 10, projectLimit: 1, seatLimit: 2, monthly: null, yearly: null };
const small = { code: 'small', name: 'Small', sortOrder: 1, mauLimit: 100, projectLimit: 3, seatLimit: 5, monthly: price, yearly: { ...price, interval: 'yearly' } };
const big = { ...small, code: 'big', name: 'Big', sortOrder: 2, yearly: null };
const sub = (over = {}) => ({
  id: 's',
  planCode: 'small',
  planName: 'Small',
  interval: 'monthly',
  status: 'active',
  amountPaise: 117882,
  currentPeriodEnd: '2026-12-01T00:00:00.000Z',
  startAt: null,
  cancelAtPeriodEnd: false,
  graceUntil: null,
  ...over,
});
const overview = (over = {}) => ({
  state: 'free',
  effectivePlan: { code: 'free', name: 'Free', source: 'free', until: null },
  current: null,
  next: null,
  comp: null,
  ...over,
});
const onFree = overview();
check('free has no button', planAction(free, 'monthly', onFree) === 'current');
check('choose a priced plan', planAction(small, 'monthly', onFree) === 'choose');
check('coming soon when unpriced for the interval', planAction(big, 'yearly', onFree) === 'coming_soon');
check('choose again during checkout', planAction(small, 'monthly', overview({ state: 'checkout', next: sub({ status: 'created' }) })) === 'choose');
const active = overview({ state: 'active', effectivePlan: { code: 'small', name: 'Small', source: 'subscription', until: null }, current: sub() });
check('the current plan and interval', planAction(small, 'monthly', active) === 'current');
check('the other interval is a switch', planAction(small, 'yearly', active) === 'switch');
check('another plan is a switch', planAction(big, 'monthly', active) === 'switch');
check('free is no button on a paid plan', planAction(free, 'monthly', active) === 'none');
const cancelling = overview({ ...active, state: 'cancelling', current: sub({ cancelAtPeriodEnd: true }) });
check('keep my plan after cancelling', planAction(small, 'monthly', cancelling) === 'keep');
check('another plan after cancelling is a switch', planAction(big, 'monthly', cancelling) === 'switch');
check('nothing while a payment is retried', planAction(big, 'monthly', overview({ ...active, state: 'past_due', current: sub({ status: 'pending' }) })) === 'unavailable');
check('nothing while a change is scheduled', planAction(big, 'monthly', overview({ ...active, state: 'change_scheduled', next: sub({ status: 'authenticated', planCode: 'big' }) })) === 'unavailable');
check('choose after a halted payment', planAction(small, 'monthly', overview({ state: 'halted', current: sub({ status: 'halted' }) })) === 'choose');
check('choose on a comp', planAction(big, 'monthly', overview({ state: 'comped', effectivePlan: { code: 'big', name: 'Big', source: 'comp', until: null }, comp: { planCode: 'big', until: null } })) === 'current');
check('a comp offers the other plans', planAction(small, 'monthly', overview({ state: 'comped', effectivePlan: { code: 'big', name: 'Big', source: 'comp', until: null } })) === 'choose');

console.log('paymentConfirmed');
check('subscribe waits through checkout', paymentConfirmed('subscribe', overview({ state: 'checkout' })) === false);
check('subscribe is done once active', paymentConfirmed('subscribe', active) === true);
check('subscribe is not done on free', paymentConfirmed('subscribe', onFree) === false);
check('a change waits for its authorisation', paymentConfirmed('change', overview({ ...active, next: sub({ status: 'created' }) })) === false);
check('a change is done once authorised', paymentConfirmed('change', overview({ ...active, next: sub({ status: 'authenticated' }) })) === true);
check('an upgrade is done once granted', paymentConfirmed('change', overview({ ...active, state: 'upgrade_pending' })) === true);
check('polls every 3 s for 2 minutes', POLL_INTERVAL_MS === 3000 && POLL_LIMIT_MS === 120000);

console.log('GST states');
check('the API codes, in order', JSON.stringify(GST_STATES.map((s) => s.code)) === JSON.stringify([...GST_STATE_CODES]));
check('every state named', GST_STATES.every((s) => typeof s.name === 'string' && s.name.length > 2));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
