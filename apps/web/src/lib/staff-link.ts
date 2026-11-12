import type { StaffLinkPending } from '@chumbaq/shared';

/**
 * A password reset link support issued for this account (`admin:password-reset-link`).
 * The owner's notice sends them to `CANCEL_SUPPORT_LINK_PATH`, and the dashboard shows a
 * banner with a Cancel button while one is live (`staffLinkPending` from `/auth/me`).
 */
export const CANCEL_SUPPORT_LINK_PATH = '/account/cancel-support-link';

/**
 * Where sign-in may send someone back to. Only the cancel page: anything else read
 * from the address bar would make /login an open redirect.
 */
export function nextAfterSignIn(search: string): string | null {
  return new URLSearchParams(search).get('next') === CANCEL_SUPPORT_LINK_PATH ? CANCEL_SUPPORT_LINK_PATH : null;
}

/** The sign-in page for someone on `pathname`, keeping the way back to the cancel page. */
export function loginPathFor(pathname: string): string {
  return pathname === CANCEL_SUPPORT_LINK_PATH
    ? `/login?next=${encodeURIComponent(CANCEL_SUPPORT_LINK_PATH)}`
    : '/login';
}

/**
 * A sign-in voids every staff link. When that void failed the API says so
 * (`staffLinkPending`), and the banner shows until `/auth/me` says nothing is live.
 * Per tab, like the session, and not a secret: the banner asks the API for the state.
 */
const KEY = 'chumbaq_staff_link_pending';

const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Call with every sign-in or re-authentication response. */
export function noteStaffLinkPending(response: StaffLinkPending): void {
  if (response.staffLinkPending !== true) return;
  sessionStorage.setItem(KEY, '1');
  changed();
}

/** Once the API says nothing is live, or the owner has cancelled it. */
export function clearStaffLinkPending(): void {
  if (sessionStorage.getItem(KEY) === null) return;
  sessionStorage.removeItem(KEY);
  changed();
}

export function isStaffLinkPending(): boolean {
  return sessionStorage.getItem(KEY) === '1';
}

/** For `useSyncExternalStore`. */
export function subscribeStaffLinkPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
