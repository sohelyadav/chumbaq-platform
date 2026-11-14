import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { newPassword } from '@/lib/password';
import { AccountPageShell } from '@/components/account-page-shell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { useAuth } from '@/hooks/use-auth';
import { useTokenFromUrl } from '@/hooks/use-token-from-url';

const schema = z
  .object({
    password: newPassword(),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });
type Values = z.infer<typeof schema>;

/** Same words as `SIGNUP_LINK_INVALID` in the API. */
const INVALID_LINK = 'This sign-up link has expired or was already used. Sign up again, or sign in.';

/**
 * The second step of signing up, from the link mailed to the address: the account is
 * made here, with the password chosen here, so only whoever holds the mailbox can make
 * one for it. Not under PublicRoute, which would send a signed-in person away before
 * the token was read.
 */
export default function CompleteSignupPage() {
  const token = useTokenFromUrl();
  const { completeSignup } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(token ? null : INVALID_LINK);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async ({ password }: Values) => {
    setError(null);
    try {
      await completeSignup(token as string, password);
      navigate('/projects', { replace: true });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      setError(status === 429 ? 'Too many attempts. Wait a minute and try again.' : INVALID_LINK);
    }
  };

  return (
    <AccountPageShell title="Choose a password">
      {error && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {token ? (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <PasswordInput id="password" autoComplete="new-password" {...register('password')} />
            {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <PasswordInput id="confirm" autoComplete="new-password" {...register('confirm')} />
            {errors.confirm && <p className="text-sm text-destructive">{errors.confirm.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </Button>
        </form>
      ) : (
        <p className="text-center text-sm">
          <Link to="/register" className="underline underline-offset-4">
            Sign up again
          </Link>
        </p>
      )}
    </AccountPageShell>
  );
}
