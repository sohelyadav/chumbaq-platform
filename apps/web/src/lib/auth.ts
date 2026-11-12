import type { AdminImpersonationSession } from '@chumbaq/shared';
import { forgetSessionLimit, rememberSessionLimit } from './session-limit';

/**
 * Where these lived before the refresh token moved to an HttpOnly cookie. The API no
 * longer takes a token from anywhere but the cookie, so they are never read, only removed,
 * so that no browser keeps a readable copy of a token.
 */
const LEGACY_ACCESS_TOKEN_KEY = 'chumbaq_access_token';
const LEGACY_REFRESH_TOKEN_KEY = 'chumbaq_refresh_token';
/** Not a secret: says only that a refresh is worth trying on load, since script cannot see the cookie. */
const SIGNED_IN_KEY = 'chumbaq_signed_in';
const IMPERSONATION_KEY = 'chumbaq_impersonation';

/**
 * The tenant whose impersonation session ended during this page load, if any.
 *
 * Deliberately in memory, so a full navigation clears it. It exists because a
 * session usually ends part-way through handling a failure: the API interceptor
 * ends it on a 401 and rejects, and `use-auth` then catches that rejection and
 * calls `removeTokens()`. By then nothing says "impersonating" any more, and
 * without this that call would delete the admin's own tokens.
 */
let endedTenantId: string | null = null;

/**
 * Held in memory only, so a script injected later finds nothing in storage, and a page
 * load starts with nothing and asks for a new one with the cookie.
 */
let accessToken: string | null = null;

function clearImpersonation(tenantId: string): void {
  sessionStorage.removeItem(IMPERSONATION_KEY);
  endedTenantId = tenantId;
}

/** The live session, or null. A session past its expiry is ended by reading it. */
function readImpersonation(): AdminImpersonationSession | null {
  const raw = sessionStorage.getItem(IMPERSONATION_KEY);
  if (!raw) return null;

  let session: AdminImpersonationSession | null = null;
  try {
    session = JSON.parse(raw) as AdminImpersonationSession;
  } catch {
    // Handled below, the same as a parseable record with missing fields.
  }
  if (!session?.accessToken || !session.tenant?.id) {
    sessionStorage.removeItem(IMPERSONATION_KEY);
    return null;
  }
  // Written so an unparseable expiry (NaN) counts as expired.
  if (!(Date.parse(session.expiresAt) > Date.now())) {
    clearImpersonation(session.tenant.id);
    return null;
  }
  return session;
}

/**
 * Impersonation lives in `sessionStorage`, so it is per-tab and ends with the
 * tab. The admin's own tokens stay untouched in `localStorage` throughout.
 * Callers must follow this with a full page load, so that no admin data
 * survives in the query cache.
 */
export function startImpersonation(session: AdminImpersonationSession): void {
  endedTenantId = null;
  sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify(session));
}

export function endImpersonation(): void {
  const session = readImpersonation();
  if (session) clearImpersonation(session.tenant.id);
}

export function getImpersonation(): Pick<AdminImpersonationSession, 'tenant' | 'expiresAt'> | null {
  const session = readImpersonation();
  return session ? { tenant: session.tenant, expiresAt: session.expiresAt } : null;
}

/**
 * Set between a session ending and the page navigating away. Whatever is on
 * screen still belongs to the tenant, so requests made from it must not go out
 * under the admin's token, which is what `getToken()` now returns.
 */
export function getEndedImpersonationTenantId(): string | null {
  readImpersonation();
  return endedTenantId;
}

export function getToken(): string | null {
  return readImpersonation()?.accessToken ?? accessToken;
}

/** Whether a refresh is worth trying. Never while impersonating, which has no refresh side. */
export function canRefresh(): boolean {
  if (readImpersonation()) return false;
  return localStorage.getItem(SIGNED_IN_KEY) !== null;
}

/** On page load, since someone signed in from before the cookie may never sign in again. */
export function forgetLegacyTokens(): void {
  localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
}

export function setTokens(newAccessToken: string): void {
  // Ignored while impersonating: a session's token only ever comes from
  // `startImpersonation`, and these two are not the tenant's.
  if (readImpersonation()) return;
  endedTenantId = null;
  accessToken = newAccessToken;
  localStorage.setItem(SIGNED_IN_KEY, '1');
  rememberSessionLimit(newAccessToken);
  forgetLegacyTokens();
}

export function removeTokens(): void {
  const session = readImpersonation();
  if (session) {
    clearImpersonation(session.tenant.id);
    return;
  }
  if (endedTenantId) return;
  accessToken = null;
  localStorage.removeItem(SIGNED_IN_KEY);
  forgetSessionLimit();
  forgetLegacyTokens();
}
