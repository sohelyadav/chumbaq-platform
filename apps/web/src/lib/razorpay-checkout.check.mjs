/**
 * Checks for `razorpay-checkout.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner. The amount is never the browser's: Checkout charges the
 * subscription the server created, so the options must carry no amount or price.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { checkoutOptions, loadRazorpayCheckout, RAZORPAY_CHECKOUT_SRC } = await jiti.import(
  path.join(here, 'razorpay-checkout.ts'),
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

/** Every key at any depth. */
function keysOf(value, found = []) {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key);
      keysOf(inner, found);
    }
  }
  return found;
}

const checkout = {
  subscriptionId: 'sub_00000000000001',
  keyId: 'rzp_test_AbC123xyz',
  customerId: 'cust_00000000000001',
  prefill: { name: 'Asha Rao', email: 'asha@example.com' },
  startsAt: null,
};

console.log('checkoutOptions');
let succeeded = 0;
let dismissed = 0;
const options = checkoutOptions(checkout, () => (succeeded += 1), () => (dismissed += 1));
const keys = keysOf(options);
check('no amount or price anywhere', !keys.some((k) => /amount|price/i.test(k)), keys.join(','));
check('the subscription', options.subscription_id === 'sub_00000000000001');
check('the key id', options.key === 'rzp_test_AbC123xyz');
check('the customer when known', options.customer_id === 'cust_00000000000001');
check('prefill', options.prefill.name === 'Asha Rao' && options.prefill.email === 'asha@example.com');
check('no currency (the plan has one)', !('currency' in options));
options.handler({ razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_1', razorpay_signature: 'x' });
check('success calls back once', succeeded === 1 && dismissed === 0);
options.modal.ondismiss();
check('dismiss calls back', dismissed === 1);

const noCustomer = checkoutOptions({ ...checkout, customerId: null }, () => {}, () => {});
check('no customer_id when null', !('customer_id' in noCustomer), Object.keys(noCustomer).join(','));

console.log('loadRazorpayCheckout');
function fakeDocument() {
  const appended = [];
  return {
    appended,
    createElement(tag) {
      return { tagName: tag.toUpperCase(), src: '', async: false, onload: null, onerror: null };
    },
    head: {
      appendChild(el) {
        appended.push(el);
        return el;
      },
    },
  };
}

const doc = fakeDocument();
const first = loadRazorpayCheckout(doc);
const second = loadRazorpayCheckout(doc);
check('one script for two calls', doc.appended.length === 1, String(doc.appended.length));
check('the same promise', first === second);
check('the exact source', doc.appended[0]?.src === 'https://checkout.razorpay.com/v1/checkout.js', doc.appended[0]?.src);
check('the exported source is the same', RAZORPAY_CHECKOUT_SRC === 'https://checkout.razorpay.com/v1/checkout.js');
check('async', doc.appended[0]?.async === true);
doc.appended[0].onload();
await first;
check('resolves on load', true);
check('a later call after load reuses it', loadRazorpayCheckout(doc) === first && doc.appended.length === 1);

const failing = fakeDocument();
const refused = loadRazorpayCheckout(failing);
failing.appended[0].onerror();
let rejected = false;
await refused.catch(() => (rejected = true));
check('rejects when the script fails', rejected);
loadRazorpayCheckout(failing);
check('a failed load can be tried again', failing.appended.length === 2, String(failing.appended.length));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
