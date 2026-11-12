import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountPageShell } from '@/components/account-page-shell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { apiPost } from '@/lib/api';
import { useTokenFromUrl } from '@/hooks/use-token-from-url';
import { pendingVerification } from '@/lib/account-links';

type State = 'ready' | 'submitting' | 'verified' | 'invalid' | 'busy';

/**
 * Asks for a click rather than confirming on load. Mail security scanners open links
 * and run their scripts, and an address confirmed by a scanner proves nothing: anyone
 * could register a stranger's address and have it verified for them. For the same
 * reason it needs the account's own session: clicking proves control of the mailbox,
 * not that you are who registered.
 */
export default function VerifyEmailPage() {
  const { isAuthenticated, isLoading, refreshUser } = useAuth();
  const fromUrl = useTokenFromUrl();
  const [token] = useState(() => fromUrl ?? pendingVerification.read(window.sessionStorage));
  const [state, setState] = useState<State>(token ? 'ready' : 'invalid');

  useEffect(() => {
    if (!token || isLoading) return;
    if (isAuthenticated) pendingVerification.clear(window.sessionStorage);
    else pendingVerification.keep(window.sessionStorage, token);
  }, [token, isLoading, isAuthenticated]);

  const confirm = async () => {
    setState('submitting');
    try {
      await apiPost('/api/auth/verify-email', { token });
      setState('verified');
      if (isAuthenticated) await refreshUser();
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      setState(status === 429 ? 'busy' : 'invalid');
    }
  };

  const next = (
    <p className="text-center text-sm">
      <Link to={isAuthenticated ? '/projects' : '/login'} className="underline underline-offset-4">
        {isAuthenticated ? 'Go to your projects' : 'Go to login'}
      </Link>
    </p>
  );

  if (state === 'verified') {
    return (
      <AccountPageShell title="Email confirmed">
        <p role="status" className="text-center text-sm">Thanks. Your email address is confirmed.</p>
        {next}
      </AccountPageShell>
    );
  }

  if (state === 'invalid') {
    return (
      <AccountPageShell title="Could not confirm your email">
        <p role="alert" className="text-center text-sm">
          This link is invalid, has expired, or is for a different account from the one you are
          signed in to. If you have already confirmed your address there is nothing more to do.
          Otherwise, sign in and send a new link from the banner.
        </p>
        {next}
      </AccountPageShell>
    );
  }

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <AccountPageShell
        title="Sign in to confirm your email"
        description="This keeps anyone else from confirming an address on your behalf."
      >
        <Button asChild className="w-full">
          <Link to="/login">Sign in</Link>
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Did not create this account? Ignore the email and nothing will change.
        </p>
      </AccountPageShell>
    );
  }

  return (
    <AccountPageShell title="Confirm your email" description="One click to confirm this address is yours.">
      {state === 'busy' && (
        <p role="alert" className="text-center text-sm text-destructive">
          Too many attempts. Wait a minute and try again.
        </p>
      )}
      <Button type="button" className="w-full" onClick={confirm} disabled={state === 'submitting'}>
        {state === 'submitting' ? 'Confirming...' : 'Confirm email address'}
      </Button>
    </AccountPageShell>
  );
}
