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
  EmailVariant,
  useEmailAudiencePreview,
  useEmailSettings,
  useSendEmailCampaign,
  useTestSendEmail,
} from '@/hooks/use-email';

const STARTER_HTML = `<html>
  <body style="font-family: -apple-system, Segoe UI, sans-serif; color: #111827;">
    <h1>Hi {{firstName|there}},</h1>
    <p>Write your message here.</p>
    <p><a href="https://yourapp.com">Open the app</a></p>
  </body>
</html>`;

const errorText = (err: unknown) =>
  (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message?.toString() ?? 'Unknown error';

/** Weights that add to exactly 100, split as evenly as whole numbers allow. */
const evenWeights = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    Math.floor(100 / count) + (i < 100 % count ? 1 : 0),
  );

export default function EmailCampaignComposerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const backToList = `/projects/${projectId}/email`;

  const { data: status } = useEmailSettings(projectId);
  const { data: segments = [], isLoading: segmentsLoading } = useSegments(projectId);
  const preview = useEmailAudiencePreview(projectId!);
  const send = useSendEmailCampaign(projectId!);
  const testSend = useTestSendEmail(projectId!);

  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [html, setHtml] = useState(STARTER_HTML);
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<'project' | 'segment'>('project');
  const [segmentId, setSegmentId] = useState('');
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState<Date | undefined>();
  const [localTime, setLocalTime] = useState(false);
  const [localSendTime, setLocalSendTime] = useState('09:00');
  const [experiment, setExperiment] = useState(false);
  const [variants, setVariants] = useState<EmailVariant[]>([]);
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
        { key: 'A', title: subject, weight: a },
        { key: 'B', title: '', weight: b },
      ]);
    }
  };

  const setVariant = (index: number, patch: Partial<EmailVariant>) =>
    setVariants(variants.map((v, i) => (i === index ? { ...v, ...patch } : v)));

  const addVariant = () => {
    const next = [...variants, { key: String.fromCharCode(65 + variants.length), title: '', weight: 0 }];
    const weights = evenWeights(next.length);
    setVariants(next.map((v, i) => ({ ...v, weight: weights[i] })));
  };

  const removeVariant = (index: number) => {
    const next = variants.filter((_, i) => i !== index);
    const weights = evenWeights(next.length);
    setVariants(next.map((v, i) => ({ ...v, key: String.fromCharCode(65 + i), weight: weights[i] })));
  };

  const weightTotal = variants.reduce((sum, v) => sum + Number(v.weight || 0), 0);
  const variantsValid =
    !experiment ||
    (variants.length >= 2 && weightTotal === 100 && variants.every((v) => v.title.trim()));

  const reach = preview.data?.recipients;
  const canSend =
    !!status?.readyToSend &&
    subject.trim() &&
    html.trim() &&
    !(audience === 'segment' && !segmentId) &&
    !(later && !sendAt) &&
    variantsValid &&
    reach !== 0;

  const submit = async () => {
    try {
      const result = await send.mutateAsync({
        subject: subject.trim(),
        html,
        text: text.trim() || undefined,
        preheader: preheader.trim() || undefined,
        ...audienceInput,
        scheduledAt: later && sendAt ? sendAt.toISOString() : undefined,
        deliverInRecipientTimezone: localTime || undefined,
        localSendTime: localTime ? localSendTime : undefined,
        variants: experiment
          ? variants.map((v) => ({
              key: v.key,
              title: v.title.trim(),
              weight: Number(v.weight),
              ...(v.html?.trim() ? { html: v.html } : {}),
            }))
          : undefined,
        controlPercentage: experiment ? controlPercentage : undefined,
      });
      toast({
        title: experiment ? 'Experiment created' : later || localTime ? 'Email scheduled' : 'Email queued',
        description: `${result.totalTokens} recipient(s).`,
      });
      navigate(backToList);
    } catch (err) {
      toast({ title: 'Could not create email', description: errorText(err), variant: 'destructive' });
    }
  };

  const sendTest = async () => {
    try {
      const result = await testSend.mutateAsync({
        to: testTo.trim(),
        subject: subject.trim() || '(no subject)',
        html,
        text: text.trim() || undefined,
        preheader: preheader.trim() || undefined,
      });
      toast(
        result.delivered
          ? { title: 'Test sent', description: `Check ${testTo}.` }
          : { title: 'Test failed', description: result.error, variant: 'destructive' },
      );
    } catch (err) {
      toast({ title: 'Test failed', description: errorText(err), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={backToList}><ArrowLeft className="mr-1 h-4 w-4" /> Email</Link>
        </Button>
        <h1 className="mt-2 text-3xl font-bold">New email</h1>
      </div>

      {status && !status.readyToSend && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm">
            Email is not set up yet. <Link className="underline" to={backToList}>Finish setup</Link> first.
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
                <code>{'{{trait.plan|free}}'}</code>. Place the unsubscribe link
                with <code>{'{{unsubscribe_url}}'}</code>, or one is added to the footer.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="subject">Subject</Label>
                <Input id="subject" maxLength={255} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="preheader">Preview text (optional)</Label>
                <Input
                  id="preheader"
                  maxLength={255}
                  placeholder="Shown next to the subject in the inbox"
                  value={preheader}
                  onChange={(e) => setPreheader(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="html">HTML</Label>
                <Textarea
                  id="html"
                  rows={14}
                  className="font-mono text-xs"
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="text">Plain text (optional)</Label>
                <Textarea
                  id="text"
                  rows={4}
                  placeholder="Generated from the HTML when left empty"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Audience</CardTitle>
              <CardDescription>
                People with an email address who have not unsubscribed or bounced
                {status?.settings?.requireOptIn ? ', and who opted in' : ''}.
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
                    Nobody here can be emailed
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
                  <p className="text-xs text-muted-foreground">At this local time, one wave per timezone.</p>
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
                    Compare subjects or HTML. Results are scored on clicks and on
                    conversions attributed to each arm.
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
                    <Input
                      placeholder="Subject for this arm"
                      value={variant.title}
                      onChange={(e) => setVariant(index, { title: e.target.value })}
                    />
                    <Textarea
                      rows={3}
                      className="font-mono text-xs"
                      placeholder="HTML for this arm (optional, defaults to the message HTML)"
                      value={variant.html ?? ''}
                      onChange={(e) => setVariant(index, { html: e.target.value })}
                    />
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
                {subject || '(no subject)'}
                {preheader && <span className="text-muted-foreground"> — {preheader}</span>}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Sandboxed with no permissions: authored HTML must not run
                  script in the dashboard's origin. */}
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={html}
                className="h-[480px] w-full rounded-md border bg-white"
              />
              <div className="flex gap-2">
                <Input type="email" placeholder="Send a test to…" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                <Button
                  variant="outline"
                  onClick={sendTest}
                  disabled={!status?.readyToSend || testSend.isPending || !testTo.includes('@') || !html.trim()}
                >
                  {testSend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
                </Button>
              </div>
              <Button className="w-full" onClick={submit} disabled={!canSend || send.isPending}>
                {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                {experiment ? 'Start experiment' : later || localTime ? 'Schedule email' : 'Send email'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
