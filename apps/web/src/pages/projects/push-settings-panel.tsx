import { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Upload,
  FlaskConical,
  KeyRound,
  Radio,
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  usePushConfigStatus,
  useConfigurePush,
  useTestSendPush,
  useUpdatePushSettings,
  useReachabilityLosses,
  useProjectChannels,
  useConfigureChannel,
  type TestSendResult,
  type PushChannel,
  type MiPushRegion,
} from '@/hooks/use-push-notifications';
import { toast } from '@/components/ui/use-toast';
import { format } from 'date-fns';
import { useCurrentProject } from '@/contexts/project-context';
import { can, shownValue } from '@/lib/project-role';

// Matches the tooltip styling `project-analytics.tsx` uses for its Recharts
// charts, so a trend line here doesn't look like it came from a different app.
const tooltipStyle = {
  backgroundColor: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
};

const REACHABILITY_WINDOWS = [7, 30, 90] as const;

// Every channel the API knows about, so the channels card has a label for
// whatever `supported` returns without needing a matching switch statement.
const CHANNEL_LABELS: Record<PushChannel, string> = {
  fcm: 'Firebase Cloud Messaging (FCM)',
  apns: 'Apple Push (APNs)',
  mi_push: 'Mi Push (Xiaomi/MIUI)',
  huawei: 'Huawei Push Kit',
  oppo: 'OPPO Push',
  vivo: 'Vivo Push',
  honor: 'Honor Push',
};

// Xiaomi splits its push service by region and does not proxy between them —
// picking the wrong one doesn't error, it just never reaches those devices.
const MI_PUSH_REGIONS: Array<{ value: MiPushRegion; label: string }> = [
  { value: 'india', label: 'India' },
  { value: 'global', label: 'Global' },
  { value: 'eea', label: 'EEA & UK' },
  { value: 'russia', label: 'Russia' },
];

interface PushSettingsPanelProps {
  projectId: string;
}

