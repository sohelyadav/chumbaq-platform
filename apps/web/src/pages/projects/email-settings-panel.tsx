import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Loader2, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/use-toast';
import {
  EmailProviderName,
  useConnectEmailProvider,
  useEmailSettings,
  useResetSesTopic,
  useRotateEmailWebhookToken,
  useTestSendEmail,
  useUpdateEmailSettings,
} from '@/hooks/use-email';
import { useCurrentProject } from '@/contexts/project-context';
import { can, shownValue } from '@/lib/project-role';

const errorText = (err: unknown) =>
  (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message?.toString() ?? 'Unknown error';

const PROVIDER_LABEL: Record<EmailProviderName, string> = {
  ses: 'Amazon SES',
  resend: 'Resend',
  brevo: 'Brevo',
};

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast({ title: 'Copied' });
}

/** Sender identity and consent policy. Required before a provider can connect. */
function SenderCard({ projectId }: { projectId: string }) {
  const { data: status } = useEmailSettings(projectId);
  const update = useUpdateEmailSettings(projectId);
  const { project } = useCurrentProject();
  const manages = can(project, 'channels.manage');
  const [form, setForm] = useState({
    fromEmail: '',
    fromName: '',
    replyTo: '',
    postalAddress: '',
    requireOptIn: true,
  });

  useEffect(() => {
    const s = status?.settings;
    if (!s) return;
    setForm({
      fromEmail: s.fromEmail,
      fromName: s.fromName ?? '',
      replyTo: s.replyTo ?? '',
      postalAddress: s.postalAddress,
      requireOptIn: s.requireOptIn,
    });
  }, [status?.settings]);

  const save = async () => {
    try {
      await update.mutateAsync({
        fromEmail: form.fromEmail.trim(),
        fromName: form.fromName.trim() || undefined,
        replyTo: form.replyTo.trim() || undefined,
        postalAddress: form.postalAddress.trim(),
        requireOptIn: form.requireOptIn,
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
        <CardDescription>
          Who your emails come from. The from address must be on a domain you
          have verified with your provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset disabled={!manages} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="from-email">From address</Label>
            <Input
              id="from-email"
              type="email"
              placeholder="hello@yourapp.com"
              value={form.fromEmail}
              onChange={(e) => setForm({ ...form, fromEmail: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="from-name">From name</Label>
            <Input
              id="from-name"
              placeholder="Your App"
              value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reply-to">Reply-to (optional)</Label>
            <Input
              id="reply-to"
              type="email"
              placeholder="support@yourapp.com"
              value={form.replyTo}
              onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="postal">Postal address</Label>
          <Textarea
            id="postal"
            rows={3}
            placeholder={'Your Company Pvt Ltd\n12 MG Road, Bengaluru 560001, India'}
            value={form.postalAddress}
            onChange={(e) => setForm({ ...form, postalAddress: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Printed in every email footer. Anti-spam law (CAN-SPAM) requires a
            physical address in marketing email.
          </p>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Only email people who opted in</p>
            <p className="text-xs text-muted-foreground">
              On: only people whose app sent <code>emailOptIn: true</code>.
              Off: everyone with an address who has not opted out. Leave this on
              if you have users in the EU or India.
            </p>
          </div>
          <Switch
            checked={form.requireOptIn}
            onCheckedChange={(requireOptIn) => setForm({ ...form, requireOptIn })}
          />
        </div>
        </fieldset>
        {manages && (
          <Button onClick={save} disabled={update.isPending || !form.fromEmail || form.postalAddress.trim().length < 5}>
            {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save sender
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Credentials for one provider, validated by the API before they are stored. */
function ProviderCard({ projectId }: { projectId: string }) {
  const { data: status } = useEmailSettings(projectId);
  const connect = useConnectEmailProvider(projectId);
  const resetTopic = useResetSesTopic(projectId);
  const rotateToken = useRotateEmailWebhookToken(projectId);
  const { project } = useCurrentProject();
  const manages = can(project, 'channels.manage');
  const [tab, setTab] = useState<EmailProviderName>('resend');
  const [ses, setSes] = useState({
    region: 'ap-south-1',
    accessKeyId: '',
    secretAccessKey: '',
    configurationSetName: '',
  });
  const [resend, setResend] = useState({ apiKey: '', webhookSecret: '' });
  const [brevoKey, setBrevoKey] = useState('');

  useEffect(() => {
    if (status?.settings?.provider) setTab(status.settings.provider);
  }, [status?.settings?.provider]);

  if (!status?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provider</CardTitle>
          <CardDescription>
            {manages
              ? 'Save the sender first, then connect Amazon SES, Resend or Brevo.'
              : 'Not set up yet. An owner or admin connects a provider.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const stored = (name: EmailProviderName) => status.providers.find((p) => p.provider === name);
  const active = status.settings?.provider;

  const submit = async (provider: EmailProviderName) => {
    const credentials =
      provider === 'brevo'
        ? { apiKey: brevoKey.trim() }
        : provider === 'ses'
        ? {
            region: ses.region.trim(),
            accessKeyId: ses.accessKeyId.trim(),
            secretAccessKey: ses.secretAccessKey.trim(),
            ...(ses.configurationSetName.trim()
              ? { configurationSetName: ses.configurationSetName.trim() }
              : {}),
          }
        : {
            apiKey: resend.apiKey.trim(),
            ...(resend.webhookSecret.trim() ? { webhookSecret: resend.webhookSecret.trim() } : {}),
          };
    try {
      await connect.mutateAsync({ provider, credentials });
      toast({ title: `${PROVIDER_LABEL[provider]} connected` });
      setSes((s) => ({ ...s, secretAccessKey: '' }));
      setResend({ apiKey: '', webhookSecret: '' });
      setBrevoKey('');
    } catch (err) {
      toast({ title: 'Could not connect', description: errorText(err), variant: 'destructive' });
    }
  };

  const webhook = status.webhookUrls?.[tab];

  const replaceUrl = async () => {
    // One secret is in every provider's URL, so all of them change.
    if (
      !window.confirm(
        'Replace the webhook URL? The current URL stops working at once for Amazon SES, Resend and Brevo. Give your provider the new URL afterwards.',
      )
    ) {
      return;
    }
    try {
      await rotateToken.mutateAsync();
      toast({ title: 'Webhook URL replaced', description: 'Give your provider the new URL.' });
    } catch (err) {
      toast({ title: 'Could not replace the URL', description: errorText(err), variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider</CardTitle>
        <CardDescription>
          Email goes out through your own account. Chumbaq never sends from
          shared servers, so your domain's reputation stays yours.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as EmailProviderName)}>
          <TabsList>
            <TabsTrigger value="resend">
              Resend {active === 'resend' && <Badge className="ml-2">Active</Badge>}
            </TabsTrigger>
            <TabsTrigger value="ses">
              Amazon SES {active === 'ses' && <Badge className="ml-2">Active</Badge>}
            </TabsTrigger>
            <TabsTrigger value="brevo">
              Brevo {active === 'brevo' && <Badge className="ml-2">Active</Badge>}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="brevo" className="space-y-4 pt-4">
            {stored('brevo') && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Key ending {stored('brevo')!.keyHint ?? '••••'} is stored.
              </p>
            )}
            {manages && (
            <>
            <div className="space-y-2">
              <Label htmlFor="brevo-key">API key</Label>
              <Input
                id="brevo-key"
                type="password"
                placeholder="xkeysib-..."
                value={brevoKey}
                onChange={(e) => setBrevoKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                From SMTP &amp; API → API Keys in Brevo. Not the SMTP key. If your
                Brevo account restricts API access to authorised IPs, add this
                server's IP there or sends will be refused.
              </p>
            </div>
            <Button onClick={() => submit('brevo')} disabled={connect.isPending || !brevoKey}>
              {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {stored('brevo') ? 'Replace and use Brevo' : 'Connect Brevo'}
            </Button>
            </>
            )}
          </TabsContent>

          <TabsContent value="resend" className="space-y-4 pt-4">
            {stored('resend') && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Key ending {stored('resend')!.keyHint ?? '••••'} is stored.
                {!stored('resend')!.hasWebhookSecret && (
                  <span className="text-yellow-700">
                    No webhook secret: bounces and opens will not be recorded.
                  </span>
                )}
              </p>
            )}
            {manages && (
            <>
            <div className="space-y-2">
              <Label htmlFor="resend-key">API key</Label>
              <Input
                id="resend-key"
                type="password"
                placeholder="re_..."
                value={resend.apiKey}
                onChange={(e) => setResend({ ...resend, apiKey: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                A sending-only key is enough, and safer.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="resend-secret">Webhook signing secret</Label>
              <Input
                id="resend-secret"
                type="password"
                placeholder="whsec_..."
                value={resend.webhookSecret}
                onChange={(e) => setResend({ ...resend, webhookSecret: e.target.value })}
              />
            </div>
            <Button onClick={() => submit('resend')} disabled={connect.isPending || !resend.apiKey}>
              {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {stored('resend') ? 'Replace and use Resend' : 'Connect Resend'}
            </Button>
            </>
            )}
          </TabsContent>

          <TabsContent value="ses" className="space-y-4 pt-4">
            {stored('ses') && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Access key ending {stored('ses')!.keyHint ?? '••••'} in {stored('ses')!.region}
                {stored('ses')!.configurationSetName
                  ? `, configuration set ${stored('ses')!.configurationSetName}`
                  : ' (no configuration set: delivery events will not be recorded)'}
              </p>
            )}
            {manages && (
            <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ses-region">Region</Label>
                <Input
                  id="ses-region"
                  value={ses.region}
                  onChange={(e) => setSes({ ...ses, region: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ses-config">Configuration set</Label>
                <Input
                  id="ses-config"
                  placeholder="chumbaq-events"
                  value={ses.configurationSetName}
                  onChange={(e) => setSes({ ...ses, configurationSetName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ses-akid">Access key ID</Label>
                <Input
                  id="ses-akid"
                  value={ses.accessKeyId}
                  onChange={(e) => setSes({ ...ses, accessKeyId: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ses-secret">Secret access key</Label>
                <Input
                  id="ses-secret"
                  type="password"
                  value={ses.secretAccessKey}
                  onChange={(e) => setSes({ ...ses, secretAccessKey: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Use an IAM user limited to <code>ses:SendEmail</code> and{' '}
              <code>ses:GetAccount</code>.
            </p>
            <Button
              onClick={() => submit('ses')}
              disabled={connect.isPending || !ses.accessKeyId || !ses.secretAccessKey}
            >
              {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {stored('ses') ? 'Replace and use SES' : 'Connect Amazon SES'}
            </Button>
            </>
            )}
          </TabsContent>
        </Tabs>

        {webhook && (
          <div className="mt-6 space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Delivery events</p>
            <p className="text-xs text-muted-foreground">
              {tab === 'brevo'
                ? 'In Brevo, go to Transactional → Settings → Webhook, add this URL, and tick Delivered, Opened, Clicked, Hard bounce, Soft bounce, Spam, Blocked, Invalid email and Unsubscribed. Brevo does not sign webhooks, so keep this URL private: it is the only thing that authenticates them.'
                : tab === 'ses'
                ? 'Create an SNS topic, add it as an event destination on your configuration set (deliveries, bounces, complaints, opens, clicks), and subscribe this URL to it over HTTPS. Chumbaq confirms the subscription itself and then accepts events only from that topic. The topic must be in the same AWS account as the access key above; events from any other account are refused.'
                : 'In Resend, add a webhook for email.delivered, opened, clicked, bounced and complained pointing at this URL, then paste its signing secret above.'}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{shownValue(webhook, project)}</code>
              {manages && (
                <Button size="sm" variant="outline" onClick={() => copy(webhook)}>
                  <Copy className="h-3 w-3" />
                </Button>
              )}
            </div>
            {manages && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>If this URL leaks, replace it. Anyone who has it can send events here.</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={rotateToken.isPending}
                onClick={replaceUrl}
              >
                {rotateToken.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Replace URL
              </Button>
            </div>
            )}
            {manages && tab === 'ses' && status.settings?.sesTopicArn && (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">Accepting events from {status.settings.sesTopicArn}</span>
                <Button size="sm" variant="ghost" onClick={() => resetTopic.mutate()}>
                  Switch topic
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TestSendCard({ projectId }: { projectId: string }) {
  const { data: status } = useEmailSettings(projectId);
  const testSend = useTestSendEmail(projectId);
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ delivered: boolean; error?: string } | null>(null);

  if (!status?.readyToSend) return null;

  const send = async () => {
    setResult(null);
    try {
      setResult(
        await testSend.mutateAsync({
          to: to.trim(),
          subject: 'Chumbaq test email',
          html: '<p>Email is set up correctly. Campaigns will go out through this account.</p>',
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
          Sends one email through the active provider, with the real footer and
          unsubscribe headers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input type="email" placeholder="you@yourapp.com" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button onClick={send} disabled={testSend.isPending || !to.includes('@')}>
            {testSend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Send test
          </Button>
        </div>
        {result && (
          <p className={`flex items-center gap-2 text-sm ${result.delivered ? 'text-green-700' : 'text-destructive'}`}>
            {result.delivered ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {result.delivered ? 'Accepted by the provider. Check the inbox.' : result.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function EmailSettingsPanel({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6">
      <SenderCard projectId={projectId} />
      <ProviderCard projectId={projectId} />
      <TestSendCard projectId={projectId} />
    </div>
  );
}
