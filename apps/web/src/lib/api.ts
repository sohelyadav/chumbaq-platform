import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import {
  endImpersonation,
  getEndedImpersonationTenantId,
  getImpersonation,
  canRefresh,
  forgetLegacyTokens,
  getToken,
  removeTokens,
  setTokens,
} from './auth';
import { isSignInAttempt } from './account-links';
import { sessionLimitLoginPath } from './session-limit';
// So a session that lapses on the cancel page signs in and comes back to it.
import { loginPathFor } from './staff-link';
import { toast } from '../components/ui/use-toast';
import { adminTenantUrl } from './admin-app';

const ACCOUNT_SUSPENDED = 'Account suspended';
const IMPERSONATION_READ_ONLY = 'Impersonation sessions are read-only';
/** RecentAuthGuard's refusal. Matched exactly, like the two above. */
const REAUTH_REQUIRED = 'Confirm it is you to continue.';

/** Set by `ReauthDialog`. Resolves with a new access token, rejects if cancelled. */
let reauthHandler: (() => Promise<string>) | null = null;

export function setReauthHandler(handler: (() => Promise<string>) | null): void {
  reauthHandler = handler;
}

type TrackedRequest = InternalAxiosRequestConfig & {
  _retry?: boolean;
  /** Has been through the prompt once, so a second refusal is an answer, not a question. */
  _reauthed?: boolean;
  /** Set when sent with an impersonation token, which may have expired by the response. */
  _impersonatedTenantId?: string;
};

function serverMessage(error: unknown): unknown {
  return (error as AxiosError<{ message?: unknown }>).response?.data?.message;
}

function isAccountSuspended(error: unknown): boolean {
  const { response } = error as AxiosError;
  return response?.status === 403 && serverMessage(error) === ACCOUNT_SUSPENDED;
}

function leaveImpersonation(tenantId: string): void {
  endImpersonation();
  window.location.assign(adminTenantUrl(tenantId));
}

const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
    // The API's lock against other sites using this browser's sign-in: see CLIENT_HEADER.
    'X-Chumbaq-Client': 'web',
  },
});

api.interceptors.request.use((config: TrackedRequest) => {
  const impersonation = getImpersonation();
  const token = getToken();
  if (impersonation) {
    config._impersonatedTenantId = impersonation.tenant.id;
  } else {
    const endedTenantId = getEndedImpersonationTenantId();
    if (endedTenantId && token) {
      window.location.assign(adminTenantUrl(endedTenantId));
      return Promise.reject(new axios.CanceledError('Impersonation session ended'));
    }
  }
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshing: Promise<string> | null = null;

/**
 * One at a time however many requests want it, since the server rotates the token. The
 * header is the API's second lock on using the cookie: see CLIENT_HEADER.
 */
export function refreshAccessToken(): Promise<string> {
  refreshing ??= axios
    .post('/api/auth/refresh', {}, { headers: { 'X-Chumbaq-Client': 'web' } })
    .then((response) => {
      const { accessToken } = response.data?.data || response.data;
      setTokens(accessToken);
      return accessToken as string;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * On page load, where the access token is gone by design. Only a refusal ends the session:
 * a network failure or a throttled reload should not sign anyone out.
 */
export async function restoreSession(): Promise<void> {
  forgetLegacyTokens();
  if (getToken() || !canRefresh()) return;
  try {
    await refreshAccessToken();
  } catch (error) {
    if (!axios.isAxiosError(error) || !error.response) return;
    if (isAccountSuspended(error)) {
      removeTokens();
      window.location.assign('/login?suspended=1');
    } else if (error.response.status === 401 || error.response.status === 403) {
      const limitPath = error.response.status === 401 ? sessionLimitLoginPath(serverMessage(error)) : null;
      removeTokens();
      if (limitPath) window.location.assign(limitPath);
    }
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    // No response: a network failure, or a request the interceptor above refused.
    if (!error.response) {
      return Promise.reject(error);
    }

    const originalRequest = error.config as TrackedRequest;
    const impersonatedTenantId =
      originalRequest._impersonatedTenantId ?? getImpersonation()?.tenant.id;

    if (impersonatedTenantId) {
      // An impersonation token has no refresh token behind it, and the way out
      // is back to the admin's own session rather than to the login page.
      if (error.response.status === 401 || isAccountSuspended(error)) {
        leaveImpersonation(impersonatedTenantId);
      } else if (
        error.response.status === 403 &&
        serverMessage(error) === IMPERSONATION_READ_ONLY
      ) {
        toast({
          title: 'Read-only session',
          description: IMPERSONATION_READ_ONLY,
          variant: 'destructive',
        });
      }
      return Promise.reject(error);
    }

    if (
      error.response.status === 403 &&
      serverMessage(error) === REAUTH_REQUIRED &&
      reauthHandler &&
      !originalRequest._reauthed
    ) {
      originalRequest._reauthed = true;
      let accessToken: string;
      try {
        accessToken = await reauthHandler();
      } catch {
        return Promise.reject(error);
      }
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    }

    // A refused login stays on the form, which shows the server's message.
    if (isAccountSuspended(error) && !isSignInAttempt(originalRequest.url)) {
      removeTokens();
      window.location.assign('/login?suspended=1');
      return Promise.reject(error);
    }

    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      originalRequest.url !== '/api/auth/refresh' &&
      !isSignInAttempt(originalRequest.url)
    ) {
      if (!canRefresh()) {
        removeTokens();
        if (window.location.pathname !== '/login') {
          window.location.href = loginPathFor(window.location.pathname);
        }
        return Promise.reject(error);
      }

      originalRequest._retry = true;
      try {
        const accessToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        const limitPath =
          axios.isAxiosError(refreshError) && refreshError.response?.status === 401
            ? sessionLimitLoginPath(serverMessage(refreshError))
            : null;
        removeTokens();
        if (isAccountSuspended(refreshError)) {
          window.location.assign('/login?suspended=1');
        } else if (limitPath) {
          window.location.assign(limitPath);
        } else if (window.location.pathname !== '/login') {
          window.location.href = loginPathFor(window.location.pathname);
        }
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// The backend wraps all responses in { data: T } via TransformInterceptor.
// Axios also returns response.data, so we unwrap: axios.data -> { data: T } -> T
function unwrap<T>(responseData: unknown): T {
  if (
    responseData &&
    typeof responseData === 'object' &&
    'data' in responseData &&
    !('meta' in responseData)
  ) {
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

export async function apiPut<T>(url: string, data?: unknown): Promise<T> {
  const response = await api.put(url, data);
  return unwrap<T>(response.data);
}

export async function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  const response = await api.patch(url, data);
  return unwrap<T>(response.data);
}

export async function apiDelete<T>(url: string): Promise<T> {
  const response = await api.delete(url);
  return unwrap<T>(response.data);
}

export default api;
