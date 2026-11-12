import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { RecoveryCodes } from '@/components/recovery-codes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/use-toast';
import { getImpersonation } from '@/lib/auth';
import { factorErrorMessage, getFactors, regenerateRecoveryCodes } from '@/lib/totp';

const QUERY_KEY = ['factors'];

/** Apart from any one factor, because they back up whichever ones an account has. */
export function RecoveryCodesCard() {
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getFactors,
    enabled: !getImpersonation(),
  });
  const regenerate = useMutation({
    mutationFn: regenerateRecoveryCodes,
    onSuccess: ({ recoveryCodes }) => {
      setCodes(recoveryCodes);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) =>
      toast({
        title: 'Nothing was changed',
        description: factorErrorMessage(error),
        variant: 'destructive',
      }),
  });

  if (!data?.canManageRecoveryCodes && !codes) return null;

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="h-5 w-5" />
          Recovery codes
        </CardTitle>
        <CardDescription>
          Your way back in if you lose your passkey or authenticator app. Making new ones stops the
          old ones working.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : (
          <>
            <p className="text-sm">
              You have {data?.recoveryCodesRemaining}{' '}
              {data?.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}
            >
              Make new recovery codes
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
