import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { InvitationPreview } from '@chumbaq/shared';
import { AccountPageShell } from '@/components/account-page-shell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { serverMessage, useAcceptInvitation, usePreviewInvitation } from '@/hooks/use-project-members';
import { useTokenFromUrl } from '@/hooks/use-token-from-url';
import { pendingInvite } from '@/lib/pending-invite';
import { roleLabel } from '@/lib/project-role';

/** The start of the API's wrong-account refusal (`wrongAccountMessage`). */
const WRONG_ACCOUNT = 'This invite was sent to ';

const article = (role: string) => (role === 'owner' || role === 'admin' ? 'an' : 'a');

/**
 * `/invite#token=...`, the link in an invite email or shared by the inviter. Under
 * neither route guard: signed out, it keeps the token in this tab (`pendingInvite`) and
 * sends the person to sign in or create an account, which bring them back here; signed
 * in, it shows what they were invited to and accepts only on a click. The token is
 * taken out of the address bar at once and only ever sent in a request body.
 */
export default function InvitePage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const fromUrl = useTokenFromUrl();
  const [token] = useState(() => fromUrl ?? pendingInvite.read(window.sessionStorage));
  const preview = usePreviewInvitation();
  const accept = useAcceptInvitation();
  const [details, setDetails] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  const load = () => {
    if (!token) return;
    setError(null);
    preview.mutate(token, {
      onSuccess: setDetails,
      onError: (err) => setError(serverMessage(err) ?? 'Could not open this invite. Try again in a minute.'),
    });
  };

  useEffect(() => {
    if (!token || isLoading) return;
    if (!isAuthenticated) {
      pendingInvite.keep(window.sessionStorage, token);
      return;
    }
    pendingInvite.clear(window.sessionStorage);
    // Once, though StrictMode runs effects twice.
    if (asked.current) return;
    asked.current = true;
    load();
  }, [token, isLoading, isAuthenticated]);

  const handleAccept = () => {
    if (!token) return;
    setError(null);
    accept.mutate(token, {
      onSuccess: ({ projectId }) => navigate(`/projects/${projectId}`, { replace: true }),
      onError: (err) => {
        const status = (err as { response?: { status?: number } }).response?.status;
        setError(
          status === 409
            ? 'You are already a member of this project.'
            : (serverMessage(err) ?? 'The invite was not accepted. Try again.'),
        );
      },
    });
  };

  /** Back here after signing in as someone else, with the token kept for that. */
  const switchAccount = () => {
    if (token) pendingInvite.keep(window.sessionStorage, token);
    void logout('/login');
  };

  const toProjects = (
    <p className="text-center text-sm">
      <Link to="/projects" className="underline underline-offset-4">
        Go to your projects
      </Link>
    </p>
  );

  if (!token) {
    return (
      <AccountPageShell title="This invite link is incomplete">
        <p role="alert" className="text-center text-sm">
          Open the link from the invite email again, or ask whoever invited you for a new one.
        </p>
        {isAuthenticated && toProjects}
      </AccountPageShell>
    );
  }

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <AccountPageShell
        title="Sign in to accept your invite"
        description="Use the email address the invite was sent to. You will come back here afterwards."
      >
        <Button asChild className="w-full">
          <Link to="/login">Sign in</Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/register">Create account</Link>
        </Button>
      </AccountPageShell>
    );
  }

  const wrongAccount =
    details?.matchesAccount === false || (error !== null && error.startsWith(WRONG_ACCOUNT));

  if (wrongAccount) {
    return (
      <AccountPageShell title="This invite is for another account">
        <p role="alert" className="text-center text-sm">
          {error?.startsWith(WRONG_ACCOUNT)
            ? error
            : `${WRONG_ACCOUNT}${details?.invitedEmailMasked}. Sign in with that address to accept it.`}
        </p>
        <p className="text-center text-sm text-muted-foreground">You are signed in as {user?.email}.</p>
        <Button className="w-full" onClick={switchAccount}>
          Sign out and use another account
        </Button>
        {toProjects}
      </AccountPageShell>
    );
  }

  if (!details) {
    return (
      <AccountPageShell title={error ? 'Could not open this invite' : 'Opening your invite...'}>
        {error && (
          <>
            <p role="alert" className="text-center text-sm">
              {error}
            </p>
            {toProjects}
          </>
        )}
      </AccountPageShell>
    );
  }

  const role = roleLabel(details.role).toLowerCase();

  return (
    <AccountPageShell
      title={`Join ${details.projectName}`}
      description={
        details.inviterName
          ? `${details.inviterName} invited you to join as ${article(role)} ${role}.`
          : `You were invited to join as ${article(role)} ${role}.`
      }
    >
      {details.emailVerificationRequired ? (
        <>
          <p role="status" className="text-center text-sm">
            Verify your email address first, then open the invite again. The link to confirm it is in the
            email we sent when you signed up, and you can send a new one from the banner in your dashboard.
          </p>
          <Button type="button" variant="outline" className="w-full" onClick={load} disabled={preview.isPending}>
            {preview.isPending ? 'Checking...' : 'I have confirmed my email'}
          </Button>
        </>
      ) : (
        <Button type="button" className="w-full" onClick={handleAccept} disabled={accept.isPending}>
          {accept.isPending ? 'Joining...' : 'Accept invite'}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
      {toProjects}
    </AccountPageShell>
  );
}
