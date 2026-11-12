/**
 * Sessions end a fixed time after sign-in (SESSION_MAX_AGE on the API), however often
 * they refresh. The refresh cookie expires with the session, so by then the API cannot
 * say why a refresh failed. The access token says when the end is, and it is noted
 * here so the login page can explain instead of the person just finding themselves out.
 */

/** The API's 401 for a session past its limit. Matched exactly, like the messages in `api.ts`. */
export const SESSION_EXPIRED_MESSAGE = 'Session reached its maximum length';

/** Not a secret: when this browser's session ends, and how long sessions last. */
const SESSION_LIMIT_KEY = 'chumbaq_session_limit';

/** Clocks differ, and a refresh a little early is still a session at its end. */
const CLOCK_SLACK_MS = 60_000;

const LABEL = /^(\d{1,4})-(day|hour|minute)$/;

interface SessionLimit {
  endsAt: number;
  maxAgeSeconds: number;
}

function readClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Notes the session's end from a newly issued access token. A token without it, such as
 * one from re-authenticating, leaves the note as it was.
 */
export function rememberSessionLimit(accessToken: string): void {
  const claims = readClaims(accessToken);
  const end = claims?.session_exp;
  const maxAge = claims?.session_max_age;
  if (typeof end !== 'number' || typeof maxAge !== 'number') return;
  const limit: SessionLimit = { endsAt: end * 1000, maxAgeSeconds: maxAge };
  localStorage.setItem(SESSION_LIMIT_KEY, JSON.stringify(limit));
}

export function forgetSessionLimit(): void {
  localStorage.removeItem(SESSION_LIMIT_KEY);
}

function readSessionLimit(): SessionLimit | null {
  try {
    const limit = JSON.parse(localStorage.getItem(SESSION_LIMIT_KEY) ?? 'null') as SessionLimit | null;
    return typeof limit?.endsAt === 'number' && typeof limit.maxAgeSeconds === 'number' ? limit : null;
  } catch {
    return null;
  }
}

/** "30-day", "12-hour", in the largest whole unit. */
export function sessionLimitLabel(maxAgeSeconds: number): string | null {
  const minutes = Math.floor(maxAgeSeconds / 60);
  if (minutes < 1) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/**
 * Where to send someone whose refresh was just refused, if the reason was the session
 * limit, and null otherwise. Call before `removeTokens`, which forgets the note.
 */
export function sessionLimitLoginPath(serverMessage: unknown): string | null {
  const limit = readSessionLimit();
  const reached =
    serverMessage === SESSION_EXPIRED_MESSAGE ||
    (limit !== null && Date.now() >= limit.endsAt - CLOCK_SLACK_MS);
  if (!reached) return null;
  const label = limit ? sessionLimitLabel(limit.maxAgeSeconds) : null;
  return `/login?sessionLimit=${label ?? '1'}`;
}

/**
 * What the login page may say about `?sessionLimit=`. Only a label of the shape made
 * above is shown, so a crafted link cannot put its own words on the sign-in page.
 */
export function sessionLimitNotice(param: string | null): string | null {
  if (param === null) return null;
  const match = LABEL.exec(param);
  const limit = match && Number(match[1]) > 0 ? `${match[1]}-${match[2]} ` : '';
  return `You were signed out because your session reached its ${limit}limit. Sign in again to continue.`;
}
