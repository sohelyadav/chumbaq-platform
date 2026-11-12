import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import {
  ArrowLeft, Loader2, Plus, Trash2, Users2, Activity, UserCircle,
  Braces, AlertTriangle, Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/use-toast';
import {
  useSegment, useCreateSegment, useUpdateSegment, usePreviewSegment,
  useEventNames, ATTRIBUTE_FIELDS, OP_LABELS, OCCURRENCE_LABELS,
  opsFor, opTakesNoValue, MAX_WITHIN_DAYS,
  MIN_REFRESH_MINUTES, MAX_REFRESH_MINUTES,
  type AttributeKind, type SegmentAttributeOp, type SegmentOccurrence,
  type SegmentEvaluationMode,
} from '@/hooks/use-segments';
import {
  toDefinition, fromDefinition, describeProblem, countRules,
  newEventRule, newAttributeRule, newGroupRule, newPropertyFilter,
  type RuleForm, type LeafRuleForm, type EventRuleForm, type AttributeRuleForm,
  type GroupRuleForm, type PropertyFilterForm,
} from '@/lib/segment-form';

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const message = err.response?.data?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }
  return 'Unknown error';
}

function kindOf(field: string): AttributeKind {
  return ATTRIBUTE_FIELDS.find((f) => f.field === field)?.kind ?? 'text';
}

/** A custom trait is anything not in the built-in list. */
const CUSTOM_FIELD = '__custom__';

// ─── Rule rows ────────────────────────────────────────────────────────────

