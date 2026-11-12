import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Send, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { toast } from '@/components/ui/use-toast';
import { useSegments } from '@/hooks/use-segments';
import {
  SmsVariant,
  useSendSmsCampaign,
  useSmsAudiencePreview,
  useSmsSettings,
  useTestSendSms,
} from '@/hooks/use-sms';
import { countSegments, withOptOut } from '@/lib/sms-segments';

/** Twilio refuses longer bodies. */
const MAX_LENGTH = 1600;

const errorText = (err: unknown) =>
  (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message?.toString() ?? 'Unknown error';

const evenWeights = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    Math.floor(100 / count) + (i < 100 % count ? 1 : 0),
  );

/**
 * What a text will cost, counted on the message as sent — opt-out line
 * included — because that is what the carrier bills. Personalisation tokens
 * are counted as typed; a long first name can add a segment for some people.
 */
function SegmentMeter({ body, optOutText }: { body: string; optOutText: string | null | undefined }) {
  const sent = withOptOut(body, optOutText);
  const count = countSegments(sent);
  if (!body.trim()) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {count.units} {count.encoding === 'GSM-7' ? 'characters' : 'UCS-2 units'} ·{' '}
      <span className={count.segments > 2 ? 'font-medium text-yellow-700' : ''}>
        {count.segments} segment{count.segments === 1 ? '' : 's'} per text
      </span>{' '}
      · {count.remaining} left in this segment
      {count.unicodeCharacter && (
        <>
          {' '}· “{count.unicodeCharacter}” switches the whole text to Unicode, which fits
          70 characters per segment instead of 160
        </>
      )}
    </p>
  );
}

