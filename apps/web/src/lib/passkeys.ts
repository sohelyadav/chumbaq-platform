import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import axios from 'axios';
import type { ReauthResponse } from '@chumbaq/shared';
import { apiDelete, apiGet, apiPost, setReauthHandler } from './api';
import { noteFactorResetPending } from './factor-reset-pending';
import { noteStaffLinkPending } from './staff-link';
import type { AutofillOffer, PasskeyAutofillDeps } from './passkey-autofill';

export interface PasskeySummary {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyList {
  canEnrol: boolean;
  passkeys: PasskeySummary[];
}

type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** The browser's own errors say nothing useful to a person. */
export function passkeyErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') return message;
  }
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'The passkey request was cancelled or timed out. Please try again.';
  }
  if (error instanceof Error && error.message.includes('does not support WebAuthn')) {
    return 'This browser does not support passkeys.';
  }
  return 'Could not use that passkey. Please try again.';
}

/** After a correct password. */
export async function passkeySecondFactor<T>(handle: string): Promise<T> {
  const options = await apiPost<AuthenticationOptions>('/api/auth/login/passkey/options', { handle });
  const response = await startAuthentication({ optionsJSON: options });
  return apiPost<T>('/api/auth/login/passkey/verify', { handle, response });
}

type AuthenticationResponse = Awaited<ReturnType<typeof startAuthentication>>;

/** The button and autofill both finish here, so both sign in under the same rules. */
export const finishPasskeySignIn = <T>(flowId: string, response: AuthenticationResponse) =>
  apiPost<T>('/api/auth/passkey/verify', { flowId, response });

/** With no email or password: the browser offers the passkeys it holds for this site. */
export async function passkeySignIn<T>(): Promise<T> {
  const { flowId, options } = await apiPost<{ flowId: string; options: AuthenticationOptions }>(
    '/api/auth/passkey/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  return finishPasskeySignIn<T>(flowId, response);
}

/** The browser side of `createPasskeyAutofill`, apart from what signing in does. */
export const passkeyAutofillBrowser: Pick<
  PasskeyAutofillDeps<AuthenticationOptions, AuthenticationResponse>,
  'isSupported' | 'fetchOffer' | 'waitForPasskey' | 'cancelCeremony'
> = {
  isSupported: browserSupportsWebAuthnAutofill,
  fetchOffer: () => apiPost<AutofillOffer<AuthenticationOptions>>('/api/auth/passkey/autofill-options'),
  waitForPasskey: (options) => startAuthentication({ optionsJSON: options, useBrowserAutofill: true }),
  cancelCeremony: () => WebAuthnAbortService.cancelCeremony(),
};

export type { AuthenticationResponse };

export async function passkeyReauth(): Promise<string> {
  const options = await apiPost<AuthenticationOptions>('/api/auth/reauth/passkey/options');
  const response = await startAuthentication({ optionsJSON: options });
  const verified = await apiPost<ReauthResponse>('/api/auth/reauth/passkey/verify', { response });
  noteFactorResetPending(verified);
  noteStaffLinkPending(verified);
  return verified.accessToken;
}

export const listPasskeys = () => apiGet<PasskeyList>('/api/auth/passkeys');

/** A tenant's first key comes with recovery codes, shown this once. */
export async function addPasskey(
  name: string,
): Promise<PasskeySummary & { recoveryCodes?: string[] }> {
  const options = await apiPost<RegistrationOptions>('/api/auth/passkeys/options');
  const response = await startRegistration({ optionsJSON: options });
  return apiPost('/api/auth/passkeys', { response, name });
}

export const removePasskey = (id: string) => apiDelete<void>(`/api/auth/passkeys/${id}`);

export { setReauthHandler };
