import type { FactorResetPending } from '@chumbaq/shared';

/**
 * Signing in with a second factor cancels a staff reset of the account's factors. When
 * that cancel failed, the API says so (`factorResetPending`), and the reset banner is
 * shown on every page, not only in settings, until the owner has dealt with it. Per tab,
 * like the session, and not a secret: the banner asks the API for the real state.
 */
const KEY = 'chumbaq_factor_reset_pending';

const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Call with every sign-in or re-authentication response. */
export function noteFactorResetPending(response: FactorResetPending): void {
  if (response.factorResetPending !== true) return;
  sessionStorage.setItem(KEY, '1');
  changed();
}

/** Once the API says nothing is waiting, or the owner has cancelled it. */
export function clearFactorResetPending(): void {
  if (sessionStorage.getItem(KEY) === null) return;
  sessionStorage.removeItem(KEY);
  changed();
}

export function isFactorResetPending(): boolean {
  return sessionStorage.getItem(KEY) === '1';
}

/** For `useSyncExternalStore`. */
export function subscribeFactorResetPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
