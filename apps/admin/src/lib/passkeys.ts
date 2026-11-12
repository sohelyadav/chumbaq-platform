import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import axios from 'axios';
import type { StaffEnrolled, StaffReauthenticated, StaffSignedIn } from '@chumbaq/shared';
import { apiPost } from './api';

type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** The API's message when there is one; the browser's own errors say nothing useful. */
export function errorMessage(error: unknown, fallback = 'That did not work. Please try again.'): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'Could not reach the admin API. Check your connection and try again.';
    const message = (error.response.data as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  }
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'The passkey request was cancelled or timed out. Please try again.';
  }
  if (error instanceof Error && error.name === 'InvalidStateError') {
    return 'This device already holds a passkey for this account.';
  }
  if (error instanceof Error && error.message.includes('does not support WebAuthn')) {
    return 'This browser does not support passkeys.';
  }
  return fallback;
}

/** With no email or password: the browser offers the staff passkeys it holds for this site. */
export async function passkeySignIn(): Promise<StaffSignedIn> {
  const { ceremonyId, options } = await apiPost<{ ceremonyId: string; options: AuthenticationOptions }>(
    '/api/staff/auth/passkey/options',
    {},
  );
  const response = await startAuthentication({ optionsJSON: options });
  return apiPost<StaffSignedIn>('/api/staff/auth/passkey/verify', { ceremonyId, response });
}

/** After a correct password. */
export async function passkeySecondFactor(handle: string): Promise<StaffSignedIn> {
  const { options } = await apiPost<{ options: AuthenticationOptions }>('/api/staff/auth/login/passkey/options', {
    handle,
  });
  const response = await startAuthentication({ optionsJSON: options });
  return apiPost<StaffSignedIn>('/api/staff/auth/login/passkey/verify', { handle, response });
}

export async function passkeyReauth(): Promise<string> {
  const { options } = await apiPost<{ options: AuthenticationOptions }>('/api/staff/auth/reauth/passkey/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  const { accessToken } = await apiPost<StaffReauthenticated>('/api/staff/auth/reauth/passkey/verify', { response });
  return accessToken;
}

export async function addStaffPasskey(name: string): Promise<StaffEnrolled> {
  const { options } = await apiPost<{ options: RegistrationOptions }>('/api/staff/auth/passkeys/options', {});
  const response = await startRegistration({ optionsJSON: options });
  return apiPost<StaffEnrolled>('/api/staff/auth/passkeys', { response, name });
}