function ValueInput({
  op, kind, value, onChange, placeholder,
}: {
  op: SegmentAttributeOp;
  kind: AttributeKind;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  // "is known" / "is unknown" compare against nothing, so offering a box to
  // type in would imply the value mattered.
  if (opTakesNoValue(op)) return null;

  if (kind === 'boolean') {
    return (
      <Select value={value || 'true'} onValueChange={onChange}>
        <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      className="w-[200px]"
      type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={
        placeholder ?? (op === 'in' ? 'india, nepal, sri lanka' : 'value')
      }
    />
  );
}

function PropertyFilterRow({
  filter, onChange, onRemove,
}: {
  filter: PropertyFilterForm;
  onChange: (next: PropertyFilterForm) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">where</span>
      <Input
        className="w-[160px]"
        value={filter.property}
        onChange={(e) => onChange({ ...filter, property: e.target.value })}
        placeholder="property name"
      />
      <Select
        value={filter.op}
        onValueChange={(op) => onChange({ ...filter, op: op as SegmentAttributeOp })}
      >
        <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'not_exists'] as SegmentAttributeOp[]).map((op) => (
            <SelectItem key={op} value={op}>{OP_LABELS[op]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Typed as text: an event property is free-form jsonb, so the editor
          cannot know whether `amount` is a number until someone types one.
          The conversion coerces it for ordered comparisons. */}
      <ValueInput op={filter.op} kind="text" value={filter.value}
        onChange={(value) => onChange({ ...filter, value })} />
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function EventRow({
  rule, eventNames, onChange, onRemove,
}: {
  rule: EventRuleForm;
  eventNames: string[];
  onChange: (next: EventRuleForm) => void;
  onRemove: () => void;
}) {
  const never = rule.occurrence === 'none';

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <Badge variant="secondary" className="gap-1.5">
          <Activity className="h-3 w-3" /> {never ? 'Did not' : 'Did'}
        </Badge>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {/* Controlled with "" rather than undefined: switching between the two
            makes React warn that the Select changed from uncontrolled to
            controlled, and Radix renders the placeholder for an empty root
            value anyway. (Only a SelectItem may not have an empty value.) */}
        <Select
          value={rule.eventName}
          onValueChange={(eventName) => onChange({ ...rule, eventName })}
        >
          <SelectTrigger className="w-[230px]">
            <SelectValue placeholder="choose an event" />
          </SelectTrigger>
          <SelectContent>
            {eventNames.length === 0 && (
              <SelectItem value="__none__" disabled>
                No events recorded yet
              </SelectItem>
            )}
            {eventNames.map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={rule.occurrence}
          onValueChange={(occurrence) =>
            onChange({ ...rule, occurrence: occurrence as SegmentOccurrence })
          }
        >
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(OCCURRENCE_LABELS) as SegmentOccurrence[]).map((o) => (
              <SelectItem key={o} value={o}>{OCCURRENCE_LABELS[o]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* "never" needs no count — a count of zero is the only thing it can
            mean, and an editable box would invite a contradiction. */}
        {!never && (
          <>
            <Input
              className="w-[80px]" type="number" min={0} value={rule.count}
              onChange={(e) => onChange({ ...rule, count: e.target.value })}
            />
            <span className="text-muted-foreground">
              {rule.count === '1' ? 'time' : 'times'}
            </span>
          </>
        )}

        <span className="text-muted-foreground">in the last</span>
        <Input
          className="w-[80px]" type="number" min={1} max={MAX_WITHIN_DAYS}
          value={rule.withinDays}
          onChange={(e) => onChange({ ...rule, withinDays: e.target.value })}
        />
        <span className="text-muted-foreground">days</span>
      </div>

      {rule.where.length > 0 && (
        <div className="space-y-2 border-l-2 pl-3">
          {rule.where.map((filter, i) => (
            <PropertyFilterRow
              key={filter.id}
              filter={filter}
              onChange={(next) => {
                const where = [...rule.where];
                where[i] = next;
                onChange({ ...rule, where });
              }}
              onRemove={() =>
                onChange({ ...rule, where: rule.where.filter((_, j) => j !== i) })
              }
            />
          ))}
        </div>
      )}

      <Button
        variant="ghost" size="sm" className="h-7 text-xs"
        onClick={() => onChange({ ...rule, where: [...rule.where, newPropertyFilter()] })}
      >
        <Plus className="mr-1 h-3 w-3" /> Filter on a property
      </Button>
    </div>
  );
}

function AttributeRow({
  rule, onChange, onRemove,
}: {
  rule: AttributeRuleForm;
  onChange: (next: AttributeRuleForm) => void;
  onRemove: () => void;
}) {
  const isCustom = rule.field.startsWith('traits.');
  const kind = isCustom ? 'text' : kindOf(rule.field);
  const allowed = opsFor(kind);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <Badge variant="secondary" className="gap-1.5">
          <UserCircle className="h-3 w-3" /> Profile
        </Badge>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select
          value={isCustom ? CUSTOM_FIELD : rule.field}
          onValueChange={(field) =>
            onChange(
              field === CUSTOM_FIELD
                ? { ...rule, field: 'traits.', op: 'eq' }
                // The operator may not survive the field change — "contains"
                // means nothing on a boolean — so fall back to the first one
                // the new type allows rather than sending an invalid pair.
                : {
                    ...rule,
                    field,
                    op: opsFor(kindOf(field)).includes(rule.op)
                      ? rule.op
                      : opsFor(kindOf(field))[0],
                  },
            )
          }
        >
          <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ATTRIBUTE_FIELDS.map((f) => (
              <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>
            ))}
            <SelectItem value={CUSTOM_FIELD}>Custom field…</SelectItem>
          </SelectContent>
        </Select>

        {isCustom && (
          <Input
            className="w-[170px]"
            value={rule.field.slice('traits.'.length)}
            onChange={(e) => onChange({ ...rule, field: `traits.${e.target.value}` })}
            placeholder="plan, tier, …"
          />
        )}

        <Select
          value={rule.op}
          onValueChange={(op) => onChange({ ...rule, op: op as SegmentAttributeOp })}
        >
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {allowed.map((op) => (
              <SelectItem key={op} value={op}>{OP_LABELS[op]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <ValueInput op={rule.op} kind={kind} value={rule.value}
          onChange={(value) => onChange({ ...rule, value })} />
      </div>
    </div>
  );
}

function GroupRow({
  rule, eventNames, onChange, onRemove,
}: {
  rule: GroupRuleForm;
  eventNames: string[];
  onChange: (next: GroupRuleForm) => void;
  onRemove: () => void;
}) {
  const setChild = (index: number, next: LeafRuleForm) => {
    const children = [...rule.children];
    children[index] = next;
    onChange({ ...rule, children });
  };
  const removeChild = (index: number) =>
    onChange({ ...rule, children: rule.children.filter((_, i) => i !== index) });

  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Match</span>
          <Select
            value={rule.operator}
            onValueChange={(operator) =>
              onChange({ ...rule, operator: operator as 'and' | 'or' })
            }
          >
            <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="or">any of</SelectItem>
              <SelectItem value="and">all of</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">these</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-3">
        {rule.children.map((child, i) =>
          child.kind === 'event' ? (
            <EventRow
              key={child.id} rule={child} eventNames={eventNames}
              onChange={(next) => setChild(i, next)} onRemove={() => removeChild(i)}
            />
          ) : (
            <AttributeRow
              key={child.id} rule={child}
              onChange={(next) => setChild(i, next)} onRemove={() => removeChild(i)}
            />
          ),
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm"
          onClick={() => onChange({ ...rule, children: [...rule.children, newEventRule()] })}>
          <Plus className="mr-1 h-3 w-3" /> Event
        </Button>
        <Button variant="outline" size="sm"
          onClick={() => onChange({ ...rule, children: [...rule.children, newAttributeRule()] })}>
          <Plus className="mr-1 h-3 w-3" /> Profile
        </Button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function SegmentEditorPage() {
  const { projectId, segmentId } = useParams<{ projectId: string; segmentId: string }>();
  const navigate = useNavigate();
  const isCreate = !segmentId;
  const backToList = `/projects/${projectId}/segments`;

  const { data: existing, isLoading } = useSegment(projectId, segmentId);
  const { data: eventNameRows } = useEventNames(projectId);
  const createSegment = useCreateSegment(projectId!);
  const updateSegment = useUpdateSegment(projectId!);
  const preview = usePreviewSegment(projectId!);

  const eventNames = useMemo(
    () => (eventNameRows ?? []).map((row) => row.eventName),
    [eventNameRows],
  );

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [matchAll, setMatchAll] = useState(true);
  const [rules, setRules] = useState<RuleForm[]>([]);
  const [evaluationMode, setEvaluationMode] = useState<SegmentEvaluationMode>('live');
  const [refreshMinutes, setRefreshMinutes] = useState('60');
  const [activate, setActivate] = useState(true);
  /** Set when a saved definition is richer than this editor can show. */
  const [unrepresentable, setUnrepresentable] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // One-shot: once the form is populated, re-running on every refetch would
  // discard whatever is being typed.
  useEffect(() => {
    if (isCreate) {
      if (!loaded) {
        setRules([newEventRule()]);
        setLoaded(true);
      }
      return;
    }
    if (!existing || loaded) return;

    setName(existing.name);
    setDescription(existing.description ?? '');
    setEvaluationMode(existing.evaluationMode);
    setRefreshMinutes(String(existing.refreshIntervalMinutes));
    setActivate(existing.status === 'active');

    const form = fromDefinition(existing.definition);
    if (form) {
      setMatchAll(form.matchAll);
      setRules(form.rules);
    } else {
      setUnrepresentable(true);
    }
    setLoaded(true);
  }, [existing, isCreate, loaded]);

  const problem = unrepresentable ? null : describeProblem(rules);
  const definition = useMemo(
    () => (problem || unrepresentable ? null : toDefinition(matchAll, rules)),
    [problem, unrepresentable, matchAll, rules],
  );

  // Debounced so a count is one request per pause in typing rather than one
  // per keystroke — each is a real query over events.
  const [count, setCount] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const definitionKey = definition ? JSON.stringify(definition) : null;

  useEffect(() => {
    if (!definitionKey || !projectId) {
      setCount(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      preview
        .mutateAsync(JSON.parse(definitionKey))
        .then((result) => {
          if (!cancelled) {
            setCount(result.count);
            setCountError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setCount(null);
            setCountError(errorMessage(err));
          }
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `preview` is a stable mutation object; depending on it would re-fire the
    // debounce on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitionKey, projectId]);

  const setRule = (index: number, next: RuleForm) => {
    const updated = [...rules];
    updated[index] = next;
    setRules(updated);
  };
  const removeRule = (index: number) =>
    setRules(rules.filter((_, i) => i !== index));

  const handleSave = async () => {
    if (name.trim() === '') {
      toast({ title: 'Give this audience a name', variant: 'destructive' });
      return;
    }
    if (!definition) {
      toast({
        title: 'This audience is not ready',
        description: problem ?? 'Its definition cannot be edited here.',
        variant: 'destructive',
      });
      return;
    }

    const refresh = Number(refreshMinutes);
    if (
      evaluationMode === 'materialized' &&
      (!Number.isInteger(refresh) ||
        refresh < MIN_REFRESH_MINUTES ||
        refresh > MAX_REFRESH_MINUTES)
    ) {
      toast({
        title: 'Check the refresh interval',
        description: `It must be a whole number of minutes between ${MIN_REFRESH_MINUTES} and ${MAX_REFRESH_MINUTES}.`,
        variant: 'destructive',
      });
      return;
    }

    const input = {
      name: name.trim(),
      description: description.trim() || undefined,
      definition,
      evaluationMode,
      refreshIntervalMinutes: refresh,
      status: activate ? ('active' as const) : ('draft' as const),
    };

    try {
      if (isCreate) {
        const created = await createSegment.mutateAsync(input);
        toast({ title: 'Audience created', description: created.name });
        navigate(`/projects/${projectId}/segments/${created.id}`);
      } else {
        await updateSegment.mutateAsync({ id: segmentId!, ...input });
        toast({ title: 'Audience saved' });
      }
    } catch (err) {
      toast({
        title: 'Could not save',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  };

  if (!isCreate && isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const saving = createSegment.isPending || updateSegment.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(backToList)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">
              {isCreate ? 'New audience' : existing?.name || 'Audience'}
            </h1>
            <p className="text-muted-foreground mt-1">
              Describe who belongs, from what they have done and who they are.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* The count is the one piece of feedback that tells a marketer
              whether the rules mean what they intended, so it stays visible
              while editing rather than hiding behind a preview button. */}
          <div className="min-w-[110px] text-right">
            <div className="text-2xl font-semibold tabular-nums">
              {countError || problem ? '—' : count === null ? '…' : count.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">
              {countError
                ? 'could not count'
                : problem
                  ? 'rules unfinished'
                  : count === null
                    ? 'counting…'
                    : 'people match'}
            </div>
          </div>
          <Button onClick={handleSave} disabled={saving || unrepresentable}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {isCreate ? 'Create audience' : 'Save'}
          </Button>
        </div>
      </div>

      {unrepresentable && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Braces className="h-4 w-4" /> This definition was not built here
            </CardTitle>
            <CardDescription>
              It nests more deeply, or negates a group, in a way this editor
              does not offer. Rather than flatten it — which would quietly
              change who the audience contains — it is shown as stored. Edit it
              through the API, or create a new audience to replace it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(existing?.definition, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      <fieldset
        disabled={unrepresentable}
        className="m-0 min-w-0 space-y-6 border-0 p-0"
      >
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users2 className="h-5 w-5" /> Audience
            </CardTitle>
            <CardDescription>What this audience is for.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name} maxLength={255}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Lapsed high-value buyers"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={description} rows={2}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Who this is, and why you would message them."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="mr-2">Rules</CardTitle>
              <span className="text-sm text-muted-foreground">Match</span>
              <Select
                value={matchAll ? 'and' : 'or'}
                onValueChange={(v) => setMatchAll(v === 'and')}
              >
                <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">all of</SelectItem>
                  <SelectItem value="or">any of</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">the following</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {rules.map((rule, i) =>
              rule.kind === 'group' ? (
                <GroupRow
                  key={rule.id} rule={rule} eventNames={eventNames}
                  onChange={(next) => setRule(i, next)} onRemove={() => removeRule(i)}
                />
              ) : rule.kind === 'event' ? (
                <EventRow
                  key={rule.id} rule={rule} eventNames={eventNames}
                  onChange={(next) => setRule(i, next)} onRemove={() => removeRule(i)}
                />
              ) : (
                <AttributeRow
                  key={rule.id} rule={rule}
                  onChange={(next) => setRule(i, next)} onRemove={() => removeRule(i)}
                />
              ),
            )}

            {rules.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No rules yet — this audience would match nobody.
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm"
                onClick={() => setRules([...rules, newEventRule()])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Event
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => setRules([...rules, newAttributeRule()])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Profile
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => setRules([...rules, newGroupRule()])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Group
              </Button>
              <span className="ml-auto self-center text-xs text-muted-foreground">
                {countRules(rules)} of 50 rules
              </span>
            </div>

            {problem && (
              <p className="flex items-start gap-2 pt-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {problem}
              </p>
            )}
            {countError && !problem && (
              <p className="flex items-start gap-2 pt-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {countError}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How it is kept up to date</CardTitle>
            <CardDescription>
              Live is always current and queried on demand. Materialised stores
              the membership on a schedule — slower to notice a change, but it
              is what records when somebody <em>entered</em>, which is what a
              segment-triggered journey needs to enrol them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label>Evaluation</Label>
                <Select
                  value={evaluationMode}
                  onValueChange={(v) => setEvaluationMode(v as SegmentEvaluationMode)}
                >
                  <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="live">Live</SelectItem>
                    <SelectItem value="materialized">Materialised</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {evaluationMode === 'materialized' && (
                <div className="space-y-2">
                  <Label>Refresh every</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      className="w-[100px]" type="number"
                      min={MIN_REFRESH_MINUTES} max={MAX_REFRESH_MINUTES}
                      value={refreshMinutes}
                      onChange={(e) => setRefreshMinutes(e.target.value)}
                    />
                    <span className="text-sm text-muted-foreground">minutes</span>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={activate ? 'active' : 'draft'}
                  onValueChange={(v) => setActivate(v === 'active')}
                >
                  <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {evaluationMode === 'materialized' && (
              <p className="text-xs text-muted-foreground">
                A materialised audience has no membership until its first
                refresh run, so it cannot be read straight away.
              </p>
            )}
          </CardContent>
        </Card>
      </fieldset>
    </div>
  );
}
