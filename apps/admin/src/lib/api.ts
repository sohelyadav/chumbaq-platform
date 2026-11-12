import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { StaffRefreshed } from '@chumbaq/shared';
import { REAUTH_REQUIRED_MESSAGE, STAFF_ENROLMENT_ONLY_MESSAGE } from './messages';
import {
  clearStaffToken,
  getStaffToken,
  hasSignedInNote,
  setStaffToken,
  signOutReason,
  type SignOutReason,
} from './staff-session';

export const REFRESH_URL = '/api/staff/auth/session/refresh';

/**
 * Sign-in steps answer 401 for a wrong password, code or key. That is the form's to
 * show, not a reason to refresh a session that does not exist yet.
 */
const SIGN_IN_URLS = [
  '/api/staff/auth/login',
  '/api/staff/auth/passkey/options',
  '/api/staff/auth/passkey/verify',
];

function isSignInAttempt(url: string | undefined): boolean {
  return !!url && SIGN_IN_URLS.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
}

/** Set by `ReauthDialog`. Resolves with a new access token, rejects if cancelled. */
let reauthHandler: (() => Promise<string>) | null = null;

export function setReauthHandler(handler: (() => Promise<string>) | null): void {
  reauthHandler = handler;
}

/**
 * In-app navigation, set by the router. `/enrol` must not be a full page load: an
 * enrolment-only session has no cookie, so its token would be lost with the page.
 */
let navigate: (path: string) => void = (path) => window.location.assign(path);

export function setNavigator(next: (path: string) => void): void {
  navigate = next;
}

/** A full load, so nothing of the old session stays in the query cache. */
function signOutTo(reason: SignOutReason): void {
  clearStaffToken();
  window.location.assign(`/sign-in?reason=${reason}`);
}

type TrackedRequest = InternalAxiosRequestConfig & {
  _retry?: boolean;
  /** Has been through the prompt once, so a second refusal is an answer, not a question. */
  _reauthed?: boolean;
};

function serverMessage(error: unknown): unknown {
  return (error as AxiosError<{ message?: unknown }>).response?.data?.message;
}

const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
    // The API's lock on the routes that set or read the staff cookie: see CLIENT_HEADER.
    'X-Chumbaq-Client': 'admin',
  },
});

api.interceptors.request.use((config) => {
  const token = getStaffToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshing: Promise<string> | null = null;

/** One at a time however many requests want it, since the server rotates the cookie. */
export function refreshStaffSession(): Promise<string> {
  refreshing ??= api
    .post(REFRESH_URL, {})
    .then((response) => {
      const body = unwrap<StaffRefreshed>(response.data);
      setStaffToken(body.accessToken, body.session);
      return body.accessToken;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export type RestoreOutcome = 'restored' | 'none' | 'unreachable' | SignOutReason;

/**
 * On page load, where the access token is gone by design. Only a refusal ends the
 * session: an outage or a throttled reload should not sign anyone out. Navigates nowhere,
 * so the caller can show why.
 */
export async function restoreStaffSession(): Promise<RestoreOutcome> {
  if (getStaffToken()) return 'restored';
  if (!hasSignedInNote()) return 'none';
  try {
    await refreshStaffSession();
    return 'restored';
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 401 || status === 403) {
      clearStaffToken();
      return signOutReason(error) ?? 'ended';
    }
    return 'unreachable';
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    if (!error.response) return Promise.reject(error);
    const original = error.config as TrackedRequest;
    const { status } = error.response;
    const message = serverMessage(error);

    if (status === 403 && message === REAUTH_REQUIRED_MESSAGE && reauthHandler && !original._reauthed) {
      original._reauthed = true;
      let token: string;
      try {
        token = await reauthHandler();
      } catch {
        return Promise.reject(error);
      }
      original.headers.Authorization = `Bearer ${token}`;
      return api(original);
    }

    if (status === 403 && message === STAFF_ENROLMENT_ONLY_MESSAGE) {
      navigate('/enrol');
      return Promise.reject(error);
    }

    if (status === 401 && !original._retry && original.url !== REFRESH_URL && !isSignInAttempt(original.url)) {
      original._retry = true;
      try {
        const token = await refreshStaffSession();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch (refreshError) {
        const refused = axios.isAxiosError(refreshError) ? refreshError.response?.status : undefined;
        if (refused === 401 || refused === 403) signOutTo(signOutReason(refreshError) ?? 'ended');
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  },
);

// The API wraps every response in { data: T } (TransformInterceptor); lists add `meta`
// and are returned whole.
export function unwrap<T>(responseData: unknown): T {
  if (responseData && typeof responseData === 'object' && 'data' in responseData && !('meta' in responseData)) {
    return (responseData as { data: T }).data;
  }
  return responseData as T;
}

export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const response = await api.get(url, { params });
  return unwrap<T>(response.data);
}

export async function apiPost<T>(url: string, data?: unknown): Promise<T> {
  const response = await api.post(url, data);
  return unwrap<T>(response.data);
}

export async function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  const response = await api.patch(url, data);
  return unwrap<T>(response.data);
}

export async function apiPut<T>(url: string, data?: unknown): Promise<T> {
  const res = await api.put(url, data);
  return unwrap<T>(res.data);
}

export async function apiDelete<T>(url: string): Promise<T> {
  const response = await api.delete(url);
  return unwrap<T>(response.data);
}

export default api;
