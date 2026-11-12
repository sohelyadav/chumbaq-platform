import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { newPassword } from '@/lib/password';
import { AccountPageShell } from '@/components/account-page-shell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { apiPost } from '@/lib/api';
import { removeTokens } from '@/lib/auth';
import { useTokenFromUrl } from '@/hooks/use-token-from-url';

const schema = z
  .object({
    newPassword: newPassword(),
    confirm: z.string(),
  })
  .refine((values) => values.newPassword === values.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });
type Values = z.infer<typeof schema>;

const INVALID_LINK = 'This link is invalid or has expired. Ask for a new one.';
/** Same words as `EMAIL_RESET_REFUSED_MESSAGE` in the API. */
const RESET_BLOCKED = "For your security, this account's password can't be reset by email right now. Contact support.";

/** A link support issued waits a while before it works, so the owner can stop it. */
const notYetUsable = (usableAt: string) =>
  `This link becomes usable at ${new Date(usableAt).toLocaleString()}. Open the link again then.`;

export default function ResetPasswordPage() {
  const token = useTokenFromUrl();
  const [error, setError] = useState<string | null>(token ? null : INVALID_LINK);
  const [blocked, setBlocked] = useState(false);
  const [usableAt, setUsableAt] = useState<string | null>(null);

  const checkUsable = async (): Promise<string | null> => {
    try {
      const status = await apiPost<{ usableAt: string | null }>('/api/auth/reset-password/status', { token });
      setUsableAt(status.usableAt);
      return status.usableAt;
    } catch {
      // The form still works; sending it says the same if the link is not usable yet.
      return null;
    }
  };

  useEffect(() => {
    if (token) void checkUsable();
    // Once per token: the page reads it from the URL a single time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async ({ newPassword }: Values) => {
    setError(null);
    try {
      await apiPost('/api/auth/reset-password', { token, newPassword });
      // Every session just ended, this device's included. A full load, so /login does
      // not see a signed-in user still in memory and send them onward.
      removeTokens();
      window.location.assign('/login?passwordChanged=1');
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // 425: a link support issued, still waiting out its delay. Nothing was spent.
      if (status === 425 && (await checkUsable())) return;
      // 409: staff removed this account's second factors recently, so a new password
      // has to come through support rather than the mailbox. The link is spent.
      if (status === 409) setBlocked(true);
      setError(
        status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : status === 409
            ? RESET_BLOCKED
            : INVALID_LINK,
      );
    }
  };

  return (
    <AccountPageShell title="Set a new password">
      {error && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {usableAt && (
        <div role="status" className="rounded-md bg-muted p-3 text-sm">
          {notYetUsable(usableAt)}
        </div>
      )}
      {blocked || usableAt ? null : token ? (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <PasswordInput id="newPassword" autoComplete="new-password" {...register('newPassword')} />
            {errors.newPassword && <p className="text-sm text-destructive">{errors.newPassword.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm new password</Label>
            <PasswordInput id="confirm" autoComplete="new-password" {...register('confirm')} />
            {errors.confirm && <p className="text-sm text-destructive">{errors.confirm.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Set new password'}
          </Button>
        </form>
      ) : (
        <p className="text-center text-sm">
          <Link to="/forgot-password" className="underline underline-offset-4">
            Ask for a new link
          </Link>
        </p>
      )}
    </AccountPageShell>
  );
}
