import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { KeyRound, Smartphone } from 'lucide-react';
import type { StaffFactors } from '@chumbaq/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import { TotpEnrol } from '@/components/totp-enrol';
import { useStaffAuth } from '@/hooks/use-staff-auth';
import { apiDelete, apiGet } from '@/lib/api';
import { addStaffPasskey, errorMessage } from '@/lib/passkeys';

const FACTORS_KEY = ['staff', 'factors'];

/**
 * A staff member's own sign-in methods in a full session. Every change goes through the
 * re-auth prompt (the API client opens it when the API asks), and adding or removing one
 * ends this person's other staff sessions.
 */
export function StaffFactorsCard() {
  const queryClient = useQueryClient();
  const { reloadProfile } = useStaffAuth();
  const { data: factors, isLoading, error: loadError } = useQuery({
    queryKey: FACTORS_KEY,
    queryFn: () => apiGet<StaffFactors>('/api/staff/auth/factors'),
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: FACTORS_KEY });
    await reloadProfile().catch(() => undefined);
  };

  const run = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      toast({ title: done });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (isLoading) return null;
  if (loadError || !factors) {
    return <p className="text-sm text-destructive">{errorMessage(loadError, 'Could not load your sign-in methods.')}</p>;
  }

  const removeBlocked = !factors.canRemove;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sign-in methods</CardTitle>
        <CardDescription>
          Staff sign in with a passkey or an authenticator app. Changing them asks you to confirm it is you, and
          signs you out everywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <section className="grid gap-3">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4" /> Passkeys
          </h3>
          {factors.passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys yet.</p>
          ) : (
            <ul className="grid gap-2">
              {factors.passkeys.map((key) => (
                <li key={key.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{key.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {format(new Date(key.createdAt), 'd MMM yyyy')}
                      {key.lastUsedAt ? `, last used ${format(new Date(key.lastUsedAt), 'd MMM yyyy')}` : ''}
                      {key.backedUp ? ' · synced' : ' · this device only'}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removeBlocked || busy !== null}
                    title={removeBlocked ? 'Add another sign-in method before removing this one.' : undefined}
                    onClick={() =>
                      run(`remove-${key.id}`, () => apiDelete(`/api/staff/auth/passkeys/${key.id}`), 'Passkey removed')
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run('add', () => addStaffPasskey(name.trim() || 'Passkey'), 'Passkey added').then(() => setName(''));
            }}
          >
            <div className="grid gap-1">
              <Label htmlFor="new-passkey-name">Name</Label>
              <Input
                id="new-passkey-name"
                maxLength={64}
                placeholder="e.g. Work laptop"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy !== null}>
              {busy === 'add' ? 'Waiting for your passkey...' : 'Add a passkey'}
            </Button>
          </form>
        </section>

        <section className="grid gap-3">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Smartphone className="h-4 w-4" /> Authenticator app
          </h3>
          {factors.totp.enabled ? (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <Badge variant="secondary">On</Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={removeBlocked || busy !== null}
                title={removeBlocked ? 'Add another sign-in method before removing this one.' : undefined}
                onClick={() => run('totp-off', () => apiDelete('/api/staff/auth/totp'), 'Authenticator app turned off')}
              >
                Turn off
              </Button>
            </div>
          ) : factors.totp.available ? (
            <TotpEnrol
              onEnrolled={() => {
                toast({ title: 'Authenticator app turned on' });
                void refresh();
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Not available on this server (MFA_ENCRYPTION_KEY is not set).</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
