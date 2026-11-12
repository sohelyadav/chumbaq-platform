import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { FactorCodeForm } from '@/components/factor-code-form';
import { RecoveryCodes } from '@/components/recovery-codes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/use-toast';
import { getImpersonation } from '@/lib/auth';
import {
  confirmTotp,
  disableTotp,
  factorErrorMessage,
  getFactors,
  setupTotp,
  TotpSetup,
} from '@/lib/totp';

const QUERY_KEY = ['factors'];

/** Hidden when there is nothing to do here: staff use passkeys, and others must verify first. */
export function TwoFactorCard() {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const impersonating = Boolean(getImpersonation());
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getFactors,
    enabled: !impersonating,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const fail = (error: unknown) =>
    toast({
      title: 'Nothing was changed',
      description: factorErrorMessage(error),
      variant: 'destructive',
    });

  const start = useMutation({ mutationFn: setupTotp, onSuccess: setSetup, onError: fail });
  const confirm = useMutation({
    mutationFn: confirmTotp,
    onSuccess: ({ recoveryCodes }) => {
      setSetup(null);
      setCodes(recoveryCodes);
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: disableTotp,
    onSuccess: () => {
      void refresh();
      toast({ title: 'Authenticator app removed' });
    },
    onError: fail,
  });

  if (!data) return null;
  if (!data.totpEnabled && !data.canEnrolTotp && !setup && !codes) return null;

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          Authenticator app
        </CardTitle>
        <CardDescription>
          Ask for a code from an app such as 1Password or Google Authenticator each time you sign
          in, so your password alone is not enough.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : setup ? (
          <div className="grid gap-6 sm:grid-cols-[auto_1fr]">
            <div className="w-fit rounded-md border bg-white p-3">
              <QRCodeSVG value={setup.uri} size={176} title="Setup code for your authenticator app" />
            </div>
            <div className="space-y-4">
              <p className="text-sm">
                Scan this with your app, or enter this key by hand:
                <code className="mt-1 block break-all rounded bg-muted p-2 text-xs">{setup.secret}</code>
              </p>
              <FactorCodeForm
                id="totp-confirm-code"
                kind="totp"
                busy={confirm.isPending}
                submitLabel="Turn on"
                onSubmit={(code) => confirm.mutate(code)}
              />
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : data.totpEnabled ? (
          <>
            <p className="text-sm">On.</p>
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove authenticator app
            </Button>
          </>
        ) : (
          <Button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
            Set up an authenticator app
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
