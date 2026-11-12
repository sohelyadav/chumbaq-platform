import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, ShieldCheck } from 'lucide-react';
import type { StaffLoginResult, StaffSecondFactor, StaffSignedIn } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CodeForm } from '@/components/code-form';
import { PasswordInput } from '@/components/password-input';
import { useStaffAuth } from '@/hooks/use-staff-auth';
import { apiPost } from '@/lib/api';
import { needsEnrolmentCode, staffLoginBody } from '@/lib/enrolment-code';
import { STAFF_SESSION_ENDED_MESSAGE, STAFF_SESSION_IDLE_MESSAGE } from '@/lib/messages';
import { errorMessage, passkeySecondFactor, passkeySignIn } from '@/lib/passkeys';

/** Only these fixed notes are shown from the address bar; nothing it carries is echoed. */
const NOTES: Record<string, string> = {
  'reason=idle': STAFF_SESSION_IDLE_MESSAGE,
  'reason=ended': STAFF_SESSION_ENDED_MESSAGE,
  'enrolled=passkey': 'Done. Sign in with your new passkey.',
  'enrolled=totp': 'Done. Sign in with your authenticator app.',
};

function noteFor(params: URLSearchParams, restored: string | null): string | null {
  for (const key of ['reason', 'enrolled']) {
    const value = params.get(key);
    if (value && NOTES[`${key}=${value}`]) return NOTES[`${key}=${value}`];
  }
  return restored ? NOTES[`reason=${restored}`] ?? null : null;
}

export default function SignInPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { begin, endedBecause } = useStaffAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<{ handle: string; methods: StaffSecondFactor[] } | null>(null);
  const [busy, setBusy] = useState<'passkey' | 'password' | 'factor' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null until the API says this sign-in needs an operator's enrolment code.
  const [enrolmentCode, setEnrolmentCode] = useState<string | null>(null);
  const note = error ? null : noteFor(params, endedBecause);

  async function signedIn(result: StaffSignedIn) {
    await begin(result);
    navigate('/', { replace: true });
  }

  async function attempt(kind: 'passkey' | 'password' | 'factor', work: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    void attempt('password', async () => {
      let result: StaffLoginResult;
      try {
        result = await apiPost<StaffLoginResult>('/api/staff/auth/login', staffLoginBody(email, password, enrolmentCode));
      } catch (err) {
        if (needsEnrolmentCode(errorMessage(err))) setEnrolmentCode((current) => current ?? '');
        throw err;
      }
      setPassword('');
      setEnrolmentCode(null);
      if (result.step === 'second_factor') {
        setStep({ handle: result.handle, methods: result.methods });
      } else if (result.step === 'enrol') {
        await begin(result);
        navigate('/enrol', { replace: true });
      } else {
        await signedIn(result);
      }
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
            <ShieldCheck className="size-5" />
          </div>
          <CardTitle>Chumbaq admin</CardTitle>
          <CardDescription>Staff only. Every sign-in is recorded.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {note && (
            <p role="status" className="rounded-md bg-muted p-3 text-sm">
              {note}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}

          {step ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">Now confirm it is you.</p>
              {step.methods.includes('webauthn') && (
                <Button
                  disabled={busy !== null}
                  onClick={() => attempt('factor', async () => signedIn(await passkeySecondFactor(step.handle)))}
                >
                  <KeyRound className="h-4 w-4" />
                  {busy === 'factor' ? 'Waiting for your passkey...' : 'Use your passkey'}
                </Button>
              )}
              {step.methods.includes('totp') && (
                <CodeForm
                  id="sign-in-code"
                  busy={busy !== null}
                  submitLabel="Sign in"
                  onSubmit={(code) =>
                    void attempt('factor', async () =>
                      signedIn(
                        await apiPost<StaffSignedIn>('/api/staff/auth/login/totp', { handle: step.handle, code }),
                      ),
                    )
                  }
                />
              )}
              <Button variant="link" onClick={() => setStep(null)}>
                Start again
              </Button>
            </div>
          ) : (
            <>
              <Button
                disabled={busy !== null}
                onClick={() => attempt('passkey', async () => signedIn(await passkeySignIn()))}
              >
                <KeyRound className="h-4 w-4" />
                {busy === 'passkey' ? 'Waiting for your passkey...' : 'Sign in with a passkey'}
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <form className="grid gap-3" onSubmit={submitPassword}>
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <PasswordInput
                    id="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
                {enrolmentCode !== null && (
                  <div className="grid gap-2">
                    <Label htmlFor="enrolment-code">Enrolment code from your operator</Label>
                    <Input
                      id="enrolment-code"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      required
                      value={enrolmentCode}
                      onChange={(event) => setEnrolmentCode(event.target.value)}
                    />
                  </div>
                )}
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy !== null || !email || !password || (enrolmentCode !== null && !enrolmentCode.trim())}
                >
                  {busy === 'password' ? 'Checking...' : 'Continue'}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
