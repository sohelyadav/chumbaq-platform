import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StaffFactorsCard } from '@/components/staff-factors-card';
import { useStaffAuth } from '@/hooks/use-staff-auth';

export default function AccountPage() {
  const { profile } = useStaffAuth();
  if (!profile) return null;
  const { session } = profile;

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <h1 className="text-xl font-semibold">Your account</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{profile.email}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm text-muted-foreground">
          <p>
            This session ends at {format(new Date(session.expiresAt), 'HH:mm, d MMM')}, or after{' '}
            {Math.round(session.idleTimeoutSeconds / 60)} minutes with nothing done.
          </p>
        </CardContent>
      </Card>
      <StaffFactorsCard />
    </div>
  );
}
