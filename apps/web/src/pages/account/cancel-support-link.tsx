import { Link, Navigate } from 'react-router-dom';
import { AccountPageShell } from '@/components/account-page-shell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useCancelStaffLink, useStaffLinkPending } from '@/hooks/use-staff-link';
import { getImpersonation } from '@/lib/auth';
import { CANCEL_SUPPORT_LINK_PATH, loginPathFor } from '@/lib/staff-link';

/**
 * Where the "Support issued a password reset link" email sends the owner. Most owners
 * are already signed in, and the sign-in page would only send them on to their
 * projects, so this cancels from the session they have. Signed out, it goes through
 * sign-in and comes back here; a complete sign-in voids the link by itself. Not under
 * PublicRoute or ProtectedRoute, which would redirect before it could say anything.
 */
export default function CancelSupportLinkPage() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const { pending, checked } = useStaffLinkPending(isAuthenticated);
  const cancel = useCancelStaffLink();
  const signInAgain = () => void logout(loginPathFor(CANCEL_SUPPORT_LINK_PATH));

  if (isLoading) return null;

  if (getImpersonation()) {
    return (
      <AccountPageShell title="Not available while viewing as a tenant">
        <p className="text-center text-sm">Only the account owner can cancel a support link.</p>
      </AccountPageShell>
    );
  }

  if (!isAuthenticated) return <Navigate to={loginPathFor(CANCEL_SUPPORT_LINK_PATH)} replace />;

  const notYou = (
    <p className="text-center text-sm text-muted-foreground">
      Signed in as {user?.email}.{' '}
      <button type="button" className="underline underline-offset-4" onClick={signInAgain}>
        Not you? Sign in again
      </button>
    </p>
  );

  if (cancel.isSuccess || (checked && !pending)) {
    return (
      <AccountPageShell title="No support link is waiting">
        <p role="status" className="text-center text-sm">
          No password reset link from support works on your account now. Your password was not changed.
        </p>
        <p className="text-center text-sm text-muted-foreground">
          If you did not ask support for a link, contact them to report it.
        </p>
        <p className="text-center text-sm">
          <Link to="/projects" className="underline underline-offset-4">
            Go to your projects
          </Link>
        </p>
      </AccountPageShell>
    );
  }

  if (!checked) return null;

  return (
    <AccountPageShell
      title="Cancel the support link"
      description="Support issued a link to reset your password. If you did not ask for it, cancel it now."
    >
      {cancel.isError && (
        <p role="alert" className="text-center text-sm text-destructive">
          Could not cancel it. Confirm it is you and try again, or sign in again.
        </p>
      )}
      <Button
        type="button"
        variant="destructive"
        className="w-full"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        {cancel.isPending ? 'Cancelling...' : 'Cancel the link'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">You may be asked to confirm it is you.</p>
      {notYou}
    </AccountPageShell>
  );
}
