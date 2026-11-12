import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StaffEnrolled, StaffFactors } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TotpEnrol } from '@/components/totp-enrol';
import { useStaffAuth } from '@/hooks/use-staff-auth';
import { apiGet } from '@/lib/api';
import { addStaffPasskey, errorMessage } from '@/lib/passkeys';
import { clearStaffToken } from '@/lib/staff-session';

/**
 * For an enrolment-only session: a password alone, which can do nothing but add a first
 * staff sign-in method. Adding one ends the session, so the person signs in with it.
 * The session lasts 15 minutes and cannot be restored by a reload.
 */
export default function EnrolPage() {
  const { profile, signOut } = useStaffAuth();
  const { data: factors } = useQuery({
    queryKey: ['staff', 'factors'],
    queryFn: () => apiGet<StaffFactors>('/api/staff/auth/factors'),
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function finished(result: StaffEnrolled, method: 'passkey' | 'totp') {
    if (!result.signInAgain) return;
    clearStaffToken();
    window.location.assign(`/sign-in?enrolled=${method}`);
  }

  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      finished(await addStaffPasskey(name.trim() || 'Passkey'), 'passkey');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set up a sign-in method</CardTitle>
          <CardDescription>
            {profile?.email} needs a passkey or an authenticator app to use the admin app. Add one, then sign in
            again with it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void addPasskey();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="enrol-passkey-name">Passkey name</Label>
              <Input
                id="enrol-passkey-name"
                maxLength={64}
                placeholder="e.g. Work laptop"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Waiting for your passkey...' : 'Add a passkey'}
            </Button>
          </form>
          {factors?.totp.available && <TotpEnrol onEnrolled={(result) => finished(result, 'totp')} />}
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