export function PushSettingsPanel({ projectId }: PushSettingsPanelProps) {
  const { project } = useCurrentProject();
  // Credentials and guardrails need `channels.manage`; a test send needs only `messaging.write`.
  const manages = can(project, 'channels.manage');
  const updateSettings = useUpdatePushSettings(projectId);
  const [capInput, setCapInput] = useState<string>('');
  const [capTouched, setCapTouched] = useState(false);
  const [quietStartInput, setQuietStartInput] = useState<string>('');
  const [quietStartTouched, setQuietStartTouched] = useState(false);
  const [quietEndInput, setQuietEndInput] = useState<string>('');
  const [quietEndTouched, setQuietEndTouched] = useState(false);
  const [maxSendsInput, setMaxSendsInput] = useState<string>('');
  const [maxSendsTouched, setMaxSendsTouched] = useState(false);
  const { data: configStatus, isLoading: configLoading } = usePushConfigStatus(projectId);
  const configurePush = useConfigurePush(projectId);
  const testSend = useTestSendPush(projectId);
  const {
    data: channels,
    isLoading: channelsLoading,
    isError: channelsIsError,
  } = useProjectChannels(projectId);
  const configureChannel = useConfigureChannel(projectId);

  const [reachabilityDays, setReachabilityDays] = useState<number>(30);
  const {
    data: reachability,
    isLoading: reachabilityLoading,
    isError: reachabilityIsError,
  } = useReachabilityLosses(projectId, reachabilityDays);

  const [fcmJson, setFcmJson] = useState('');
  const [configureError, setConfigureError] = useState<string | null>(null);

  // Unlike the guardrail fields above, there is no fetched value to fall
  // back to here — the API stores the app secret but never returns it, so
  // the field always starts blank, configured or not.
  const [miPushAppSecret, setMiPushAppSecret] = useState('');
  const [miPushPackageName, setMiPushPackageName] = useState('');
  const [miPushRegion, setMiPushRegion] = useState<MiPushRegion>('global');
  const [miPushTouched, setMiPushTouched] = useState(false);
  const [miPushError, setMiPushError] = useState<string | null>(null);

  const [testToken, setTestToken] = useState('');
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const isConfigured = !!configStatus?.configured;
  const isActive = isConfigured && !!configStatus?.isActive;
  // The server encrypts the service account at rest; if it can no longer be
  // decrypted, `configured` can still be true (a row exists) while
  // firebaseProjectId comes back null. That is a different, more actionable
  // problem than "nothing set up" and must not be reported as the same thing.
  const isUnreadable = isConfigured && !configStatus?.firebaseProjectId;

  const reachabilityChartData = (reachability?.daily ?? []).map((point) => ({
    ...point,
    label: format(new Date(point.date), 'MMM d'),
  }));

  // Each guardrail field shows its own pending edit until touched, then
  // falls back to the fetched value — the same pattern the frequency cap
  // already used, extended to the two new fields so a refetch can't
  // clobber an in-flight edit.
  const capValue = capTouched ? capInput : (configStatus?.frequencyCapPerDay ?? '').toString();
  const quietStartValue = quietStartTouched ? quietStartInput : (configStatus?.quietHoursStart ?? '');
  const quietEndValue = quietEndTouched ? quietEndInput : (configStatus?.quietHoursEnd ?? '');
  const maxSendsValue = maxSendsTouched ? maxSendsInput : (configStatus?.maxSendsPerMinute ?? '').toString();

  // A window is allowed to wrap midnight (22:00 -> 07:00 is the normal
  // overnight case), so start > end is not what makes it invalid — only one
  // side being set without the other is, per the API's "both or neither" rule.
  const quietHoursIncomplete =
    (quietStartValue.trim() === '') !== (quietEndValue.trim() === '');

  // The API enforces @IsInt() @Min(1); caught here so the user gets inline
  // feedback rather than a raw 400. `min={1}` on the input is only a native
  // form-validation hint, and this Save is an onClick, not a form submit —
  // a typed 0 would otherwise reach the server. 0 would mean "send nothing",
  // which is a different claim from the empty box's "no limit".
  const maxSendsInvalid =
    maxSendsValue.trim() !== '' &&
    !(Number.isInteger(Number(maxSendsValue)) && Number(maxSendsValue) >= 1);

  const supportedChannels = channels?.supported ?? [];
  const configuredChannels = channels?.configured ?? [];
  const miPushSupported = supportedChannels.includes('mi_push');
  const miPushConfigured = configuredChannels.includes('mi_push');
  // Same "don't yell at an untouched field" idea as quiet hours above, just
  // driven by an explicit flag rather than a which-side-is-empty check —
  // both fields being blank is this form's valid starting state, not an
  // error, so it can't double as the invalid signal the way it does there.
  const miPushIncomplete =
    miPushTouched && (miPushAppSecret.trim() === '' || miPushPackageName.trim() === '');

  const handleSaveGuardrails = async () => {
    if (quietHoursIncomplete || maxSendsInvalid) return;
    // Sent as one object because the API replaces all of it on every
    // request (`dto.field ?? null`) — omitting a field here would read as
    // "leave it alone" but actually clear it.
    const frequencyCapPerDay = capValue.trim() === '' ? null : Number(capValue);
    const quietHoursStart = quietStartValue.trim() === '' ? null : quietStartValue;
    const quietHoursEnd = quietEndValue.trim() === '' ? null : quietEndValue;
    const maxSendsPerMinute = maxSendsValue.trim() === '' ? null : Number(maxSendsValue);
    try {
      await updateSettings.mutateAsync({
        frequencyCapPerDay,
        quietHoursStart,
        quietHoursEnd,
        maxSendsPerMinute,
      });
      setCapTouched(false);
      setQuietStartTouched(false);
      setQuietEndTouched(false);
      setMaxSendsTouched(false);
      toast({
        title: 'Guardrails saved',
        description: 'Delivery limits for this project have been updated.',
      });
    } catch (err: any) {
      toast({
        title: 'Could not save',
        description: err?.response?.data?.message ?? 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleConfigure = async () => {
    if (!fcmJson.trim()) return;
    setConfigureError(null);
    try {
      await configurePush.mutateAsync(fcmJson);
      toast({ title: 'FCM configured', description: 'Push notifications are now active.' });
      setFcmJson('');
    } catch (err: any) {
      // Firebase's own rejection reason is the useful part of this error —
      // surface it rather than a generic "failed to configure" message.
      const msg = err?.response?.data?.message || 'Failed to configure FCM';
      setConfigureError(msg);
    }
  };

  const handleConfigureMiPush = async () => {
    if (miPushAppSecret.trim() === '' || miPushPackageName.trim() === '') {
      setMiPushTouched(true);
      return;
    }
    setMiPushError(null);
    try {
      await configureChannel.mutateAsync({
        provider: 'mi_push',
        credentials: {
          appSecret: miPushAppSecret.trim(),
          packageName: miPushPackageName.trim(),
          region: miPushRegion,
        },
      });
      toast({
        title: 'Mi Push configured',
        description:
          "Devices that support Mi Push will now receive it instead of FCM — never both.",
      });
      // The API never hands the secret back, so there is nothing to
      // repopulate the field with — clear the form the same way the FCM
      // upload does on success, rather than leaving a secret sitting in state.
      setMiPushAppSecret('');
      setMiPushPackageName('');
      setMiPushRegion('global');
      setMiPushTouched(false);
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Failed to configure Mi Push';
      setMiPushError(msg);
    }
  };

  const handleTestSend = async (dryRun: boolean) => {
    if (!testToken.trim()) return;
    setTestError(null);
    setTestResult(null);
    try {
      const result = await testSend.mutateAsync({ token: testToken.trim(), dryRun });
      setTestResult(result);
      if (result.delivered) {
        toast({
          title: dryRun ? 'Validated' : 'Delivered',
          description: dryRun
            ? 'Firebase accepted the credentials and message. Nothing was delivered.'
            : 'Firebase accepted the message for delivery to that device.',
        });
      } else {
        toast({
          title: result.errorCode ?? 'Rejected by Firebase',
          description: result.error ?? 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (err: any) {
      setTestError(err?.response?.data?.message || 'Test send failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* Connection status — which account, not merely whether one exists. A
          key pasted from the wrong Firebase project is otherwise invisible
          until a real send fails with SENDER_ID_MISMATCH. */}
      <Card>
        <CardHeader>
          <CardTitle>Connection status</CardTitle>
          <CardDescription>
            The Firebase project this app is currently sending push through.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {configLoading ? (
            <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          ) : isUnreadable ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span className="font-medium">Stored credentials could not be decrypted</span>
              </div>
              <p className="text-sm text-muted-foreground">
                A service account is on file, but it can no longer be read back —
                this is not the same as nothing being configured. Re-upload the
                service account JSON below to fix it.
              </p>
            </div>
          ) : isConfigured ? (
            <div className="space-y-3">
              <div className={`flex items-center gap-2 ${isActive ? 'text-green-600' : 'text-muted-foreground'}`}>
                {isActive ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
                <span className="font-medium">
                  {isActive ? 'FCM is configured and active' : 'FCM is configured but not active'}
                </span>
              </div>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Firebase project</dt>
                <dd className="font-mono">{configStatus?.firebaseProjectId}</dd>
                {configStatus?.clientEmail && (
                  <>
                    <dt className="text-muted-foreground">Service account</dt>
                    <dd className="font-mono break-all">{shownValue(configStatus.clientEmail, project)}</dd>
                  </>
                )}
                {configStatus?.updatedAt && (
                  <>
                    <dt className="text-muted-foreground">Last updated</dt>
                    <dd>{format(new Date(configStatus.updatedAt), 'MMM d, yyyy HH:mm')}</dd>
                  </>
                )}
              </dl>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              <XCircle className="h-5 w-5" />
              <span>FCM not configured. Upload your Firebase service account JSON below to enable push notifications.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delivery channels beyond FCM. Only meaningful once FCM is set up —
          this project has no push provider at all otherwise. */}
      {isConfigured && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="h-5 w-5" />
              Delivery channels
            </CardTitle>
            <CardDescription>
              Every provider this deployment can send push through, and
              whether this project has credentials for it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {channelsLoading ? (
              <div className="h-8 w-48 animate-pulse rounded bg-muted" />
            ) : channelsIsError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Could not load channel status. Try refreshing the page.</span>
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {/* Only ever list a channel this deployment can actually
                      deliver on — the API rejects credentials for anything
                      else, so offering it here would just invite a rejected
                      paste. */}
                  {supportedChannels.map((channel) => (
                    <li
                      key={channel}
                      className="flex items-center justify-between rounded-lg border p-3 text-sm"
                    >
                      <span>{CHANNEL_LABELS[channel]}</span>
                      {configuredChannels.includes(channel) ? (
                        <Badge variant="secondary">Configured</Badge>
                      ) : (
                        <Badge variant="outline">Not configured</Badge>
                      )}
                    </li>
                  ))}
                </ul>

                {manages && miPushSupported && (
                  <>
                    <Separator />
                    <div className="space-y-4">
                      <div>
                        <p className="text-sm font-medium">Mi Push credentials</p>
                        <p className="text-xs text-muted-foreground">
                          FCM is configured above and stays the default. Mi
                          Push only matters on Xiaomi/MIUI devices, which
                          throttle background FCM hard enough that it often
                          doesn't arrive — on a device that has Mi Push
                          available, the server sends there <em>instead of</em>{' '}
                          FCM, never both, so nobody gets duplicate
                          notifications.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>App secret</Label>
                        <Input
                          type="password"
                          autoComplete="off"
                          placeholder={miPushConfigured ? '••••••••••••' : 'From the Xiaomi developer console'}
                          value={miPushAppSecret}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            setMiPushTouched(true);
                            setMiPushAppSecret(e.target.value);
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          From the Xiaomi developer console. The server
                          never returns a stored secret, so this stays
                          blank even when Mi Push is already configured —
                          leaving it as-is is not an option, only replacing it is.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>Package name</Label>
                        <Input
                          placeholder="com.example.app"
                          value={miPushPackageName}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            setMiPushTouched(true);
                            setMiPushPackageName(e.target.value);
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          The host app's Android package, exactly as
                          registered with Xiaomi. Mi Push rejects a send
                          without it.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>Region</Label>
                        <Select
                          value={miPushRegion}
                          onValueChange={(v) => setMiPushRegion(v as MiPushRegion)}
                        >
                          <SelectTrigger className="max-w-[16rem]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MI_PUSH_REGIONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* This is the field most likely to be gotten wrong
                            silently: a mismatch doesn't error, the message
                            just never shows up on real devices in that
                            region, with nothing in the response to say why. */}
                        <p className="text-xs text-muted-foreground">
                          Mi Push runs separate regional hosts that don't
                          proxy to each other. Sending Indian traffic to the
                          Global host fails for those users with no error to
                          explain it — match this to where your users
                          actually are, not where your team is.
                        </p>
                      </div>

                      {miPushIncomplete && (
                        <p className="text-xs text-destructive">
                          App secret and package name are both required.
                        </p>
                      )}
                      {miPushError && (
                        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span className="break-words">{miPushError}</span>
                        </div>
                      )}

                      <Button
                        variant="outline"
                        disabled={
                          configureChannel.isPending ||
                          !miPushAppSecret.trim() ||
                          !miPushPackageName.trim()
                        }
                        onClick={handleConfigureMiPush}
                      >
                        {configureChannel.isPending
                          ? 'Saving…'
                          : miPushConfigured
                            ? 'Replace Mi Push credentials'
                            : 'Save Mi Push credentials'}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Delivery guardrails. Only meaningful once FCM is set up. */}
      {isConfigured && (
        <Card>
          <CardHeader>
            <CardTitle>Delivery guardrails</CardTitle>
            <CardDescription>
              Limits applied to every campaign in this project.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <fieldset disabled={!manages} className="space-y-6">
            <div className="space-y-2">
              <Label>Maximum campaigns per device, per day</Label>
              <Input
                type="number"
                min={1}
                max={50}
                className="max-w-[10rem]"
                placeholder="No limit"
                value={capValue}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setCapTouched(true);
                  setCapInput(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for no limit. A device already at its limit is
                excluded from an audience, so campaign reach reflects the cap
                before you send. Counting is per person, not per device — one
                campaign reaching someone on three devices costs one slot.
              </p>
              <p className="text-xs text-muted-foreground">
                Setting a cap makes the server record which devices each
                campaign reached, which is what the limit counts. Clearing it
                stops that recording.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Quiet hours</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="time"
                  className="max-w-[10rem]"
                  value={quietStartValue}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setQuietStartTouched(true);
                    setQuietStartInput(e.target.value);
                  }}
                />
                <span className="text-sm text-muted-foreground">to</span>
                <Input
                  type="time"
                  className="max-w-[10rem]"
                  value={quietEndValue}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setQuietEndTouched(true);
                    setQuietEndInput(e.target.value);
                  }}
                />
                {(quietStartValue !== '' || quietEndValue !== '') && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQuietStartTouched(true);
                      setQuietStartInput('');
                      setQuietEndTouched(true);
                      setQuietEndInput('');
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
              {quietHoursIncomplete && (
                <p className="text-xs text-destructive">
                  Quiet hours need both a start and an end, or neither.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                No campaign is delivered to a recipient during this window,
                checked on their own clock, not yours. The window may cross
                midnight — 22:00 to 07:00 is a normal overnight window, not
                an error.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Maximum sends per minute</Label>
              <Input
                type="number"
                min={1}
                className="max-w-[10rem]"
                placeholder="No limit"
                value={maxSendsValue}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setMaxSendsTouched(true);
                  setMaxSendsInput(e.target.value);
                }}
              />
              {maxSendsInvalid && (
                <p className="text-xs text-destructive">
                  Enter a whole number of at least 1, or leave it empty for no
                  limit.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Throttles how fast a campaign is sent out, to stay under your
                provider's rate quota. Leave empty to send as fast as
                Firebase allows.
              </p>
            </div>

            </fieldset>
            {manages && (
              <Button
                variant="outline"
                disabled={
                  updateSettings.isPending || quietHoursIncomplete || maxSendsInvalid
                }
                onClick={handleSaveGuardrails}
              >
                {updateSettings.isPending ? 'Saving…' : 'Save'}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reachability. Only meaningful once FCM is set up — the endpoint is
          project-scoped and there is nothing to show otherwise. */}
      {isConfigured && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Reachability</CardTitle>
              <CardDescription>
                Devices this project has stopped being able to reach.
              </CardDescription>
            </div>
            <div className="flex gap-1">
              {REACHABILITY_WINDOWS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant={d === reachabilityDays ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setReachabilityDays(d)}
                >
                  {d}d
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {reachabilityLoading ? (
              <div className="space-y-4">
                <div className="h-14 w-40 animate-pulse rounded bg-muted" />
                <div className="h-40 animate-pulse rounded bg-muted" />
              </div>
            ) : reachabilityIsError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Could not load reachability data. Try refreshing the page.</span>
              </div>
            ) : reachability ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-6">
                  {/* The headline is deliberately the narrowest of the three
                      figures — see the note below on why the other two are
                      shown alongside it rather than folded into it. */}
                  <div>
                    <p className="text-xs text-muted-foreground">Likely uninstalls</p>
                    <p className="text-3xl font-bold">{reachability.likelyUninstalls.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">
                      in the last {reachability.sinceDays} days
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">Active tokens</dt>
                      <dd className="font-medium">{reachability.activeTokens.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Provider-rejected</dt>
                      <dd className="font-medium">{reachability.providerRejected.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Logouts / opt-outs</dt>
                      <dd className="font-medium">{reachability.appRequested.toLocaleString()}</dd>
                    </div>
                  </dl>
                </div>

                {/* These three numbers answer different questions and must
                    never be added together: a provider only ever reports
                    UNREGISTERED, never why, so providerRejected also counts
                    ordinary token rotations and overstates loss; likelyUninstalls
                    narrows that to rejections with no live token left on the
                    device, which is a lower bound, not a census; appRequested
                    is a logout or opt-out with the app still installed, so it
                    is never churn. */}
                <p className="text-xs text-muted-foreground">
                  Likely uninstalls is the narrowest, most defensible figure
                  here. Provider-rejected is a broader signal that also
                  includes ordinary token rotations, not just uninstalls —
                  treat it as an upper bound. Logouts and opt-outs are shown
                  for context only: the app is still installed, so they're
                  never counted as churn.
                </p>
                <p className="text-xs text-muted-foreground">
                  Tokens deactivated before this tracking began have no
                  recorded date or reason, so they aren't included in any of
                  these figures.
                </p>

                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Likely uninstalls by day
                  </p>
                  <div className="h-[180px]">
                    {reachabilityChartData.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        No losses recorded in this window
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={reachabilityChartData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                          <XAxis dataKey="label" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} tickMargin={4} />
                          <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={30} allowDecimals={false} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Area
                            type="monotone"
                            dataKey="likelyUninstalls"
                            stroke="var(--chart-1)"
                            fill="var(--chart-1)"
                            fillOpacity={0.1}
                            strokeWidth={2}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* Upload / replace credentials — inline, not a dialog. Owners and admins only. */}
      {manages && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            {isConfigured ? 'Replace credentials' : 'Upload credentials'}
          </CardTitle>
          <CardDescription>
            Paste the Firebase service account JSON from Project Settings &gt;
            Service Accounts &gt; Generate new private key. It is validated
            against Firebase before it is stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Service account JSON</Label>
            <Textarea
              value={fcmJson}
              onChange={(e) => {
                setFcmJson(e.target.value);
                if (configureError) setConfigureError(null);
              }}
              placeholder='{"project_id": "...", "private_key": "...", "client_email": "..."}'
              rows={8}
              // The pasted file is ~2.4KB with a single unbreakable ~1670-char
              // private-key line. Capping the height and scrolling inside the
              // field keeps that one paste from stretching the whole panel.
              className="max-h-[45vh] resize-y overflow-y-auto font-mono text-xs"
            />
          </div>
          {configureError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {/* Firebase's rejection reason, verbatim — this is the point of
                  server-side validation, so don't flatten it to a generic message. */}
              <span className="break-words">{configureError}</span>
            </div>
          )}
          <Button onClick={handleConfigure} disabled={configurePush.isPending || !fcmJson.trim()}>
            {configurePush.isPending ? 'Validating…' : isConfigured ? 'Save and replace' : 'Save configuration'}
          </Button>
        </CardContent>
      </Card>
      )}

      {/* Test send — the panel's most useful output is a failed test, so its
          result is rendered inline rather than only as a toast. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5" />
            Test send
          </CardTitle>
          <CardDescription>
            Check this project's Firebase setup against one device without
            creating a campaign.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Device registration token</Label>
            <Textarea
              value={testToken}
              onChange={(e) => {
                setTestToken(e.target.value);
                if (testResult || testError) {
                  setTestResult(null);
                  setTestError(null);
                }
              }}
              placeholder="Paste an FCM registration token from a device running your app"
              rows={3}
              className="max-h-[30vh] resize-y overflow-y-auto font-mono text-xs"
            />
            <p className="flex items-start gap-1 text-xs text-muted-foreground">
              <KeyRound className="mt-0.5 h-3 w-3 shrink-0" />
              Validate only asks Firebase to check the credentials and message
              without delivering anything to the device. Deliver actually sends it.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => handleTestSend(true)}
              disabled={testSend.isPending || !testToken.trim()}
            >
              Validate only
            </Button>
            <Button
              onClick={() => handleTestSend(false)}
              disabled={testSend.isPending || !testToken.trim()}
            >
              {testSend.isPending ? 'Sending…' : 'Deliver'}
            </Button>
          </div>

          {(testResult || testError) && (
            <>
              <Separator />
              {testError ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="break-words">{testError}</span>
                </div>
              ) : testResult?.delivered ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-600/30 bg-green-600/5 p-3 text-sm text-green-700">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    {testResult.dryRun
                      ? 'Firebase accepted the credentials and message. Nothing was delivered.'
                      : 'Firebase accepted the message for delivery to that device.'}
                  </span>
                </div>
              ) : (
                <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <div className="flex items-center gap-2 font-medium">
                    <XCircle className="h-4 w-4 shrink-0" />
                    Rejected by Firebase
                    {testResult?.errorCode && (
                      <code className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-xs">
                        {testResult.errorCode}
                      </code>
                    )}
                  </div>
                  {testResult?.error && <p className="break-words">{testResult.error}</p>}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
