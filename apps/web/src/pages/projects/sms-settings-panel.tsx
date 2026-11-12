import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Loader2, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/use-toast';
import {
  useConnectSmsProvider,
  useSmsSettings,
  useTestSendSms,
  useUpdateSmsSettings,
} from '@/hooks/use-sms';
import { useCurrentProject } from '@/contexts/project-context';
import { can, shownValue } from '@/lib/project-role';

const errorText = (err: unknown) =>
  (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message?.toString() ?? 'Unknown error';

/** Same rule as the API: a number, a Messaging Service SID, or a sender ID. */
const SENDER_PATTERN =
  /^(\+[1-9]\d{7,14}|MG[0-9a-fA-F]{32}|(?=[A-Za-z0-9 ]*[A-Za-z])[A-Za-z0-9 ]{1,11})$/;

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast({ title: 'Copied' });
}

/** Sender, consent policy and opt-out line. Required before Twilio can connect. */
function SenderCard({ projectId }: { projectId: string }) {
  const { data: status } = useSmsSettings(projectId);
  const update = useUpdateSmsSettings(projectId);
  const { project } = useCurrentProject();
  const manages = can(project, 'channels.manage');
  const [form, setForm] = useState({
    sender: '',
    requireOptIn: true,
    optOutText: 'Reply STOP to opt out.',
  });

  useEffect(() => {
    const s = status?.settings;
    if (!s) return;
    setForm({ sender: s.sender, requireOptIn: s.requireOptIn, optOutText: s.optOutText ?? '' });
  }, [status?.settings]);

  const senderValid = SENDER_PATTERN.test(form.sender.trim());

  const save = async () => {
    try {
      await update.mutateAsync({
        sender: form.sender.trim(),
        requireOptIn: form.requireOptIn,
        optOutText: form.optOutText.trim(),
      });
      toast({ title: 'Sender saved' });
    } catch (err) {
      toast({ title: 'Could not save', description: errorText(err), variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sender</CardTitle>
        <CardDescription>Who your texts come from, and who may receive them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset disabled={!manages} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="sms-sender">From</Label>
          <Input
            id="sms-sender"
            placeholder="+14155550123"
            value={form.sender}
            onChange={(e) => setForm({ ...form, sender: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            A Twilio number in international form, a Messaging Service SID
            (<code>MG…</code>), or an alphanumeric sender ID of up to 11
            characters where the destination country allows one. India needs a
            DLT-registered sender ID.
          </p>
          {form.sender && !senderValid && (
            <p className="text-xs text-destructive">
              Not a number with a country code, an MG… SID, or a sender ID.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="sms-optout">Opt-out line</Label>
          <Input
            id="sms-optout"
            maxLength={80}
            value={form.optOutText}
            onChange={(e) => setForm({ ...form, optOutText: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Added to the end of every campaign text that does not already say
            it. US carriers expect it on marketing texts. Leave empty to send
            without one.
          </p>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Only text people who opted in</p>
            <p className="text-xs text-muted-foreground">
              On: only people whose app sent <code>smsOptIn: true</code>. Off:
              everyone with a number who has not opted out. Marketing texts
              need prior consent in the US, UK, EU and India, so leave this on
              unless you collect consent some other way.
            </p>
          </div>
          <Switch
            checked={form.requireOptIn}
            onCheckedChange={(requireOptIn) => setForm({ ...form, requireOptIn })}
          />
        </div>
        </fieldset>
        {manages && (
          <Button onClick={save} disabled={update.isPending || !senderValid}>
            {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save sender
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Twilio credentials, validated by the API against Twilio before they are stored. */
function ProviderCard({ projectId }: { projectId: string }) {
  const { data: status } = useSmsSettings(projectId);
  const connect = useConnectSmsProvider(projectId);
  const { project } = useCurrentProject();
  const manages = can(project, 'channels.manage');
  const [twilio, setTwilio] = useState({ accountSid: '', authToken: '' });

  if (!status?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Twilio</CardTitle>
          <CardDescription>
            {manages
              ? 'Save the sender first, then connect your Twilio account.'
              : 'Not set up yet. An owner or admin connects Twilio.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const stored = status.providers.find((p) => p.provider === 'twilio');

  const submit = async () => {
    try {
      await connect.mutateAsync({
        provider: 'twilio',
        credentials: {
          accountSid: twilio.accountSid.trim(),
          authToken: twilio.authToken.trim(),
        },
      });
      toast({ title: 'Twilio connected' });
      setTwilio({ accountSid: '', authToken: '' });
    } catch (err) {
      toast({ title: 'Could not connect', description: errorText(err), variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Twilio</CardTitle>
        <CardDescription>
          Texts go out through your own Twilio account, billed by Twilio. Both
          values are on the Twilio Console home page, under Account Info.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stored && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            {manages
              ? `Account ${stored.accountSid ?? '…'}, auth token ending ${stored.keyHint ?? '••••'}.`
              : 'Connected. Only owners and admins can see the account details.'}
          </p>
        )}
        {manages && (
        <>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="twilio-sid">Account SID</Label>
            <Input
              id="twilio-sid"
              placeholder="AC…"
              value={twilio.accountSid}
              onChange={(e) => setTwilio({ ...twilio, accountSid: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="twilio-token">Auth token</Label>
            <Input
              id="twilio-token"
              type="password"
              value={twilio.authToken}
              onChange={(e) => setTwilio({ ...twilio, authToken: e.target.value })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The auth token, not an API key: it is also what proves Twilio's
          delivery reports and STOP replies are genuine.
        </p>
        <Button onClick={submit} disabled={connect.isPending || !twilio.accountSid || !twilio.authToken}>
          {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {stored ? 'Replace credentials' : 'Connect Twilio'}
        </Button>
        </>
        )}

        {status.inboundWebhookUrl && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">STOP and START replies</p>
            <p className="text-xs text-muted-foreground">
              In Twilio, open your number (or Messaging Service) and set{' '}
              <em>A message comes in</em> to this URL, method POST. Replies of
              STOP then suppress the number here, and START lifts it. Delivery
              reports need no setup: every text asks Twilio to report back.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {shownValue(status.inboundWebhookUrl, project)}
              </code>
              {manages && (
                <Button size="sm" variant="outline" onClick={() => copy(status.inboundWebhookUrl!)}>
                  <Copy className="h-3 w-3" />
                </Button>
              )}
            </div>
            {!status.webhooksReachable && (
              <p className="flex items-start gap-2 text-xs text-yellow-700">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                This API's public URL is a local address, so Twilio cannot reach
                it. Texts still send, but delivery reports and STOP replies will
                not arrive until the API is reachable from the internet (for
                local testing, a tunnel such as ngrok with API_BASE_URL set to it).
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TestSendCard({ projectId }: { projectId: string }) {
  const { data: status } = useSmsSettings(projectId);
  const testSend = useTestSendSms(projectId);
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ delivered: boolean; error?: string } | null>(null);

  if (!status?.readyToSend) return null;

  const send = async () => {
    setResult(null);
    try {
      setResult(
        await testSend.mutateAsync({
          to: to.trim(),
          body: 'Chumbaq test: SMS is set up correctly.',
        }),
      );
    } catch (err) {
      setResult({ delivered: false, error: errorText(err) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send a test</CardTitle>
        <CardDescription>
          Texts one number through Twilio, with the opt-out line. A Twilio trial
          account can only text numbers verified in its console.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input placeholder="+919876543210" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button onClick={send} disabled={testSend.isPending || !to.trim().startsWith('+')}>
            {testSend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send test
          </Button>
        </div>
        {result && (
          <p className={`flex items-center gap-2 text-sm ${result.delivered ? 'text-green-700' : 'text-destructive'}`}>
            {result.delivered ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {result.delivered ? 'Accepted by Twilio. Check the phone.' : result.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function SmsSettingsPanel({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6">
      <SenderCard projectId={projectId} />
      <ProviderCard projectId={projectId} />
      <TestSendCard projectId={projectId} />
    </div>
  );
}
