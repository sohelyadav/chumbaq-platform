/**
 * Checks for `passkey-autofill.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createPasskeyAutofill, AUTOFILL_REFRESH_MS, AUTOFILL_MAX_RETRIES } = await jiti.import(
  path.join(here, 'passkey-autofill.ts'),
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const named = (name) => Object.assign(new Error(name), { name });

/**
 * Behaves like `@simplewebauthn/browser`: one ceremony at a time, and cancelling rejects
 * the pending one with an AbortError.
 */
function harness({ supported = true, offers } = {}) {
  let flowCount = 0;
  offers ??= () => ({ available: true, flowId: `f${++flowCount}`, options: { n: flowCount } });
  const log = { fetched: 0, cancelled: 0, signedIn: [], errors: [], timers: [] };
  let pending = null;
  let signInResult = () => Promise.resolve();
  const deps = {
    isSupported: async () => supported,
    fetchOffer: async () => {
      log.fetched += 1;
      return offers();
    },
    waitForPasskey: (options) =>
      new Promise((resolve, reject) => {
        pending = { options, resolve, reject };
      }),
    cancelCeremony: () => {
      log.cancelled += 1;
      const was = pending;
      pending = null;
      was?.reject(named('AbortError'));
    },
    signIn: (flowId, response) => {
      log.signedIn.push({ flowId, response });
      return signInResult();
    },
    onError: (error) => log.errors.push(error),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      log.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  };
  return {
    log,
    deps,
    get pending() {
      return pending;
    },
    pick: (response) => {
      const was = pending;
      pending = null;
      was.resolve(response);
    },
    fail: (error) => {
      const was = pending;
      pending = null;
      was.reject(error);
    },
    failSignIn: (error) => {
      signInResult = () => Promise.reject(error);
    },
  };
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  autofill.start();
  await tick();
  check('starting asks the server once and waits on the browser', h.log.fetched === 1 && h.pending !== null);

  h.pick({ id: 'cred' });
  await tick();
  check(
    'a chosen passkey goes to the same sign-in with its own flow',
    h.log.signedIn.length === 1 && h.log.signedIn[0].flowId === 'f1' && h.log.signedIn[0].response.id === 'cred',
  );
  check('a chosen passkey stops the refresh timer', h.log.timers[0].cleared === true);
  autofill.stop();
  check('stopping after the browser answered cancels nothing', h.log.cancelled === 0);
}

{
  const h = harness({ supported: false });
  createPasskeyAutofill(h.deps).start();
  await tick();
  check('an unsupported browser never asks the server', h.log.fetched === 0 && h.pending === null);
}

{
  const h = harness({ offers: () => ({ available: false }) });
  createPasskeyAutofill(h.deps).start();
  await tick();
  check('an offer the server declines starts no browser request', h.log.fetched === 1 && h.pending === null);
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  autofill.start();
  await tick();
  autofill.stop();
  await tick();
  check('stopping cancels the waiting browser request', h.log.cancelled === 1 && h.pending === null);
  check('stopping clears the refresh timer', h.log.timers[0].cleared === true);
  check('a cancelled request is not reported as an error', h.log.errors.length === 0);
  check('a cancelled request is not offered again on its own', h.log.fetched === 1);
  autofill.stop();
  check('stopping twice cancels once, never someone else’s ceremony', h.log.cancelled === 1);
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  autofill.start();
  autofill.stop();
  await tick();
  await tick();
  check('stopping before the offer arrives leaves no request behind', h.pending === null && h.log.timers.length === 0);
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  autofill.start();
  await tick();
  const first = h.pending;
  h.log.timers[0].run();
  await tick();
  await tick();
  check(
    'the refresh replaces the request before the challenge dies',
    h.log.timers[0].ms === AUTOFILL_REFRESH_MS && h.log.cancelled === 1 && h.log.fetched === 2 && h.pending !== first,
  );
  h.pick({ id: 'cred' });
  await tick();
  check('after a refresh the new flow is the one used', h.log.signedIn[0]?.flowId === 'f2');
  autofill.stop();
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  autofill.start();
  await tick();
  h.fail(named('AbortError'));
  await tick();
  check(
    'a request another ceremony replaced is dropped quietly, not retried',
    h.log.errors.length === 0 && h.log.fetched === 1,
  );
  autofill.stop();
  check('and stopping then does not cancel the ceremony that replaced it', h.log.cancelled === 0);
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  autofill.start();
  await tick();
  for (let i = 0; i < AUTOFILL_MAX_RETRIES + 2; i++) {
    if (h.pending) h.fail(named('NotAllowedError'));
    await tick();
    await tick();
  }
  check(
    'a browser timeout offers the list again, a bounded number of times',
    h.log.fetched === 1 + AUTOFILL_MAX_RETRIES && h.log.errors.length === 0,
    `fetched ${h.log.fetched}`,
  );
  autofill.stop();
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  h.failSignIn(Object.assign(new Error('401'), { response: { status: 401 } }));
  autofill.start();
  await tick();
  h.pick({ id: 'cred' });
  await tick();
  await tick();
  check('a refused passkey is reported to the page', h.log.errors.length === 1);
  check('and the list is offered again, with a new flow', h.log.fetched === 2 && h.pending !== null);
  autofill.stop();
}

{
  const h = harness();
  const autofill = createPasskeyAutofill(h.deps);
  let finishSignIn;
  h.deps.signIn = () =>
    new Promise((_resolve, reject) => {
      finishSignIn = reject;
    });
  autofill.start();
  await tick();
  h.pick({ id: 'cred' });
  await tick();
  autofill.stop();
  finishSignIn(new Error('late'));
  await tick();
  check('an answer that arrives after the page stopped is dropped', h.log.errors.length === 0 && h.log.fetched === 1);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
