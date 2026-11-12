import type { ReauthResponse } from '@chumbaq/shared';
import { apiDelete, apiGet, apiPost } from './api';
import { noteFactorResetPending } from './factor-reset-pending';
import { noteStaffLinkPending } from './staff-link';
import { passkeyErrorMessage } from './passkeys';

export type SecondFactorMethod = 'webauthn' | 'totp' | 'recovery_code';

export interface FactorStatus {
  canEnrolTotp: boolean;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  canManageRecoveryCodes: boolean;
  methods: SecondFactorMethod[];
}

export interface TotpSetup {
  secret: string;
  uri: string;
}

export const getFactors = () => apiGet<FactorStatus>('/api/auth/factors');
export const setupTotp = () => apiPost<TotpSetup>('/api/auth/totp/setup');
export const confirmTotp = (code: string) =>
  apiPost<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', { code });
export const disableTotp = () => apiDelete<void>('/api/auth/totp');
export const regenerateRecoveryCodes = () =>
  apiPost<{ recoveryCodes: string[] }>('/api/auth/recovery-codes');

export async function reauthWithCode(kind: 'totp' | 'recovery-code', code: string): Promise<string> {
  const response = await apiPost<ReauthResponse>(`/api/auth/reauth/${kind}`, { code });
  noteFactorResetPending(response);
  noteStaffLinkPending(response);
  return response.accessToken;
}

/** The server's message when it sent one. Nothing here came from a browser passkey prompt. */
export function factorErrorMessage(error: unknown): string {
  const message = passkeyErrorMessage(error);
  return message.startsWith('Could not use that passkey')
    ? 'Something went wrong. Please try again.'
    : message;
}
