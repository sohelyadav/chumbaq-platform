/**
 * Passkeys offered in the email field's autofill (WebAuthn conditional mediation).
 *
 * The browser holds one WebAuthn request at a time, and this one waits for as long as the
 * page is open, so everything else that starts a ceremony must call `stop` first or meet
 * "A request is already pending". Kept free of browser and React imports so the
 * sequencing can be checked under node (`passkey-autofill.check.mjs`).
 */

/** Before the server's challenge, five minutes, expires under a request still waiting. */
export const AUTOFILL_REFRESH_MS = 4 * 60_000;

/** A browser that rejects at once would otherwise be asked again in a loop. */
export const AUTOFILL_MAX_RETRIES = 3;

export type AutofillOffer<O> =
  | { available: false }
  | { available: true; flowId: string; options: O };

export interface PasskeyAutofillDeps<O, R> {
  isSupported: () => Promise<boolean>;
  fetchOffer: () => Promise<AutofillOffer<O>>;
  /** Resolves when someone picks a passkey from the autofill list. */
  waitForPasskey: (options: O) => Promise<R>;
  /** Aborts the browser's current ceremony, which `stop` only calls while it is ours. */
  cancelCeremony: () => void;
  /** The same verification the button uses. */
  signIn: (flowId: string, response: R) => Promise<void>;
  /** Only for a passkey someone chose; nothing they did not ask for is reported. */
  onError: (error: unknown) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface PasskeyAutofill {
  start: () => void;
  stop: () => void;
}

const errorName = (error: unknown) =>
  error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';

export function createPasskeyAutofill<O, R>(deps: PasskeyAutofillDeps<O, R>): PasskeyAutofill {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  // Every start and stop moves this on, and work from an earlier one then does nothing,
  // so an answer arriving after the page moved on is dropped rather than acted upon.
  let generation = 0;
  let waiting = false;
  let timer: unknown;
  let retries = 0;

  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  const stop = () => {
    generation += 1;
    clear();
    if (waiting) {
      waiting = false;
      deps.cancelCeremony();
    }
  };

  const retry = () => {
    retries += 1;
    if (retries <= AUTOFILL_MAX_RETRIES) void arm(false);
  };

  async function arm(fresh: boolean): Promise<void> {
    stop();
    if (fresh) retries = 0;
    const mine = generation;
    const current = () => mine === generation;

    let offer: AutofillOffer<O>;
    try {
      if (!(await deps.isSupported()) || !current()) return;
      offer = await deps.fetchOffer();
    } catch {
      // A failed request or a 429: the button still works, so nothing is shown.
      return;
    }
    if (!current() || !offer.available) return;

    timer = setTimer(() => {
      if (current()) void arm(true);
    }, AUTOFILL_REFRESH_MS);

    let response: R;
    waiting = true;
    try {
      response = await deps.waitForPasskey(offer.options);
    } catch (error) {
      if (!current()) return;
      waiting = false;
      clear();
      // A timeout or a dismissed sheet offers the list again. Anything else, above all an
      // AbortError from another ceremony replacing this one, leaves it to whoever did that.
      if (errorName(error) === 'NotAllowedError') retry();
      return;
    }
    if (!current()) return;
    waiting = false;
    clear();

    try {
      await deps.signIn(offer.flowId, response);
      retries = 0;
    } catch (error) {
      if (!current()) return;
      deps.onError(error);
      // The flow is spent either way, so the next attempt needs a new one.
      retry();
    }
  }

  return { start: () => void arm(true), stop };
}
