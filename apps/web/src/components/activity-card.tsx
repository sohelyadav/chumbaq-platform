import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getImpersonation } from '@/lib/auth';
import {
  ACTIVITY_LABELS,
  ACTIVITY_QUERY_KEY,
  ALERT_TYPES,
  formatWhen,
  getActivity,
} from '@/lib/sessions';

/** Recent sign-ins and security changes, so someone can spot what was not them. */
export function ActivityCard() {
  const { data, isError } = useQuery({
    queryKey: ACTIVITY_QUERY_KEY,
    queryFn: getActivity,
    enabled: !getImpersonation(),
  });

  if (getImpersonation()) return null;

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" />
          Recent security activity
        </CardTitle>
        <CardDescription>
          Sign-ins and changes to how you sign in{data ? ` over the last ${data.days} days` : ''}.
          {' '}If something here was not you, change your password and sign out other devices.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-muted-foreground">Could not load your activity.</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : data.activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.activity.map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-4 p-3">
                  <div className="min-w-0">
                    <p
                      className={`flex items-center gap-2 font-medium ${
                        ALERT_TYPES.has(entry.type) ? 'text-destructive' : ''
                      }`}
                    >
                      {ACTIVITY_LABELS[entry.type] ?? entry.type}
                      {entry.current && <Badge variant="secondary">This device</Badge>}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {entry.device ?? 'Unknown device'}
                      {' · '}
                      {entry.ipAddress ?? 'Unknown address'}
                    </p>
                  </div>
                  <time dateTime={entry.at} className="shrink-0 text-sm text-muted-foreground">
                    {formatWhen(entry.at)}
                  </time>
                </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
