import { useEffect, useRef, useState } from 'react';
import type { StaffProfile, StaffReauthenticated } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CodeForm } from '@/components/code-form';
import { apiGet, apiPost, setReauthHandler } from '@/lib/api';
import { errorMessage, passkeyReauth } from '@/lib/passkeys';
import { replaceStaffAccessToken } from '@/lib/staff-session';

interface Pending {
  resolve: (accessToken: string) => void;
  reject: (reason: Error) => void;
}

/**
 * Answers the staff API's "Confirm it is you to continue." wherever it comes from: the API
 * client waits on this, then resends what was refused, so no page has to know about it.
 * Staff confirm with a sign-in method, never a password.
 */
export function ReauthDialog() {
  const pending = useRef<Pending[]>([]);
  const [open, setOpen] = useState(false);
  const [factors, setFactors] = useState<StaffProfile['factors'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.current.push({ resolve, reject });
          setError(null);
          setFactors(null);
          setOpen(true);
          apiGet<StaffProfile>('/api/staff/auth/me')
            .then((me) => setFactors(me.factors))
            .catch((err) => setError(errorMessage(err)));
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (accessToken: string) => {
    replaceStaffAccessToken(accessToken);
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
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const withCode = (code: string) =>
    apiPost<StaffReauthenticated>('/api/staff/auth/reauth/totp', { code }).then((r) => r.accessToken);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it is you</DialogTitle>
          <DialogDescription>This is a sensitive action, so we need to check it is still you.</DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {factors && (
          <div className="grid gap-3">
            {factors.passkeys > 0 && (
              <Button disabled={busy} onClick={() => attempt(passkeyReauth)}>
                {busy ? 'Waiting for your passkey...' : 'Use passkey'}
              </Button>
            )}
            {factors.totp && (
              <CodeForm
                id="reauth-totp-code"
                busy={busy}
                submitLabel="Confirm"
                onSubmit={(code) => void attempt(() => withCode(code))}
              />
            )}
          </div>
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
