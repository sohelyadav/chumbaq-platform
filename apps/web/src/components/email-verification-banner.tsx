import { useState } from 'react';
import { X } from 'lucide-react';
import type { ResendVerificationResponse } from '@chumbaq/shared';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api';
import { getImpersonation } from '@/lib/auth';
import { shouldShowVerificationBanner } from '@/lib/account-links';

const dismissedKey = (userId: string) => `chumbaq_verify_banner_dismissed:${userId}`;

const RESULT_MESSAGE: Record<ResendVerificationResponse['status'], string> = {
  sent: 'Sent. Check your inbox for the link.',
  already_verified: 'This address is already confirmed.',
  unavailable: 'The email could not be sent right now. Try again later.',
};

/** A reminder only. Dismissing lasts for this browser tab's session. */
export function EmailVerificationBanner() {
  const { user, refreshUser } = useAuth();
  const [dismissed, setDismissed] = useState(
    () => !!user && sessionStorage.getItem(dismissedKey(user.id)) === '1',
  );
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const visible = shouldShowVerificationBanner({
    user,
    impersonating: getImpersonation() !== null,
    dismissed,
  });
  if (!visible || !user) return null;

  const resend = async () => {
    setSending(true);
    setMessage(null);
    try {
      const { status } = await apiPost<ResendVerificationResponse>('/api/auth/resend-verification');
      setMessage(RESULT_MESSAGE[status]);
      if (status === 'already_verified') await refreshUser();
    } catch (error) {
      const tooMany = (error as { response?: { status?: number } }).response?.status === 429;
      setMessage(tooMany ? 'Too many emails sent. Try again later.' : RESULT_MESSAGE.unavailable);
    } finally {
      setSending(false);
    }
  };

  const dismiss = () => {
    sessionStorage.setItem(dismissedKey(user.id), '1');
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label="Confirm your email address"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-2 text-sm"
    >
      <p className="min-w-0 flex-1">
        Confirm {user.email} so you can recover this account.
        {message && <span className="ml-2 text-muted-foreground" role="status">{message}</span>}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={resend} disabled={sending}>
        {sending ? 'Sending...' : 'Resend email'}
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={dismiss} aria-label="Dismiss">
        <X className="size-4" />
      </Button>
    </div>
  );
}
