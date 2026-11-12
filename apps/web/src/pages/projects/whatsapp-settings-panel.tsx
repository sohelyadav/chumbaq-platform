import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/use-toast';
import {
  WHATSAPP_PROVIDER_LABEL,
  WhatsAppProviderName,
  useConnectWhatsAppProvider,
  useUpdateWhatsAppSettings,
  useWhatsAppSettings,
} from '@/hooks/use-whatsapp';
import { useCurrentProject } from '@/contexts/project-context';
import { can, shownValue } from '@/lib/project-role';

const errorText = (err: unknown) =>
  (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message?.toString() ?? 'Unknown error';

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast({ title: 'Copied' });
}

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
  hint?: string;
}

/** What each provider asks for, in the order its own console shows them. */
const FIELDS: Record<WhatsAppProviderName, Field[]> = {
  meta: [
    { key: 'phoneNumberId', label: 'Phone number ID', placeholder: '1059545589544', hint: 'Under WhatsApp → API Setup in your Meta app. Not the phone number itself.' },
    { key: 'businessAccountId', label: 'WhatsApp Business Account ID', placeholder: '2059545589544' },
    { key: 'accessToken', label: 'Access token', secret: true, hint: 'A system user token with whatsapp_business_messaging and whatsapp_business_management. Temporary tokens expire within a day.' },
    { key: 'appSecret', label: 'App secret', secret: true, optional: true, hint: 'App settings → Basic. Signs webhooks; without it, delivery reports are only trusted for numbers your users already have.' },
  ],
  twilio_whatsapp: [
    { key: 'accountSid', label: 'Account SID', placeholder: 'AC…' },
    { key: 'authToken', label: 'Auth token', secret: true, hint: 'The auth token, not an API key: it also signs Twilio’s webhooks.' },
    { key: 'sender', label: 'WhatsApp sender', placeholder: '+14155550123 or MG…', hint: 'Your WhatsApp-enabled Twilio number, or a Messaging Service SID.' },
  ],
  gupshup: [
    { key: 'apiKey', label: 'API key', secret: true, hint: 'From your Gupshup dashboard profile.' },
    { key: 'appName', label: 'App name', placeholder: 'myshopapp' },
    { key: 'appId', label: 'App ID', placeholder: 'From the app overview page' },
    { key: 'sourceNumber', label: 'Source number', placeholder: '+919000000000', hint: 'The app’s WhatsApp number, with its country code.' },
  ],
  interakt: [
    { key: 'apiKey', label: 'Secret key', secret: true, hint: 'Settings → Developer Setting. Public APIs need the Growth plan or above.' },
    { key: 'webhookSecret', label: 'Webhook secret key', secret: true, optional: true, hint: 'The secret you set beside the webhook URL. Without it, events are only trusted for numbers your users already have.' },
  ],
};

/** How to point each provider's webhook here. */
const WEBHOOK_HELP: Record<WhatsAppProviderName, string> = {
  meta: 'In your Meta app, WhatsApp → Configuration → Webhook: paste this URL and the verify token below, then subscribe to the messages and user_preferences fields.',
  twilio_whatsapp: 'Delivery reports need no setup — every message asks Twilio to report back. For STOP replies, set this URL as "A message comes in" on your WhatsApp sender, method POST.',
  gupshup: 'On your Gupshup app’s Webhooks page, set this as the callback URL and enable sent, delivered, read and failed events. Gupshup does not sign webhooks, so keep this URL private.',
  interakt: 'In Settings → Developer Setting, paste this webhook URL, set a secret key (paste it above too), and tick message sent, delivered, read, failed and received.',
};

