import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, RefreshCw, Send, Trash2, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { toast } from '@/components/ui/use-toast';
import { useSegments } from '@/hooks/use-segments';
import {
  WhatsAppContent,
  WhatsAppTemplate,
  useSendWhatsAppCampaign,
  useTestSendWhatsApp,
  useWhatsAppAudiencePreview,
  useWhatsAppSettings,
  useWhatsAppTemplates,
} from '@/hooks/use-whatsapp';
import {
  contentProblem,
  emptyContent,
  fillPreview,
  fromTemplate,
} from '@/lib/whatsapp-content';

const errorText = (err: unknown) =>
  (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message?.toString() ?? 'Unknown error';

const evenWeights = (count: number) =>
  Array.from({ length: count }, (_, i) => Math.floor(100 / count) + (i < 100 % count ? 1 : 0));

const templateKey = (t: { id: string; language: string }) => `${t.id}::${t.language}`;

/**
 * Picks an approved template and fills its values — or, for a provider that
 * cannot list templates, takes the template's name, language and number of
 * values by hand.
 */
function TemplateEditor({
  value,
  onChange,
  templates,
  canList,
}: {
  value: WhatsAppContent;
  onChange: (next: WhatsAppContent) => void;
  templates: WhatsAppTemplate[];
  canList: boolean;
}) {
  const approved = templates.filter((t) => t.status === 'APPROVED');
  const selected = templates.find((t) => templateKey(t) === templateKey(value.template));

  const setParam = (index: number, text: string) =>
    onChange({ ...value, bodyParams: value.bodyParams.map((p, i) => (i === index ? text : p)) });

  return (
    <div className="space-y-4">
      {canList ? (
        <div className="space-y-2">
          <Label>Template</Label>
          <Select
            value={value.template.id ? templateKey(value.template) : ''}
            onValueChange={(key) => {
              const template = approved.find((t) => templateKey(t) === key);
              if (template) onChange(fromTemplate(template));
            }}
          >
            <SelectTrigger><SelectValue placeholder="Choose an approved template" /></SelectTrigger>
            <SelectContent>
              {approved.map((t) => (
                <SelectItem key={templateKey(t)} value={templateKey(t)}>
                  {t.name} · {t.language}{t.category ? ` · ${t.category.toLowerCase()}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {approved.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No approved templates yet. Create one in your provider's console and
              wait for Meta to approve it, then refresh.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-2">
            <Label>Template code name</Label>
            <Input
              placeholder="order_update"
              value={value.template.id}
              onChange={(e) =>
                onChange({ ...value, template: { ...value.template, id: e.target.value, name: e.target.value } })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Language</Label>
            <Input
              placeholder="en"
              value={value.template.language}
              onChange={(e) => onChange({ ...value, template: { ...value.template, language: e.target.value } })}
            />
          </div>
          <div className="space-y-2">
            <Label>Number of values</Label>
            <Input
              type="number"
              min={0}
              max={20}
              value={value.bodyParams.length}
              onChange={(e) => {
                const count = Math.max(0, Math.min(20, Number(e.target.value) || 0));
                onChange({
                  ...value,
                  bodyParams: Array.from({ length: count }, (_, i) => value.bodyParams[i] ?? ''),
                });
              }}
            />
          </div>
        </div>
      )}

      {selected?.header?.format === 'TEXT' && selected.header.paramCount > 0 && (
        <div className="space-y-2">
          <Label>Header value</Label>
          <Input value={value.headerText ?? ''} onChange={(e) => onChange({ ...value, headerText: e.target.value })} />
        </div>
      )}
      {(selected
        ? selected.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(selected.header.format)
        : !canList) && (
        <div className="space-y-2">
          <Label>
            Header {selected?.header ? selected.header.format.toLowerCase() : 'media'} URL
            {!selected && ' (only if the template has a media header)'}
          </Label>
          <Input
            placeholder="https://cdn.yourapp.com/banner.jpg"
            value={value.headerMediaUrl ?? ''}
            onChange={(e) => onChange({ ...value, headerMediaUrl: e.target.value })}
          />
        </div>
      )}

      {value.bodyParams.map((param, index) => (
        <div key={index} className="space-y-1">
          <Label>
            {value.template.paramNames?.[index] ? `{{${value.template.paramNames[index]}}}` : `{{${index + 1}}}`}
          </Label>
          <Input
            placeholder="{{firstName|there}}"
            value={param}
            onChange={(e) => setParam(index, e.target.value)}
          />
        </div>
      ))}

      {(value.buttonParams ?? []).map((param, index) => (
        <div key={`b${index}`} className="space-y-1">
          <Label>Link button {index + 1}: end of the URL</Label>
          <Input
            placeholder="summer-sale"
            value={param}
            onChange={(e) =>
              onChange({
                ...value,
                buttonParams: (value.buttonParams ?? []).map((p, i) => (i === index ? e.target.value : p)),
              })
            }
          />
        </div>
      ))}
    </div>
  );
}

export default function WhatsAppCampaignComposerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const backToList = `/projects/${projectId}/whatsapp`;

  const { data: status } = useWhatsAppSettings(projectId);
  const ready = !!status?.readyToSend;
  const { data: templateList, isFetching: templatesLoading } = useWhatsAppTemplates(projectId, ready);
  const canList = templateList?.canList ?? true;
  const templates = templateList?.templates ?? [];
  const { data: segments = [], isLoading: segmentsLoading } = useSegments(projectId);
  const preview = useWhatsAppAudiencePreview(projectId!);
  const send = useSendWhatsAppCampaign(projectId!);
  const testSend = useTestSendWhatsApp(projectId!);

  const [name, setName] = useState('');
  const [content, setContent] = useState<WhatsAppContent>(emptyContent());
  const [audience, setAudience] = useState<'project' | 'segment'>('project');
  const [segmentId, setSegmentId] = useState('');
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState<Date | undefined>();
  const [localTime, setLocalTime] = useState(false);
  const [localSendTime, setLocalSendTime] = useState('10:00');
  const [experiment, setExperiment] = useState(false);
  const [arms, setArms] = useState<Array<{ key: string; content: WhatsAppContent; weight: number }>>([]);
  const [controlPercentage, setControlPercentage] = useState(0);
  const [testTo, setTestTo] = useState('');

  const audienceInput = useMemo(() => (audience === 'segment' ? { segmentId } : {}), [audience, segmentId]);
  const { mutate: previewMutate } = preview;
  useEffect(() => {
    if (audience === 'segment' && !segmentId) return;
    previewMutate(audienceInput);
  }, [audience, segmentId, audienceInput, previewMutate]);

  const startExperiment = (on: boolean) => {
    setExperiment(on);
    if (on && arms.length === 0) {
      const [a, b] = evenWeights(2);
      setArms([
        { key: 'A', content, weight: a },
        { key: 'B', content: emptyContent(), weight: b },
      ]);
    }
  };
  const reweigh = (next: typeof arms) => {
    const weights = evenWeights(next.length);
    return next.map((arm, i) => ({ ...arm, key: String.fromCharCode(65 + i), weight: weights[i] }));
  };

  const selectedTemplate = templates.find(
    (t) => t.id === content.template.id && t.language === content.template.language,
  );
  const problem = contentProblem(content, canList ? selectedTemplate : undefined);
  const weightTotal = arms.reduce((sum, arm) => sum + Number(arm.weight || 0), 0);
  const armsValid =
    !experiment ||
    (arms.length >= 2 &&
      weightTotal === 100 &&
      arms.every((arm) =>
        !contentProblem(
          arm.content,
          canList ? templates.find((t) => t.id === arm.content.template.id && t.language === arm.content.template.language) : undefined,
        ),
      ));

  const reach = preview.data?.recipients;
  const canSend =
    ready &&
    !problem &&
    !(audience === 'segment' && !segmentId) &&
    !(later && !sendAt) &&
    armsValid &&
    reach !== 0;

  const withPreview = (c: WhatsAppContent): WhatsAppContent => {
    const template = templates.find((t) => t.id === c.template.id && t.language === c.template.language);
    return { ...c, previewText: template?.bodyText ?? c.previewText ?? null };
  };

  const submit = async () => {
    try {
      const result = await send.mutateAsync({
        name: name.trim() || undefined,
        content: withPreview(content),
        ...audienceInput,
        scheduledAt: later && sendAt ? sendAt.toISOString() : undefined,
        deliverInRecipientTimezone: localTime || undefined,
        localSendTime: localTime ? localSendTime : undefined,
        variants: experiment
          ? arms.map((arm) => ({ key: arm.key, title: arm.key, content: withPreview(arm.content), weight: Number(arm.weight) }))
          : undefined,
        controlPercentage: experiment ? controlPercentage : undefined,
      });
      toast({
        title: experiment ? 'Experiment created' : later || localTime ? 'Campaign scheduled' : 'Campaign queued',
        description: `${result.totalTokens} recipient(s).`,
      });
      navigate(backToList);
    } catch (err) {
      toast({ title: 'Could not create campaign', description: errorText(err), variant: 'destructive' });
    }
  };

  const sendTest = async () => {
    try {
      const result = await testSend.mutateAsync({ to: testTo.trim(), content: withPreview(content) });
      toast(
        result.delivered
          ? { title: 'Test sent', description: `Check WhatsApp on ${testTo}.` }
          : { title: 'Test failed', description: result.error, variant: 'destructive' },
      );
    } catch (err) {
      toast({ title: 'Test failed', description: errorText(err), variant: 'destructive' });
    }
  };

  const previewText = selectedTemplate ? fillPreview(selectedTemplate.bodyText, content.bodyParams, selectedTemplate.paramNames) : null;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={backToList}><ArrowLeft className="mr-1 h-4 w-4" /> WhatsApp</Link>
        </Button>
        <h1 className="mt-2 text-3xl font-bold">New WhatsApp campaign</h1>
      </div>

      {status && !ready && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm">
            WhatsApp is not set up yet. <Link className="underline" to={backToList}>Connect a provider</Link> first.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>Message</CardTitle>
                  <CardDescription>
                    Business-started WhatsApp messages must be templates Meta has
                    approved. Fill each value with text or personalisation such as{' '}
                    <code>{'{{firstName|there}}'}</code>.
                  </CardDescription>
                </div>
                {canList && ready && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Refresh templates"
                    onClick={() => queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', projectId] })}
                  >
                    <RefreshCw className={`h-4 w-4 ${templatesLoading ? 'animate-spin' : ''}`} />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="wa-name">Campaign name (optional)</Label>
                <Input id="wa-name" maxLength={255} placeholder="Defaults to the template name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <TemplateEditor value={content} onChange={setContent} templates={templates} canList={canList} />
              {problem && content.template.id && <p className="text-sm text-destructive">{problem}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Audience</CardTitle>
              <CardDescription>
                People with a phone number in international form who have not
                opted out of WhatsApp{status?.settings?.requireOptIn ?? true ? ', and who opted in' : ''}.
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
                    Nobody here can be messaged{preview.data?.requireOptIn ? ' (no one has opted in to WhatsApp yet)' : ''}.
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
                  <CardDescription>Compare templates or values. Scored on reads and attributed conversions.</CardDescription>
                </div>
                <Switch checked={experiment} onCheckedChange={startExperiment} />
              </div>
            </CardHeader>
            {experiment && (
              <CardContent className="space-y-4">
                {arms.map((arm, index) => (
                  <div key={arm.key} className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Arm {arm.key}</span>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          className="h-8 w-20"
                          value={arm.weight}
                          onChange={(e) =>
                            setArms(arms.map((a, i) => (i === index ? { ...a, weight: Number(e.target.value) } : a)))
                          }
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                        {arms.length > 2 && (
                          <Button size="sm" variant="ghost" onClick={() => setArms(reweigh(arms.filter((_, i) => i !== index)))}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <TemplateEditor
                      value={arm.content}
                      onChange={(next) => setArms(arms.map((a, i) => (i === index ? { ...a, content: next } : a)))}
                      templates={templates}
                      canList={canList}
                    />
                  </div>
                ))}
                {arms.length < 5 && (
                  <Button size="sm" variant="outline" onClick={() => setArms(reweigh([...arms, { key: '', content: emptyContent(), weight: 0 }]))}>
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
              <CardDescription>Personalisation is filled in per person.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-2xl border bg-[#e5ddd5] p-4 dark:bg-muted/40">
                {previewText ? (
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-tl-none bg-background px-3 py-2 text-sm shadow-sm">
                    {content.headerMediaUrl && (
                      <p className="mb-1 text-xs text-muted-foreground">[{selectedTemplate?.header?.format.toLowerCase() ?? 'media'}]</p>
                    )}
                    {previewText}
                    {selectedTemplate?.buttons.map((button) => (
                      <p key={button.text} className="mt-2 border-t pt-1 text-center text-xs text-sky-700">
                        {button.text}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {canList ? 'Choose a template to see it here.' : 'Interakt templates cannot be previewed here; test-send to see it.'}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Input placeholder="Send a test to +…" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                <Button
                  variant="outline"
                  onClick={sendTest}
                  disabled={!ready || testSend.isPending || !testTo.trim().startsWith('+') || !!problem}
                >
                  {testSend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
                </Button>
              </div>
              <Button className="w-full" onClick={submit} disabled={!canSend || send.isPending}>
                {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                {experiment ? 'Start experiment' : later || localTime ? 'Schedule campaign' : 'Send campaign'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
