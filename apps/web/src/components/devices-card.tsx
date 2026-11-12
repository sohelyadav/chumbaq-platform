import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/use-toast';
import { getImpersonation } from '@/lib/auth';
import { factorErrorMessage } from '@/lib/totp';
import {
  ACTIVITY_QUERY_KEY,
  formatWhen,
  listSessions,
  SESSIONS_QUERY_KEY,
  signOutOtherSessions,
  signOutSession,
} from '@/lib/sessions';

/** Where this account is signed in, with a way to end any session but this one. */
export function DevicesCard() {
  const queryClient = useQueryClient();
  const { data: sessions, isError } = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: listSessions,
    enabled: !getImpersonation(),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY }),
    ]);
  const fail = (error: unknown) => {
    void refresh();
    toast({ title: 'Not signed out', description: factorErrorMessage(error), variant: 'destructive' });
  };

  const signOutOne = useMutation({
    mutationFn: signOutSession,
    onSuccess: () => {
      void refresh();
      toast({ title: 'Device signed out' });
    },
    onError: fail,
  });
  const signOutOthers = useMutation({
    mutationFn: signOutOtherSessions,
    onSuccess: () => {
      void refresh();
      toast({ title: 'Other devices signed out' });
    },
    onError: fail,
  });

  if (getImpersonation()) return null;

  const others = sessions?.filter((session) => !session.current) ?? [];

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5" />
          Where you're signed in
        </CardTitle>
        <CardDescription>
          If you see a device you don't recognise, sign it out and change your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError ? (
          <p className="text-sm text-muted-foreground">Could not load your devices.</p>
        ) : !sessions ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {session.device ?? 'Unknown device'}
                    {session.current && <Badge variant="secondary">This device</Badge>}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {session.ipAddress ?? 'Unknown address'}
                    {' · '}Signed in {formatWhen(session.signedInAt)}
                    {' · '}Last active {formatWhen(session.lastActiveAt)}
                  </p>
                </div>
                {!session.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={signOutOne.isPending}
                    aria-label={`Sign out ${session.device ?? 'unknown device'}`}
                    onClick={() => signOutOne.mutate(session.id)}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {others.length > 1 && (
          <Button
            variant="outline"
            disabled={signOutOthers.isPending}
            onClick={() => signOutOthers.mutate()}
          >
            {signOutOthers.isPending ? 'Signing out...' : 'Sign out all other devices'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
