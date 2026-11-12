import axios from 'axios';
import type { AdminImpersonationSession } from '@chumbaq/shared';
import { startImpersonation } from './auth';

/** The API's one answer to every failed exchange (impersonation-messages.ts). */
export const IMPERSONATION_LINK_INVALID_MESSAGE = 'This view-as link has expired or was already used.';

export const HANDOFF_PATH = '/impersonate';

/** 32 random bytes in base64url, exactly as the admin API makes them. */
const HANDOFF_FRAGMENT = /^#code=([A-Za-z0-9_-]{43})$/;

export function readHandoffCode(hash: string): string | null {
  return HANDOFF_FRAGMENT.exec(hash)?.[1] ?? null;
}

/**
 * Bare axios, not the dashboard's client: this must carry no bearer of the customer's
 * own (the staff member may be signed in here too) and a refusal must not set off a
 * refresh or a redirect to sign-in.
 */
export async function exchangeHandoff(code: string): Promise<AdminImpersonationSession> {
  const response = await axios.post(
    '/api/auth/impersonation/exchange',
    { code },
    { headers: { 'Content-Type': 'application/json', 'X-Chumbaq-Client': 'web' } },
  );
  const body = response.data as { data?: AdminImpersonationSession } | AdminImpersonationSession;
  return 'data' in body && body.data ? body.data : (body as AdminImpersonationSession);
}

function failureMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response) {
    const message = (error.response.data as { message?: unknown } | undefined)?.message;
    return typeof message === 'string' ? message : IMPERSONATION_LINK_INVALID_MESSAGE;
  }
  return 'Could not reach Chumbaq. Check your connection and start view-as again from the admin app.';
}

async function run(): Promise<string | null> {
  const code = readHandoffCode(window.location.hash);
  // Out of the address bar and history before anything else, used or not: the code is
  // single use, but a copy left in history or a screenshot helps nobody.
  window.history.replaceState(null, '', HANDOFF_PATH);
  if (!code) return IMPERSONATION_LINK_INVALID_MESSAGE;
  let session: AdminImpersonationSession;
  try {
    session = await exchangeHandoff(code);
  } catch (error) {
    return failureMessage(error);
  }
  startImpersonation(session);
  // A full load, so the tenant's view starts with nothing of anyone else's in the cache.
  window.location.replace('/projects');
  return null;
}

/** Once per page load: the fragment is gone after the first run, so a second would fail. */
let opening: Promise<string | null> | null = null;

/** Resolves with the message to show, or null once on the way to the tenant's dashboard. */
export function openHandoff(): Promise<string | null> {
  opening ??= run();
  return opening;
}
