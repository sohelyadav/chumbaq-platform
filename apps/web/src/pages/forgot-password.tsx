import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AccountPageShell } from '@/components/account-page-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPost } from '@/lib/api';

const schema = z.object({ email: z.string().email('Invalid email address') });
type Values = z.infer<typeof schema>;

const SENT_MESSAGE = 'If that address has an account, a link to reset the password is on its way.';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async ({ email }: Values) => {
    setError(null);
    try {
      await apiPost('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      // Only the request failing gets here: too many from this browser, or no
      // connection. Neither depends on the address, so neither says anything about it.
      const tooMany = (err as { response?: { status?: number } }).response?.status === 429;
      setError(tooMany ? 'Too many requests. Wait a minute and try again.' : 'Something went wrong. Try again.');
    }
  };

  return (
    <AccountPageShell
      title="Forgot password?"
      description={sent ? undefined : 'Enter your email and we will send you a link to reset it.'}
    >
      {sent ? (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {SENT_MESSAGE}
        </p>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && (
            <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              {...register('email')}
            />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Sending...' : 'Send reset link'}
          </Button>
        </form>
      )}
      <p className="text-center text-sm">
        <Link to="/login" className="underline underline-offset-4">
          Back to login
        </Link>
      </p>
    </AccountPageShell>
  );
}
