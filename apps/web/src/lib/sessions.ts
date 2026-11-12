import type { AccountActivityResponse, AccountActivityType, AccountSession } from '@chumbaq/shared';
import { apiDelete, apiGet } from './api';

export const SESSIONS_QUERY_KEY = ['account-sessions'];
export const ACTIVITY_QUERY_KEY = ['account-activity'];

export const listSessions = () => apiGet<AccountSession[]>('/api/auth/sessions');
export const signOutSession = (id: string) => apiDelete<void>(`/api/auth/sessions/${id}`);
export const signOutOtherSessions = () => apiDelete<void>('/api/auth/sessions');
export const getActivity = () => apiGet<AccountActivityResponse>('/api/auth/activity');

export const ACTIVITY_LABELS: Record<AccountActivityType, string> = {
  'register.succeeded': 'Account created',
  'login.succeeded': 'Signed in',
  'login.failed': 'Sign-in attempt failed',
  'passkey.added': 'Passkey added',
  'passkey.removed': 'Passkey removed',
  'totp.enabled': 'Authenticator app turned on',
  'totp.disabled': 'Authenticator app turned off',
  'recovery_code.used': 'Recovery code used',
  'recovery_codes.regenerated': 'New recovery codes made',
  'refresh.reuse_detected': 'A device was signed out because its sign-in was copied',
  'logout.all': 'Signed out everywhere',
  'session.revoked': 'Signed out another device',
  'sessions.revoked_others': 'Signed out all other devices',
  'password.changed': 'Password changed',
  'password.reset': 'Password reset by email',
  'password.reset_by_team': 'Password reset by your team',
  'email.verified': 'Email address confirmed',
  'factors_reset.requested': 'Support was asked to remove your second factors',
  'factors_reset.cancelled': 'Removal of your second factors cancelled',
  'factors_reset.completed': 'Second factors removed by support',
};

/** Shown in red: worth a second look if it was not you. */
export const ALERT_TYPES = new Set<AccountActivityType>([
  'login.failed',
  'refresh.reuse_detected',
  'factors_reset.requested',
  'factors_reset.completed',
]);

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
