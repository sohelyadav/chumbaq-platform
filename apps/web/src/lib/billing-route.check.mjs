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
const { BILLING_PATH, showBillingNav, planAction, cancelOffer, paymentConfirmed, beforeCheckout, POLL_INTERVAL_MS, POLL_LIMIT_MS } =
  await jiti.import(
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

// A change or "keep my plan" once authorised: the worker then sets the current to end.
const changeAuthorised = overview({
  ...active,
  state: 'change_scheduled',
  current: sub({ cancelAtPeriodEnd: true }),
  next: sub({ id: 'n', status: 'authenticated', planCode: 'big', planName: 'Big', startAt: '2026-12-01T00:00:00.000Z' }),
});
check('no "keep my plan" once a change is authorised', planAction(small, 'monthly', changeAuthorised) === 'current');
check('the other plans wait for the change', planAction(big, 'monthly', changeAuthorised) === 'unavailable');
check('the other interval waits for the change', planAction(small, 'yearly', changeAuthorised) === 'unavailable');
const keepAuthorised = overview({
  ...active,
  state: 'change_scheduled',
  current: sub({ cancelAtPeriodEnd: true }),
  next: sub({ id: 'n', status: 'authenticated', startAt: '2026-12-01T00:00:00.000Z' }),
});
check('no "keep my plan" once it is authorised', planAction(small, 'monthly', keepAuthorised) === 'current');
check('nor before the current is set to end', planAction(small, 'monthly', overview({ ...keepAuthorised, current: sub() })) === 'current');
const upgrade = overview({
  state: 'upgrade_pending',
  effectivePlan: { code: 'big', name: 'Big', source: 'subscription', until: null },
  current: sub({ cancelAtPeriodEnd: true }),
  next: sub({ id: 'n', status: 'authenticated', planCode: 'big', planName: 'Big', startAt: '2026-12-01T00:00:00.000Z' }),
});
check('an upgrade granted early is the current card', planAction(big, 'monthly', upgrade) === 'current');
check('the plan it replaces offers nothing', planAction(small, 'monthly', upgrade) === 'unavailable');

console.log('cancelOffer');
check('cancel an active plan', cancelOffer(active) === 'cancel');
check('cancel a plan whose payment is retried', cancelOffer(overview({ current: sub({ status: 'pending' }) })) === 'cancel');
check('nothing once it already ends', cancelOffer(cancelling) === 'none');
check('nothing on free', cancelOffer(onFree) === 'none');
check('nothing on a halted plan', cancelOffer(overview({ state: 'halted', current: sub({ status: 'halted' }) })) === 'none');
check('drop an authorised change when the current already ends', cancelOffer(changeAuthorised) === 'drop_change');
check('drop an authorised "keep my plan"', cancelOffer(keepAuthorised) === 'drop_change');
check('drop an authorised change before the current is set to end', cancelOffer(overview({ ...changeAuthorised, current: sub() })) === 'drop_change');
check('drop a granted upgrade', cancelOffer(upgrade) === 'drop_change');
check('an abandoned checkout is no change to drop', cancelOffer(overview({ ...cancelling, next: sub({ id: 'n', status: 'created' }) })) === 'none');

console.log('paymentConfirmed');
const fromFree = beforeCheckout(onFree);
check('before Checkout records the ids', JSON.stringify(beforeCheckout(changeAuthorised)) === JSON.stringify({ currentId: 's', nextId: 'n' }));
check('before Checkout with nothing loaded', JSON.stringify(beforeCheckout(undefined)) === JSON.stringify({ currentId: null, nextId: null }));
check('subscribe waits through checkout', paymentConfirmed('subscribe', overview({ state: 'checkout', next: sub({ id: 'n', status: 'created' }) }), fromFree) === false);
check('subscribe waits while only authorised', paymentConfirmed('subscribe', overview({ state: 'change_scheduled', next: sub({ id: 'n', status: 'authenticated' }) }), fromFree) === false);
check('subscribe is done once active', paymentConfirmed('subscribe', overview({ ...active, current: sub({ id: 'n' }) }), fromFree) === true);
check('subscribe is not done on free', paymentConfirmed('subscribe', onFree, fromFree) === false);
// A halted current keeps its grace until the new one starts, so the state stays halted.
const halted = overview({ state: 'halted', effectivePlan: { code: 'small', name: 'Small', source: 'subscription', until: null }, current: sub({ status: 'halted', graceUntil: '2026-12-05T00:00:00.000Z' }) });
const fromHalted = beforeCheckout(halted);
check('subscribe from halted waits while the new one is created', paymentConfirmed('subscribe', { ...halted, next: sub({ id: 'n', status: 'created' }) }, fromHalted) === false);
check('subscribe from halted waits while the new one is authorised', paymentConfirmed('subscribe', { ...halted, state: 'change_scheduled', next: sub({ id: 'n', status: 'authenticated' }) }, fromHalted) === false);
check('subscribe from halted is not done by the old one recovering', paymentConfirmed('subscribe', overview({ ...active, next: sub({ id: 'n', status: 'created' }) }), fromHalted) === false);
check('subscribe from halted is done once the new one is current', paymentConfirmed('subscribe', overview({ ...active, current: sub({ id: 'n' }) }), fromHalted) === true);
// The comp wins the state, whatever the subscription does.
const comped = overview({ state: 'comped', effectivePlan: { code: 'big', name: 'Big', source: 'comp', until: '2026-12-10T00:00:00.000Z' }, comp: { planCode: 'big', until: '2026-12-10T00:00:00.000Z' } });
const fromComp = beforeCheckout(comped);
check('subscribe on a comp waits while the new one is created', paymentConfirmed('subscribe', { ...comped, next: sub({ id: 'n', status: 'created' }) }, fromComp) === false);
check('subscribe on a comp waits while the new one is authorised', paymentConfirmed('subscribe', { ...comped, next: sub({ id: 'n', status: 'authenticated' }) }, fromComp) === false);
check('subscribe on a comp is done once the new one is current', paymentConfirmed('subscribe', { ...comped, current: sub({ id: 'n' }) }, fromComp) === true);
const fromActive = beforeCheckout(active);
check('a change waits for its authorisation', paymentConfirmed('change', overview({ ...active, next: sub({ id: 'n', status: 'created' }) }), fromActive) === false);
check('a change is done once authorised', paymentConfirmed('change', overview({ ...active, next: sub({ id: 'n', status: 'authenticated' }) }), fromActive) === true);
check('an upgrade is done once granted', paymentConfirmed('change', upgrade, fromActive) === true);
check('a change is done if it already started', paymentConfirmed('change', overview({ ...active, current: sub({ id: 'n' }) }), fromActive) === true);
check('a change is not done by the subscription that was waiting before', paymentConfirmed('change', changeAuthorised, beforeCheckout(changeAuthorised)) === false);
check('polls every 3 s for 2 minutes', POLL_INTERVAL_MS === 3000 && POLL_LIMIT_MS === 120000);

console.log('GST states');
check('the API codes, in order', JSON.stringify(GST_STATES.map((s) => s.code)) === JSON.stringify([...GST_STATE_CODES]));
check('every state named', GST_STATES.every((s) => typeof s.name === 'string' && s.name.length > 2));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