export default function SmsCampaignComposerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const backToList = `/projects/${projectId}/sms`;

  const { data: status } = useSmsSettings(projectId);
  const { data: segments = [], isLoading: segmentsLoading } = useSegments(projectId);
  const preview = useSmsAudiencePreview(projectId!);
  const send = useSendSmsCampaign(projectId!);
  const testSend = useTestSendSms(projectId!);

  const optOutText = status?.settings?.optOutText;

  const [name, setName] = useState('');
  const [body, setBody] = useState('Hi {{firstName|there}}, ');
  const [audience, setAudience] = useState<'project' | 'segment'>('project');
  const [segmentId, setSegmentId] = useState('');
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState<Date | undefined>();
  const [localTime, setLocalTime] = useState(false);
  const [localSendTime, setLocalSendTime] = useState('10:00');
  const [experiment, setExperiment] = useState(false);
  const [variants, setVariants] = useState<SmsVariant[]>([]);
  const [controlPercentage, setControlPercentage] = useState(0);
  const [testTo, setTestTo] = useState('');

  const audienceInput = useMemo(
    () => (audience === 'segment' ? { segmentId } : {}),
    [audience, segmentId],
  );

  const { mutate: previewMutate } = preview;
  useEffect(() => {
    if (audience === 'segment' && !segmentId) return;
    previewMutate(audienceInput);
  }, [audience, segmentId, audienceInput, previewMutate]);

  const startExperiment = (on: boolean) => {
    setExperiment(on);
    if (on && variants.length === 0) {
      const [a, b] = evenWeights(2);
      setVariants([
        { key: 'A', title: 'A', body, weight: a },
        { key: 'B', title: 'B', body: '', weight: b },
      ]);
    }
  };

  const setVariant = (index: number, patch: Partial<SmsVariant>) =>
    setVariants(variants.map((v, i) => (i === index ? { ...v, ...patch } : v)));

  const addVariant = () => {
    const key = String.fromCharCode(65 + variants.length);
    const next = [...variants, { key, title: key, body: '', weight: 0 }];
    const weights = evenWeights(next.length);
    setVariants(next.map((v, i) => ({ ...v, weight: weights[i] })));
  };

  const removeVariant = (index: number) => {
    const next = variants.filter((_, i) => i !== index);
    const weights = evenWeights(next.length);
    setVariants(
      next.map((v, i) => {
        const key = String.fromCharCode(65 + i);
        return { ...v, key, title: key, weight: weights[i] };
      }),
    );
  };

  const weightTotal = variants.reduce((sum, v) => sum + Number(v.weight || 0), 0);
  const variantsValid =
    !experiment ||
    (variants.length >= 2 && weightTotal === 100 && variants.every((v) => v.body.trim()));

  const reach = preview.data?.recipients;
  const canSend =
    !!status?.readyToSend &&
    body.trim() &&
    !(audience === 'segment' && !segmentId) &&
    !(later && !sendAt) &&
    variantsValid &&
    reach !== 0;

  const submit = async () => {
    try {
      const result = await send.mutateAsync({
        name: name.trim() || undefined,
        body: body.trim(),
        ...audienceInput,
        scheduledAt: later && sendAt ? sendAt.toISOString() : undefined,
        deliverInRecipientTimezone: localTime || undefined,
        localSendTime: localTime ? localSendTime : undefined,
        variants: experiment
          ? variants.map((v) => ({
              key: v.key,
              title: v.title,
              body: v.body.trim(),
              weight: Number(v.weight),
            }))
          : undefined,
        controlPercentage: experiment ? controlPercentage : undefined,
      });
      toast({
        title: experiment ? 'Experiment created' : later || localTime ? 'Text scheduled' : 'Text queued',
        description: `${result.totalTokens} recipient(s).`,
      });
      navigate(backToList);
    } catch (err) {
      toast({ title: 'Could not create text', description: errorText(err), variant: 'destructive' });
    }
  };

  const sendTest = async () => {
    try {
      const result = await testSend.mutateAsync({ to: testTo.trim(), body: body.trim() });
      toast(
        result.delivered
          ? { title: 'Test sent', description: `Check ${testTo}.` }
          : { title: 'Test failed', description: result.error, variant: 'destructive' },
      );
    } catch (err) {
      toast({ title: 'Test failed', description: errorText(err), variant: 'destructive' });
    }
  };

  const previewText = withOptOut(body, optOutText);

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={backToList}><ArrowLeft className="mr-1 h-4 w-4" /> SMS</Link>
        </Button>
        <h1 className="mt-2 text-3xl font-bold">New text</h1>
      </div>

      {status && !status.readyToSend && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm">
            SMS is not set up yet. <Link className="underline" to={backToList}>Finish setup</Link> first.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Message</CardTitle>
              <CardDescription>
                Personalise with <code>{'{{firstName}}'}</code> or{' '}
                <code>{'{{trait.plan|free}}'}</code>.
                {optOutText ? ` “${optOutText}” is added at the end.` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="sms-name">Campaign name (optional)</Label>
                <Input
                  id="sms-name"
                  maxLength={255}
                  placeholder="Shown in your campaign list; defaults to the start of the text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-body">Text</Label>
                <Textarea
                  id="sms-body"
                  rows={5}
                  maxLength={MAX_LENGTH}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <SegmentMeter body={body} optOutText={optOutText} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Audience</CardTitle>
              <CardDescription>
                People with a phone number in international form who have not
                replied STOP{status?.settings?.requireOptIn ? ', and who opted in' : ''}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select value={audience} onValueChange={(v) => setAudience(v as 'project' | 'segment')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">Everyone</SelectItem>
                  <SelectItem value="segment">A segment</SelectItem>
                </SelectContent>
              </Select>
              {audience === 'segment' && (
                <Select value={segmentId} onValueChange={setSegmentId} disabled={segmentsLoading}>
                  <SelectTrigger><SelectValue placeholder="Choose a segment" /></SelectTrigger>
                  <SelectContent>
                    {segments.map((seg) => (
                      <SelectItem key={seg.id} value={seg.id}>{seg.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="flex items-center gap-2 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                {preview.isPending ? (
                  <span className="text-muted-foreground">Counting…</span>
                ) : reach === undefined ? (
                  <span className="text-muted-foreground">Choose an audience to see its reach.</span>
                ) : reach === 0 ? (
                  <span className="text-destructive">
                    Nobody here can be texted
                    {preview.data?.requireOptIn ? ' (no one has opted in yet)' : ''}.
                  </span>
                ) : (
                  <span><strong>{reach}</strong> recipient(s)</span>
                )}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>When</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>Schedule for later</Label>
                <Switch checked={later} onCheckedChange={setLater} />
              </div>
              {later && <DateTimePicker value={sendAt} onChange={setSendAt} />}
              <div className="flex items-center justify-between">
                <div>
                  <Label>Deliver in each recipient's timezone</Label>
                  <p className="text-xs text-muted-foreground">
                    At this local time, one wave per timezone. Texts at night get
                    complaints, and some countries forbid them.
                  </p>
                </div>
                <Switch checked={localTime} onCheckedChange={setLocalTime} />
              </div>
              {localTime && (
                <Input type="time" value={localSendTime} onChange={(e) => setLocalSendTime(e.target.value)} className="w-32" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>A/B test</CardTitle>
                  <CardDescription>
                    Compare wordings. Scored on conversions attributed to each
                    arm, with an optional hold-out to measure lift.
                  </CardDescription>
                </div>
                <Switch checked={experiment} onCheckedChange={startExperiment} />
              </div>
            </CardHeader>
            {experiment && (
              <CardContent className="space-y-4">
                {variants.map((variant, index) => (
                  <div key={variant.key} className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Arm {variant.key}</span>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          className="h-8 w-20"
                          value={variant.weight}
                          onChange={(e) => setVariant(index, { weight: Number(e.target.value) })}
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                        {variants.length > 2 && (
                          <Button size="sm" variant="ghost" onClick={() => removeVariant(index)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <Textarea
                      rows={3}
                      maxLength={MAX_LENGTH}
                      placeholder="Text for this arm"
                      value={variant.body}
                      onChange={(e) => setVariant(index, { body: e.target.value })}
                    />
                    <SegmentMeter body={variant.body} optOutText={optOutText} />
                  </div>
                ))}
                {variants.length < 5 && (
                  <Button size="sm" variant="outline" onClick={addVariant}>
                    <Plus className="mr-1 h-4 w-4" /> Add arm
                  </Button>
                )}
                {weightTotal !== 100 && (
                  <p className="text-sm text-destructive">Weights add up to {weightTotal}%, not 100%.</p>
                )}
                <div className="flex items-center gap-2">
                  <Label className="whitespace-nowrap">Hold back as control</Label>
                  <Input
                    type="number"
                    min={0}
                    max={50}
                    className="h-8 w-20"
                    value={controlPercentage}
                    onChange={(e) => setControlPercentage(Number(e.target.value))}
                  />
                  <span className="text-xs text-muted-foreground">% sent nothing, to measure lift</span>
                </div>
              </CardContent>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>
                From {status?.settings?.sender ?? 'your Twilio sender'}. Tokens are
                filled in per person.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-2xl border bg-muted/40 p-4">
                {previewText ? (
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-background px-3 py-2 text-sm shadow-sm">
                    {previewText}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Your text appears here.</p>
                )}
              </div>
              <div className="flex gap-2">
                <Input placeholder="Send a test to +…" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                <Button
                  variant="outline"
                  onClick={sendTest}
                  disabled={!status?.readyToSend || testSend.isPending || !testTo.trim().startsWith('+') || !body.trim()}
                >
                  {testSend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
                </Button>
              </div>
              <Button className="w-full" onClick={submit} disabled={!canSend || send.isPending}>
                {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                {experiment ? 'Start experiment' : later || localTime ? 'Schedule text' : 'Send text'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