function PolicyCard({ projectId }: { projectId: string }) {
  const { data: status } = useWhatsAppSettings(projectId);
  const update = useUpdateWhatsAppSettings(projectId);
  const { project } = useCurrentProject();
  const manages = can(project, 'channels.manage');
  const requireOptIn = status?.settings?.requireOptIn ?? true;

  const toggle = async (value: boolean) => {
    try {
      await update.mutateAsync({ requireOptIn: value });
    } catch (err) {
      toast({ title: 'Could not save', description: errorText(err), variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consent</CardTitle>
        <CardDescription>
          WhatsApp's Business Policy requires opt-in before a business messages
          someone, and people who report you lower your quality rating and
          messaging limit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Only message people who opted in to WhatsApp</p>
            <p className="text-xs text-muted-foreground">
              On: only people whose app sent <code>whatsappOptIn: true</code>. Separate
              from SMS consent. Turn off only if you collect WhatsApp opt-in some
              other way and everyone in your user base has given it.
            </p>
          </div>
          <Switch checked={requireOptIn} onCheckedChange={toggle} disabled={!manages || update.isPending} />
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCard({ projectId }: { projectId: string }) {
  const { data: status } = useWhatsAppSettings(projectId);
  const connect = useConnectWhatsAppProvider(projectId);
  const { project } = useCurrentProject();
  const manages = can(project, 'channels.manage');
  const [tab, setTab] = useState<WhatsAppProviderName>('meta');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (status?.settings?.provider) setTab(status.settings.provider);
  }, [status?.settings?.provider]);

  const active = status?.settings?.provider;
  const stored = (name: WhatsAppProviderName) => status?.providers.find((p) => p.provider === name);
  const fields = FIELDS[tab];
  const complete = fields.every((field) => field.optional || values[`${tab}.${field.key}`]?.trim());

  const submit = async () => {
    const credentials: Record<string, string> = {};
    for (const field of fields) {
      const value = values[`${tab}.${field.key}`]?.trim();
      if (value) credentials[field.key] = value;
    }
    try {
      await connect.mutateAsync({ provider: tab, credentials });
      toast({ title: `${WHATSAPP_PROVIDER_LABEL[tab]} connected` });
      setValues((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${tab}.`))),
      );
    } catch (err) {
      toast({ title: 'Could not connect', description: errorText(err), variant: 'destructive' });
    }
  };

  const summary = stored(tab);
  const webhook = status?.webhookUrls?.[tab];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider</CardTitle>
        <CardDescription>
          Messages go out through your own WhatsApp Business account. Meta bills
          the conversations; Chumbaq never sends from a shared number.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as WhatsAppProviderName)}>
          <TabsList>
            {(Object.keys(FIELDS) as WhatsAppProviderName[]).map((name) => (
              <TabsTrigger key={name} value={name}>
                {WHATSAPP_PROVIDER_LABEL[name]} {active === name && <Badge className="ml-2">Active</Badge>}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={tab} className="space-y-4 pt-4">
            {summary && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                {Object.entries(summary.identifiers).map(([key, value]) => `${key} ${shownValue(value, project)}`).join(', ')}
                {summary.keyHint && ` · secret ending ${summary.keyHint}`}
                {!summary.webhooksSigned && (
                  <span className="text-yellow-700">
                    · webhooks unsigned: events are checked against your users before they count, and a START reply cannot undo a STOP
                  </span>
                )}
              </p>
            )}
            {tab === 'interakt' && (
              <p className="rounded-md border border-yellow-300 bg-yellow-50 p-2 text-xs text-yellow-900">
                Interakt has no API to list templates, so campaigns take the
                template's code name and language as you typed them, unchecked.
              </p>
            )}
            {manages && (
            <>
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((field) => (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={`wa-${tab}-${field.key}`}>
                    {field.label}{field.optional ? ' (optional)' : ''}
                  </Label>
                  <Input
                    id={`wa-${tab}-${field.key}`}
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    value={values[`${tab}.${field.key}`] ?? ''}
                    onChange={(e) => setValues({ ...values, [`${tab}.${field.key}`]: e.target.value })}
                  />
                  {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
                </div>
              ))}
            </div>
            <Button onClick={submit} disabled={connect.isPending || !complete}>
              {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {summary ? `Replace and use ${WHATSAPP_PROVIDER_LABEL[tab]}` : `Connect ${WHATSAPP_PROVIDER_LABEL[tab]}`}
            </Button>
            </>
            )}
            {!manages && !summary && (
              <p className="text-sm text-muted-foreground">Not connected. An owner or admin connects providers.</p>
            )}
          </TabsContent>
        </Tabs>

        {webhook && (
          <div className="mt-6 space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Webhook</p>
            <p className="text-xs text-muted-foreground">{WEBHOOK_HELP[tab]}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{shownValue(webhook, project)}</code>
              {manages && (
                <Button size="sm" variant="outline" onClick={() => copy(webhook)}>
                  <Copy className="h-3 w-3" />
                </Button>
              )}
            </div>
            {tab === 'meta' && status?.verifyToken && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Verify token</span>
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{shownValue(status.verifyToken, project)}</code>
                {manages && (
                  <Button size="sm" variant="outline" onClick={() => copy(status.verifyToken!)}>
                    <Copy className="h-3 w-3" />
                  </Button>
                )}
              </div>
            )}
            {!status?.webhooksReachable && (
              <p className="flex items-start gap-2 text-xs text-yellow-700">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                This API's public URL is a local address, so no provider can reach
                it. Messages still send, but delivery reports and STOP replies will
                not arrive until it is reachable (locally, a tunnel such as ngrok
                with API_BASE_URL set to it).
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function WhatsAppSettingsPanel({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6">
      <ProviderCard projectId={projectId} />
      <PolicyCard projectId={projectId} />
    </div>
  );
}
