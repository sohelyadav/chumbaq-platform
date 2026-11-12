import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isForbiddenError, isPasskeyRequiredError } from '@/hooks/use-admin-insights';
import { useStaffAuth } from '@/hooks/use-staff-auth';

/**
 * The failure state for an admin page. A 403 reads differently from an outage:
 * the session outlives a revoked grant until its next request is refused, and retrying
 * will not help them.
 */
export function AdminQueryError({
  error,
  subject,
  onRetry,
}: {
  error: unknown;
  /** What failed to load, read as "Could not load {subject}." */
  subject: string;
  onRetry?: () => void;
}) {
  const { signOut } = useStaffAuth();

  if (isPasskeyRequiredError(error)) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
        <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        <div className="space-y-1">
          <p className="font-medium">Set up your passkeys to continue</p>
          <p className="text-sm text-muted-foreground">
            Staff access needs two passkeys, and a sign-in that used one.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/account">Go to your account</Link>
        </Button>
      </div>
    );
  }

  if (isForbiddenError(error)) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
        <ShieldAlert className="h-8 w-8 text-muted-foreground" />
        <div className="space-y-1">
          <p className="font-medium">You do not have access to this area</p>
          <p className="text-sm text-muted-foreground">
            The server refused this request. Super admin access may have been revoked for this
            account.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <p className="text-sm text-destructive">Could not load {subject}.</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
