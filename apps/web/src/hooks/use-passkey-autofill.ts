import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { createPasskeyAutofill } from '@/lib/passkey-autofill';
import { passkeyAutofillBrowser } from '@/lib/passkeys';

/**
 * Offers passkeys in the email field's autofill while `armed`, which the page must clear
 * before starting any other ceremony. Needs an input with `autocomplete="username webauthn"`
 * on the page, or the browser has nowhere to show them.
 */
export function usePasskeyAutofill(armed: boolean, onError: (error: unknown) => void) {
  const { completePasskeySignIn } = useAuth();
  const latest = useRef({ completePasskeySignIn, onError });
  latest.current = { completePasskeySignIn, onError };

  const [autofill] = useState(() =>
    createPasskeyAutofill({
      ...passkeyAutofillBrowser,
      signIn: (flowId, response) => latest.current.completePasskeySignIn(flowId, response),
      onError: (error) => latest.current.onError(error),
    }),
  );

  // The cleanup is also what aborts the request when the page goes away.
  useEffect(() => {
    if (!armed) return;
    autofill.start();
    return () => autofill.stop();
  }, [armed, autofill]);

  return autofill;
}
