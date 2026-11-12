import { useState } from 'react';
import { RecoveryCodes } from '@/components/recovery-codes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import { getImpersonation } from '@/lib/auth';
import { addPasskey, listPasskeys, passkeyErrorMessage, removePasskey } from '@/lib/passkeys';

const QUERY_KEY = ['passkeys'];

/** Hidden when there is nothing to do here, as for tenants until the flag is on. */
export function PasskeysCard() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const impersonating = Boolean(getImpersonation());
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listPasskeys,
    enabled: !impersonating,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['factors'] }),
    ]);
  const fail = (error: unknown) =>
    toast({
      title: 'Passkey not changed',
      description: passkeyErrorMessage(error),
      variant: 'destructive',
    });

  const add = useMutation({
    mutationFn: () => addPasskey(name.trim() || 'Passkey'),
    onSuccess: ({ recoveryCodes }) => {
      setName('');
      if (recoveryCodes) setCodes(recoveryCodes);
      void refresh();
      toast({ title: 'Passkey added' });
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: removePasskey,
    onSuccess: () => {
      void refresh();
      toast({ title: 'Passkey removed' });
    },
    onError: fail,
  });

  if (!data || (!data.canEnrol && data.passkeys.length === 0)) return null;

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" />
          Passkeys
        </CardTitle>
        <CardDescription>
          Sign in with your device or a security key. Once you have one, your password alone is
          no longer enough to sign in. Add a second in case you lose the first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
        {data.passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no passkeys yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.passkeys.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{passkey.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {passkey.deviceType === 'multiDevice' ? 'Synced' : 'This device or key only'}
                    {' · '}Added {new Date(passkey.createdAt).toLocaleDateString()}
                    {passkey.lastUsedAt &&
                      ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  aria-label={`Remove ${passkey.name}`}
                  onClick={() => remove.mutate(passkey.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {data.canEnrol && (
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="passkey-name">Name</Label>
              <Input
                id="passkey-name"
                placeholder="For example, YubiKey on my keyring"
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Waiting for your passkey...' : 'Add a passkey'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
