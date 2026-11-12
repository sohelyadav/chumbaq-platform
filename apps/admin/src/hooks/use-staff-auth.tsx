import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { StaffEnrolmentStarted, StaffProfile, StaffSignedIn } from '@chumbaq/shared';
import { apiGet, apiPost, restoreStaffSession } from '@/lib/api';
import { clearStaffToken, setStaffToken, type SignOutReason } from '@/lib/staff-session';

type Status = 'loading' | 'signed_out' | 'signed_in' | 'unreachable';

interface StaffAuthValue {
  status: Status;
  profile: StaffProfile | null;
  /** Why the page load found no session, for the sign-in page to say. */
  endedBecause: SignOutReason | null;
  /** After a sign-in step that returned a token: a full session or an enrolment-only one. */
  begin: (result: StaffSignedIn | StaffEnrolmentStarted) => Promise<StaffProfile>;
  /** Forgets the session in this tab without asking the API (it has ended already). */
  forget: () => void;
  signOut: () => Promise<void>;
  retry: () => void;
  reloadProfile: () => Promise<void>;
}

const StaffAuthContext = createContext<StaffAuthValue | null>(null);

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [endedBecause, setEndedBecause] = useState<SignOutReason | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      const outcome = await restoreStaffSession();
      if (!live) return;
      if (outcome === 'unreachable') return setStatus('unreachable');
      if (outcome !== 'restored') {
        setEndedBecause(outcome === 'none' ? null : outcome);
        return setStatus('signed_out');
      }
      try {
        const me = await apiGet<StaffProfile>('/api/staff/auth/me');
        if (!live) return;
        setProfile(me);
        setStatus('signed_in');
      } catch {
        // A refused session has already been sent to sign-in by the API client.
        if (live) setStatus('unreachable');
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  const begin = useCallback(async (result: StaffSignedIn | StaffEnrolmentStarted) => {
    setStaffToken(result.accessToken, result.session);
    const me = await apiGet<StaffProfile>('/api/staff/auth/me');
    setProfile(me);
    setEndedBecause(null);
    setStatus('signed_in');
    return me;
  }, []);

  const forget = useCallback(() => {
    clearStaffToken();
    setProfile(null);
    setStatus('signed_out');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiPost('/api/staff/auth/session/logout');
    } catch {
      // Signing out of this tab must work even if the API cannot be reached. The session
      // then ends on its own at the idle timeout.
    }
    clearStaffToken();
    // A full load, so nothing of the session stays in the query cache.
    window.location.assign('/sign-in');
  }, []);

  const reloadProfile = useCallback(async () => {
    setProfile(await apiGet<StaffProfile>('/api/staff/auth/me'));
  }, []);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);

  return (
    <StaffAuthContext.Provider
      value={{ status, profile, endedBecause, begin, forget, signOut, retry, reloadProfile }}
    >
      {children}
    </StaffAuthContext.Provider>
  );
}

export function useStaffAuth(): StaffAuthValue {
  const context = useContext(StaffAuthContext);
  if (!context) throw new Error('useStaffAuth must be used within StaffAuthProvider');
  return context;
}
