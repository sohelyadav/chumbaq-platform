import { useState } from 'react';
import { FactorCodeForm } from '@/components/factor-code-form';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { passkeyErrorMessage } from '@/lib/passkeys';
import type { SecondFactorMethod } from '@/lib/totp';

interface SecondFactorStepProps {
  handle: string;
  methods: SecondFactorMethod[];
  onStartAgain: () => void;
}

/** After a correct password, offers whatever this account can answer with. */
export function SecondFactorStep({ handle, methods, onStartAgain }: SecondFactorStepProps) {
  const { completeWithPasskey, completeWithCode } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usingRecovery, setUsingRecovery] = useState(false);

  const attempt = async (work: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err: unknown) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hasPasskey = methods.includes('webauthn');
  const hasTotp = methods.includes('totp');
  const hasRecovery = methods.includes('recovery_code');
  const showRecovery = usingRecovery || (!hasPasskey && !hasTotp);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Confirm it is you</h1>
        <p className="text-balance text-sm text-muted-foreground">
          Your password was correct. This account also needs a second step.
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {showRecovery ? (
        <FactorCodeForm
          id="sign-in-recovery-code"
          kind="recovery-code"
          busy={busy}
          submitLabel="Use recovery code"
          onSubmit={(code) => attempt(() => completeWithCode(handle, 'recovery-code', code))}
        />
      ) : (
        <>
          {hasTotp && (
            <FactorCodeForm
              id="sign-in-totp-code"
              kind="totp"
              busy={busy}
              submitLabel="Confirm"
              onSubmit={(code) => attempt(() => completeWithCode(handle, 'totp', code))}
            />
          )}
          {hasPasskey && (
            <Button
              type="button"
              variant={hasTotp ? 'outline' : 'default'}
              disabled={busy}
              onClick={() => attempt(() => completeWithPasskey(handle))}
            >
              {busy ? 'Waiting for your passkey...' : 'Use passkey'}
            </Button>
          )}
        </>
      )}
      {hasRecovery && (hasPasskey || hasTotp) && (
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setUsingRecovery(!usingRecovery);
            setError(null);
          }}
        >
          {usingRecovery ? 'Back' : 'Lost your device? Use a recovery code'}
        </Button>
      )}
      <Button type="button" variant="ghost" onClick={onStartAgain}>
        Start again
      </Button>
    </div>
  );
}
