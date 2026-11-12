interface TokenWindow {
  location: { pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void };
}

const fragmentParams = (win: Pick<TokenWindow, 'location'>) =>
  new URLSearchParams(win.location.hash.replace(/^#/, ''));

/**
 * From the fragment, which browsers never send, so the token stays out of server logs
 * and Referer headers. A `?token=` from an older link is not read: by the time this
 * runs the server has already seen it. Use through `useTokenFromUrl`, which also takes
 * it out of the address bar.
 */
export function readTokenFromUrl(win: Pick<TokenWindow, 'location'>): string | null {
  return fragmentParams(win).get('token');
}

/** Keeps the router's history state, the query and the rest of the fragment. No reload. */
export function removeTokenFromUrl(win: TokenWindow): void {
  const params = fragmentParams(win);
  if (!params.has('token')) return;

  params.delete('token');
  const rest = params.toString();
  win.history.replaceState(
    win.history.state,
    '',
    `${win.location.pathname}${win.location.search}${rest ? `#${rest}` : ''}`,
  );
}

/**
 * A prompt, never a gate. Hidden while impersonating, because staff looking through a
 * tenant's eyes can neither act on it nor should be nudged to, and a read-only session
 * would have its resend refused.
 */
export function shouldShowVerificationBanner(input: {
  user: { emailVerifiedAt?: string | null } | null;
  impersonating: boolean;
  dismissed: boolean;
}): boolean {
  return Boolean(input.user) && !input.user?.emailVerifiedAt && !input.impersonating && !input.dismissed;
}

/**
 * A 401 from one of these means the answer was wrong, not that a session has run out, so
 * it must stay on the form rather than be refreshed and sent back to the login page.
 */
export function isSignInAttempt(url: string | undefined): boolean {
  return Boolean(url && /^\/api\/auth\/(login|passkey)(\/|$)/.test(url));
}

const PENDING_VERIFICATION = 'chumbaq_pending_verification';

/**
 * A verify link needs the account's own session, so a signed-out click has to survive
 * going through sign-in. In this tab only, and useless without that account's password.
 */
export const pendingVerification = {
  keep: (storage: Pick<Storage, 'setItem'>, token: string) =>
    storage.setItem(PENDING_VERIFICATION, token),
  read: (storage: Pick<Storage, 'getItem'>) => storage.getItem(PENDING_VERIFICATION),
  clear: (storage: Pick<Storage, 'removeItem'>) => storage.removeItem(PENDING_VERIFICATION),
};
