import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPost } from '@/lib/api';
import type { ReauthResponse } from '@chumbaq/shared';
import { setTokens } from '@/lib/auth';
import { noteFactorResetPending } from '@/lib/factor-reset-pending';
import { noteStaffLinkPending } from '@/lib/staff-link';
import { passkeyErrorMessage, passkeyReauth, setReauthHandler } from '@/lib/passkeys';
import { getFactors, reauthWithCode, SecondFactorMethod } from '@/lib/totp';
import { FactorCodeForm } from '@/components/factor-code-form';

interface Pending {
  resolve: (accessToken: string) => void;
  reject: (reason: Error) => void;
}

/**
 * Answers `RecentAuthGuard` wherever it comes from: the API client waits on this, then
 * resends what was refused, so no page has to know about it. An account with a second
 * factor must use it, since the server will not take a password for it.
 */
export function ReauthDialog() {
  const pending = useRef<Pending[]>([]);
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<SecondFactorMethod[] | null>(null);
  const [usingRecovery, setUsingRecovery] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.current.push({ resolve, reject });
          setError(null);
          setPassword('');
          setUsingRecovery(false);
          setMethods(null);
          setOpen(true);
          getFactors()
            .then((status) => setMethods(status.methods))
            .catch(() => setMethods([]));
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (accessToken: string) => {
    setTokens(accessToken);
    pending.current.splice(0).forEach(({ resolve }) => resolve(accessToken));
    setOpen(false);
  };

  const cancel = () => {
    pending.current.splice(0).forEach(({ reject }) => reject(new Error('Cancelled')));
    setOpen(false);
  };

  const attempt = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      finish(await work());
    } catch (err: unknown) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const withPassword = async () => {
    const response = await apiPost<ReauthResponse>('/api/auth/reauth', { password });
    noteFactorResetPending(response);
    noteStaffLinkPending(response);
    return response.accessToken;
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it is you</DialogTitle>
          <DialogDescription>
            This is a sensitive action, so we need to check it is still you.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {methods === null ? null : usingRecovery ? (
          <FactorCodeForm
            id="reauth-recovery-code"
            kind="recovery-code"
            busy={busy}
            submitLabel="Use recovery code"
            onSubmit={(code) => void attempt(() => reauthWithCode('recovery-code', code))}
          />
        ) : methods.length > 0 ? (
          <div className="grid gap-3">
            {methods.includes('totp') && (
              <FactorCodeForm
                id="reauth-totp-code"
                kind="totp"
                busy={busy}
                submitLabel="Confirm"
                onSubmit={(code) => void attempt(() => reauthWithCode('totp', code))}
              />
            )}
            {methods.includes('webauthn') && (
              <Button
                variant={methods.includes('totp') ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => attempt(passkeyReauth)}
              >
                {busy ? 'Waiting for your passkey...' : 'Use passkey'}
              </Button>
            )}
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(withPassword);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="reauth-password">Password</Label>
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy ? 'Checking...' : 'Confirm'}
            </Button>
          </form>
        )}
        {methods?.includes('recovery_code') && (
          <Button type="button" variant="link" onClick={() => setUsingRecovery(!usingRecovery)}>
            {usingRecovery ? 'Back' : 'Lost your device? Use a recovery code'}
          </Button>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
