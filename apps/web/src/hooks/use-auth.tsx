import {
  finishPasskeySignIn,
  passkeySecondFactor,
  passkeySignIn,
  type AuthenticationResponse,
} from '@/lib/passkeys';
import type { SecondFactorMethod } from '@/lib/totp';
import type { FactorResetPending, StaffLinkPending } from '@chumbaq/shared';
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost, restoreSession } from '@/lib/api';
import { setTokens, removeTokens, getToken, getImpersonation } from '@/lib/auth';
import { clearFactorResetPending, noteFactorResetPending } from '@/lib/factor-reset-pending';
import { clearStaffLinkPending, noteStaffLinkPending } from '@/lib/staff-link';

interface User {
  id: string;
  email: string;
  name: string;
  /** Only shows a link to the admin app, a separate site with its own staff sign-in. */
  isSuperAdmin?: boolean;
  /** Null until the address is confirmed. Nothing is refused on it yet. */
  emailVerifiedAt?: string | null;
}

interface SignedIn extends FactorResetPending, StaffLinkPending {
  user: User;
  tokens: { accessToken: string };
}

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Null when signed in; otherwise what the second step needs. */
  login: (
    email: string,
    password: string,
  ) => Promise<{ handle: string; methods: SecondFactorMethod[] } | null>;
  completeWithPasskey: (handle: string) => Promise<void>;
  completeWithCode: (handle: string, kind: 'totp' | 'recovery-code', code: string) => Promise<void>;
  loginWithPasskey: () => Promise<void>;
  /** For a passkey chosen from the email field's autofill. */
  completePasskeySignIn: (flowId: string, response: AuthenticationResponse) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  /** Then to `to`, the sign-in page by default. */
  logout: (to?: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    await restoreSession();
    const token = getToken();
    if (!token) {
      setIsLoading(false);
      return;
    }
    try {
      const data = await apiGet<User>('/api/auth/me');
      setUser(data);
    } catch {
      removeTokens();
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const signedIn = useCallback((data: SignedIn) => {
    setTokens(data.tokens.accessToken);
    noteFactorResetPending(data);
    noteStaffLinkPending(data);
    setUser(data.user);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiPost<
      SignedIn | { requiresSecondFactor: true; handle: string; methods: SecondFactorMethod[] }
    >(
      '/api/auth/login',
      { email, password },
    );
    if ('requiresSecondFactor' in data) return { handle: data.handle, methods: data.methods };
    signedIn(data);
    return null;
  }, []);

  const completeWithPasskey = useCallback(async (handle: string) => {
    const data = await passkeySecondFactor<SignedIn>(handle);
    signedIn(data);
  }, []);

  const completeWithCode = useCallback(
    async (handle: string, kind: 'totp' | 'recovery-code', code: string) => {
      const data = await apiPost<SignedIn>(`/api/auth/login/${kind}`, { handle, code });
      signedIn(data);
    },
    [],
  );

  const loginWithPasskey = useCallback(async () => {
    const data = await passkeySignIn<SignedIn>();
    signedIn(data);
  }, []);

  const completePasskeySignIn = useCallback(
    async (flowId: string, response: AuthenticationResponse) => {
      const data = await finishPasskeySignIn<SignedIn>(flowId, response);
      signedIn(data);
    },
    [],
  );

  const register = useCallback(async (email: string, password: string, name: string) => {
    const data = await apiPost<{
      user: User;
      tokens: { accessToken: string };
    }>('/api/auth/register', { email, password, name });
    signedIn(data);
  }, []);

  const logout = useCallback(async (to = '/login') => {
    // Ends this device's session on the server, so its refresh token dies too. A
    // view-as session has none, and an unreachable server must not trap the user.
    if (!getImpersonation()) {
      await Promise.race([
        apiPost('/api/auth/logout').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    removeTokens();
    clearFactorResetPending();
    clearStaffLinkPending();
    setUser(null);
    window.location.href = to;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        completeWithPasskey,
        completeWithCode,
        loginWithPasskey,
        completePasskeySignIn,
        register,
        logout,
        refreshUser: fetchUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

import { useMutation } from '@tanstack/react-query';
import { apiPatch } from '@/lib/api';

export function useUpdatePassword() {
  return useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      apiPatch('/api/users/me/password', data),
  });
}
