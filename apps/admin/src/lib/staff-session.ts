import type { StaffSessionInfo } from '@chumbaq/shared';
import { STAFF_SESSION_ENDED_MESSAGE, STAFF_SESSION_IDLE_MESSAGE } from './messages';

/**
 * Not a secret: says only that a refresh is worth trying on load, since script cannot see
 * the HttpOnly cookie. Per tab (sessionStorage), so closing the tab forgets it.
 */
const SIGNED_IN_NOTE_KEY = 'chumbaq_staff_signed_in';

/**
 * Memory only, never storage: a script injected later finds nothing to take, and a page
 * load starts with no token and asks the cookie for one.
 */
let accessToken: string | null = null;
let session: StaffSessionInfo | null = null;

export function setStaffToken(token: string, info: StaffSessionInfo): void {
  accessToken = token;
  session = info;
  // An enrolment-only session gets no cookie, so a reload has nothing to restore.
  if (info.enrolmentOnly) sessionStorage.removeItem(SIGNED_IN_NOTE_KEY);
  else sessionStorage.setItem(SIGNED_IN_NOTE_KEY, '1');
}

/** After a re-authentication, which returns a token for the same session. */
export function replaceStaffAccessToken(token: string): void {
  accessToken = token;
}

export function getStaffToken(): string | null {
  return accessToken;
}

export function getStaffSession(): StaffSessionInfo | null {
  return session;
}

export function clearStaffToken(): void {
  accessToken = null;
  session = null;
  sessionStorage.removeItem(SIGNED_IN_NOTE_KEY);
}

export function hasSignedInNote(): boolean {
  return sessionStorage.getItem(SIGNED_IN_NOTE_KEY) !== null;
}

export type SignOutReason = 'idle' | 'ended';

/** Which of the API's two "your session is over" answers this is, if either. */
export function signOutReason(error: unknown): SignOutReason | null {
  const response = (error as { response?: { status?: number; data?: { message?: unknown } } } | null)?.response;
  if (response?.status !== 401) return null;
  const message = response.data?.message;
  if (message === STAFF_SESSION_IDLE_MESSAGE) return 'idle';
  if (message === STAFF_SESSION_ENDED_MESSAGE) return 'ended';
  return null;
}
