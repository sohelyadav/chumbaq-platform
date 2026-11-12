import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { StaffEnrolled } from '@chumbaq/shared';
import { Button } from '@/components/ui/button';
import { CodeForm } from '@/components/code-form';
import { apiPost } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { errorMessage } from '@/lib/passkeys';

/**
 * Turns on an authenticator app as a staff sign-in method. The QR code is drawn here, in
 * the page: the secret never goes to a third-party QR service. Staff get no recovery
 * codes; a lost device is an operator's CLI reset.
 */
export function TotpEnrol({ onEnrolled }: { onEnrolled: (result: StaffEnrolled) => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await apiPost<{ secret: string; uri: string }>('/api/staff/auth/totp/setup', {}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(code: string) {
    setBusy(true);
    setError(null);
    try {
      onEnrolled(await apiPost<StaffEnrolled>('/api/staff/auth/totp/confirm', { code }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!setup ? (
        <Button variant="outline" disabled={busy} onClick={start}>
          {busy ? 'Starting...' : 'Use an authenticator app'}
        </Button>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Scan this with your authenticator app, or enter the key by hand. Then type the code it shows.
          </p>
          <div className="w-fit rounded-md bg-white p-3">
            <QRCodeSVG value={setup.uri} size={160} />
          </div>
          <div className="grid gap-1">
            <code className="break-all rounded bg-muted px-2 py-1 font-mono text-sm">{setup.secret}</code>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                onClick={async () => setCopied(await copyText(setup.secret))}
              >
                Copy key
              </Button>
              {copied === true && <span className="text-xs text-muted-foreground">Copied.</span>}
              {copied === false && (
                <span className="text-xs text-destructive">Could not copy. Select the key and copy it yourself.</span>
              )}
            </div>
          </div>
          <CodeForm id="totp-enrol-code" busy={busy} submitLabel="Turn on" onSubmit={(code) => void confirm(code)} />
        </>
      )}
    </div>
  );
}
