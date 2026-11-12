import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowUp, ArrowDown, Bell, DoorOpen, GitBranch, Loader2, Lock, Mail,
  MessageCircle, PauseCircle, Plus, Route, Save, Smartphone, Timer, Trash2, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  useJourney,
  useCreateJourney,
  useUpdateJourney,
  useSetJourneyStatus,
  MIN_WAIT_SECONDS,
  type Journey,
  type JourneyStep,
  type JourneyTrigger,
} from '@/hooks/use-journeys';
import { useSegments, type Segment } from '@/hooks/use-segments';
import { toast } from '@/components/ui/use-toast';
import { countSegments } from '@/lib/sms-segments';

/**
 * A step as edited in the form.
 *
 * The one difference from the API's `JourneyStep` is `id`. On the wire a
 * branch names its targets by step *index*, so every reorder and every delete
 * silently repoints every branch in the journey — someone swaps two steps and
 * a branch starts sending a different message than it did a moment ago, with
 * nothing on screen changing to say so. Holding a local identity instead and
 * converting to indexes only at the API boundary makes that class of bug
 * impossible to express: moving a step cannot change what any branch points
 * at, because no branch refers to a position.
 *
 * Deleting is the case identity cannot save, since the target genuinely stops
 * existing — see `removeStep`.
 */
interface WaitStepForm {
  id: string;
  type: 'wait';
  /** A string because it comes from a text input; seconds only in the payload. */
  amount: string;
  unit: WaitUnit;
}

interface PushStepForm {
  id: string;
  type: 'send_push';
  title: string;
  body: string;
  imageUrl: string;
  deepLinkUrl: string;
}

interface EmailStepForm {
  id: string;
  type: 'send_email';
  subject: string;
  html: string;
  preheader: string;
}

interface SmsStepForm {
  id: string;
  type: 'send_sms';
  body: string;
}

interface WhatsAppStepForm {
  id: string;
  type: 'send_whatsapp';
  /** Template name (Meta, Interakt), template id (Gupshup) or Content SID (Twilio). */
  templateId: string;
  language: string;
  /** One value per line, in placeholder order. */
  values: string;
}

interface BranchStepForm {
  id: string;
  type: 'branch';
  segmentId: string;
  /** The step this path leads to, by local id. Empty until one is chosen. */
  ifMemberId: string;
  ifNotId: string;
}

interface ExitStepForm {
  id: string;
  type: 'exit';
}

type StepForm =
  | WaitStepForm
  | PushStepForm
  | EmailStepForm
  | SmsStepForm
  | WhatsAppStepForm
  | BranchStepForm
  | ExitStepForm;

type WaitUnit = 'minutes' | 'hours' | 'days';

const WAIT_UNIT_SECONDS: Record<WaitUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/**
 * Unique within one editing session, which is all these need to be — they are
 * never sent anywhere. A counter rather than `crypto.randomUUID` so nothing
 * depends on a lib the app does not otherwise compile against.
 */
let stepIdCounter = 0;
function nextStepId(): string {
  stepIdCounter += 1;
  return `step-${stepIdCounter}`;
}

/** The values box as the template's values: one per non-empty line. */
function whatsappValues(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function toWaitSeconds(step: WaitStepForm): number {
  const amount = Number(step.amount);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * WAIT_UNIT_SECONDS[step.unit]);
}

/** Seconds back into the largest unit that divides them evenly, so a journey
 * saved as "3 days" reopens as 3 days rather than 259200 seconds. */
function splitDuration(seconds: number): { amount: string; unit: WaitUnit } {
  for (const unit of ['days', 'hours'] as const) {
    const size = WAIT_UNIT_SECONDS[unit];
    if (seconds >= size && seconds % size === 0) {
      return { amount: String(seconds / size), unit };
    }
  }
  return { amount: String(seconds / 60), unit: 'minutes' };
}

function createStep(type: StepForm['type']): StepForm {
  const id = nextStepId();
  switch (type) {
    case 'wait':
      return { id, type, amount: '1', unit: 'days' };
    case 'send_push':
      return { id, type, title: '', body: '', imageUrl: '', deepLinkUrl: '' };
    case 'send_email':
      return { id, type, subject: '', html: '', preheader: '' };
    case 'send_sms':
      return { id, type, body: '' };
    case 'send_whatsapp':
      return { id, type, templateId: '', language: 'en', values: '' };
    case 'branch':
      return { id, type, segmentId: '', ifMemberId: '', ifNotId: '' };
    case 'exit':
      return { id, type };
  }
}

/**
 * A saved journey's steps in the form's shape.
 *
 * A branch index outside the list collapses to an unchosen target rather than
 * being carried as a dangling number: validation then names it as a target to
 * pick, which is something a user can act on.
 */
function toStepForms(steps: JourneyStep[]): StepForm[] {
  const ids = steps.map(() => nextStepId());
  return steps.map((step, index): StepForm => {
    const id = ids[index];
    switch (step.type) {
      case 'wait':
        return { id, type: 'wait', ...splitDuration(step.durationSeconds) };
      case 'send_push':
        return {
          id,
          type: 'send_push',
          title: step.title,
          body: step.body ?? '',
          imageUrl: step.imageUrl ?? '',
          deepLinkUrl: step.deepLinkUrl ?? '',
        };
      case 'send_email':
        return {
          id,
          type: 'send_email',
          subject: step.subject,
          html: step.html,
          preheader: step.preheader ?? '',
        };
      case 'send_sms':
        return { id, type: 'send_sms', body: step.body };
      case 'send_whatsapp':
        return {
          id,
          type: 'send_whatsapp',
          templateId: step.content.template.id,
          language: step.content.template.language,
          values: step.content.bodyParams.join('\n'),
        };
      case 'branch':
        return {
          id,
          type: 'branch',
          segmentId: step.segmentId,
          ifMemberId: ids[step.ifMember] ?? '',
          ifNotId: ids[step.ifNot] ?? '',
        };
      case 'exit':
        return { id, type: 'exit' };
    }
  });
}

/** The form's steps as the API's index-addressed ones. Only ever called on a
 * list validation has already accepted, so no target resolves to -1. */
function toPayloadSteps(steps: StepForm[]): JourneyStep[] {
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  return steps.map((step): JourneyStep => {
    switch (step.type) {
      case 'wait':
        return { type: 'wait', durationSeconds: toWaitSeconds(step) };
      case 'send_push':
        return {
          type: 'send_push',
          title: step.title.trim(),
          body: step.body.trim() || undefined,
          imageUrl: step.imageUrl.trim() || undefined,
          deepLinkUrl: step.deepLinkUrl.trim() || undefined,
        };
      case 'send_email':
        return {
          type: 'send_email',
          subject: step.subject.trim(),
          html: step.html,
          preheader: step.preheader.trim() || undefined,
        };
      case 'send_sms':
        return { type: 'send_sms', body: step.body.trim() };
      case 'send_whatsapp':
        return {
          type: 'send_whatsapp',
          content: {
            template: { id: step.templateId.trim(), name: step.templateId.trim(), language: step.language.trim() },
            bodyParams: whatsappValues(step.values),
          },
        };
      case 'branch':
        return {
          type: 'branch',
          segmentId: step.segmentId,
          ifMember: indexById.get(step.ifMemberId) ?? -1,
          ifNot: indexById.get(step.ifNotId) ?? -1,
        };
      case 'exit':
        return { type: 'exit' };
    }
  });
}

/** One line naming what a step does, used in its header and — more
 * importantly — as the label of a branch target, so a path is chosen by what
 * it leads to rather than by a number. */
function describeStep(step: StepForm, segments: Segment[]): string {
  switch (step.type) {
    case 'wait': {
      const amount = step.amount.trim() || '0';
      return `Wait ${amount} ${step.unit}`;
    }
    case 'send_push':
      return step.title.trim() ? `Send push "${step.title.trim()}"` : 'Send push (untitled)';
    case 'send_email':
      return step.subject.trim() ? `Send email "${step.subject.trim()}"` : 'Send email (no subject)';
    case 'send_whatsapp':
      return step.templateId.trim() ? `Send WhatsApp "${step.templateId.trim()}"` : 'Send WhatsApp (no template)';
    case 'send_sms': {
      const text = step.body.trim();
      if (!text) return 'Send text (empty)';
      return `Send text "${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;
    }
    case 'branch': {
      const name = segments.find((s) => s.id === step.segmentId)?.name;
      return name ? `If in "${name}"` : 'Branch on a segment';
    }
    case 'exit':
      return 'Exit the journey';
  }
}

const STEP_ICONS: Record<StepForm['type'], typeof Timer> = {
  wait: Timer,
  send_push: Bell,
  send_email: Mail,
  send_sms: Smartphone,
  send_whatsapp: MessageCircle,
  branch: GitBranch,
  exit: DoorOpen,
};

/**
 * Verbatim port of the API's `nextStepIndexes` (see
 * `apps/api/.../journey-definition.ts`). Anything but a branch falls through
 * to the next step, and the last step ends the run.
 */
function nextStepIndexes(steps: JourneyStep[], index: number): number[] {
  const step = steps[index];
  if (!step || step.type === 'exit') return [];
  if (step.type === 'branch') return [step.ifMember, step.ifNot];
  return index + 1 < steps.length ? [index + 1] : [];
}

/**
 * Verbatim port of the API's `findCycle` — same contract as the other
 * `getXError` helpers: the message the action bar shows and the reason Save
 * is disabled.
 *
 * A cycle through a wait is legitimate and common ("check again tomorrow"),
 * so only cycles with no wait in them are refused: those advance a run as
 * fast as the runner can loop rather than over hours. Ported rather than
 * approximated because a client check that disagrees with the server would
 * either block a journey the API would have taken, or promise one it will
 * reject with a 400.
 */
function getLoopError(steps: StepForm[]): string | null {
  const payload = toPayloadSteps(steps);
  const VISITING = 1;
  const DONE = 2;
  const state = new Array<number>(payload.length).fill(0);

  const walk = (index: number): boolean => {
    if (payload[index]?.type === 'wait') return false;
    if (state[index] === VISITING) return true;
    if (state[index] === DONE) return false;

    state[index] = VISITING;
    for (const next of nextStepIndexes(payload, index)) {
      if (walk(next)) return true;
    }
    state[index] = DONE;
    return false;
  };

  for (let i = 0; i < payload.length; i += 1) {
    if (walk(i)) {
      return 'These steps can loop without waiting, which would run without end. '
        + 'Add a wait inside the loop.';
    }
  }
  return null;
}

/**
 * Client-side mirror of the API's `validateStep` — same contract as
 * `getLoopError`.
 *
 * The "target must exist" rule the API states as an index range is checked
 * here as a lookup: a branch can only name a step that is still in the list.
 */
function getStepError(step: StepForm, index: number, steps: StepForm[]): string | null {
  const at = `Step ${index + 1}`;
  const exists = (id: string) => steps.some((s) => s.id === id);

  switch (step.type) {
    case 'wait':
      if (toWaitSeconds(step) < MIN_WAIT_SECONDS) {
        return `${at}: a wait must be at least ${MIN_WAIT_SECONDS} seconds.`;
      }
      return null;
    case 'send_push':
      if (!step.title.trim()) return `${at}: a push needs a title.`;
      return null;
    case 'send_email':
      if (!step.subject.trim()) return `${at}: an email needs a subject.`;
      if (!step.html.trim()) return `${at}: an email needs a body.`;
      return null;
    case 'send_whatsapp':
      if (!step.templateId.trim()) return `${at}: a WhatsApp message needs a template.`;
      if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(step.language.trim())) {
        return `${at}: the template language is a code such as en or en_US.`;
      }
      return null;
    case 'send_sms':
      if (!step.body.trim()) return `${at}: a text message needs a body.`;
      if (step.body.length > 1600) return `${at}: a text message can be at most 1600 characters.`;
      return null;
    case 'branch':
      if (!step.segmentId.trim()) return `${at}: a branch needs a segment.`;
      if (!exists(step.ifMemberId)) return `${at}: choose where the member path goes.`;
      if (!exists(step.ifNotId)) return `${at}: choose where the non-member path goes.`;
      return null;
    case 'exit':
      return null;
  }
  return null;
}

/** Client-side mirror of the step half of the API's `validateJourney`, in the
 * same order it checks them, so the first thing the user is told to fix is
 * the first thing the server would have complained about. */
function getStepsError(steps: StepForm[]): string | null {
  if (steps.length === 0) return 'A journey needs at least one step.';
  for (const [index, step] of steps.entries()) {
    const problem = getStepError(step, index, steps);
    if (problem) return problem;
  }
  return getLoopError(steps);
}

/** Client-side mirror of the API's trigger checks — same contract as
 * `getLoopError`. */
function getTriggerError(trigger: JourneyTrigger): string | null {
  if (trigger.type === 'event' && !trigger.eventName.trim()) {
    return 'An event trigger needs an event name.';
  }
  if (trigger.type === 'segment_entry' && !trigger.segmentId.trim()) {
    return 'A segment trigger needs a segment.';
  }
  return null;
}

function getNameError(name: string): string | null {
  if (!name.trim()) return 'Name this journey.';
  return null;
}

/** Every branch path leading to a step, named the way the user sees them, for
 * the message explaining why the step cannot be deleted yet. */
function findReferencesTo(steps: StepForm[], targetId: string): string[] {
  const refs: string[] = [];
  steps.forEach((step, index) => {
    if (step.type !== 'branch') return;
    if (step.ifMemberId === targetId) refs.push(`step ${index + 1}'s member path`);
    if (step.ifNotId === targetId) refs.push(`step ${index + 1}'s non-member path`);
  });
  return refs;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The API's 400 body carries the real reason a save was refused, and
 * `class-validator` sends it as an array rather than a string. */
function describeError(err: unknown): string {
  const message = (err as { response?: { data?: { message?: unknown } } })
    ?.response?.data?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(' ');
  return 'Unknown error';
}

/**
 * Full-page journey editor, serving both `journeys/new` and
 * `journeys/:journeyId`.
 *
 * A page and not a dialog for the same reason the push composer is: a trigger
 * plus an ordered list of steps that point at each other cannot be read in a
 * modal, and a branch is only checkable against the steps it leads to.
 */
export default function JourneyEditorPage() {
  const { projectId, journeyId } = useParams<{ projectId: string; journeyId: string }>();
  const navigate = useNavigate();
  const backToList = `/projects/${projectId}/journeys`;

  // `new` is a route segment, never an id — treating it as one would send a
  // GET for a journey that cannot exist and render "not found" on a create.
  const isCreate = !journeyId || journeyId === 'new';

  const journeyQuery = useJourney(projectId, isCreate ? undefined : journeyId);
  const journey = journeyQuery.data;
  const {
    data: segmentsData,
    isLoading: segmentsLoading,
    isError: segmentsError,
  } = useSegments(projectId);
  const segments = segmentsData ?? [];

  const createJourney = useCreateJourney(projectId!);
  const updateJourney = useUpdateJourney(projectId!);
  const setJourneyStatus = useSetJourneyStatus(projectId!);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<JourneyTrigger['type']>('event');
  const [eventName, setEventName] = useState('');
  const [triggerSegmentId, setTriggerSegmentId] = useState('');
  const [steps, setSteps] = useState<StepForm[]>([]);

  // Which journey the form currently holds. Without it a background refetch
  // would overwrite whatever the user has typed with the saved version.
  const hydratedId = useRef<string | null>(null);
  useEffect(() => {
    if (!journey || hydratedId.current === journey.id) return;
    hydratedId.current = journey.id;
    setName(journey.name);
    setDescription(journey.description ?? '');
    setTriggerType(journey.trigger.type);
    setEventName(journey.trigger.type === 'event' ? journey.trigger.eventName : '');
    setTriggerSegmentId(
      journey.trigger.type === 'segment_entry' ? journey.trigger.segmentId : '',
    );
    setSteps(toStepForms(journey.steps));
  }, [journey]);

  const trigger: JourneyTrigger = triggerType === 'event'
    ? { type: 'event', eventName }
    : { type: 'segment_entry', segmentId: triggerSegmentId };

  // The API refuses every edit to an active journey, so the editor refuses
  // them too rather than letting someone type a change that can only end in a
  // 400 — with the pause that unblocks it offered right there.
  const isActive = journey?.status === 'active';
  const readOnly = isActive;

  const addStep = (type: StepForm['type']) => {
    setSteps((prev) => [...prev, createStep(type)]);
  };

  /**
   * Deletes a step, unless a branch leads to it.
   *
   * This is the one edit local ids cannot make safe: the target really is
   * gone, and every way of guessing a replacement — the step that slid into
   * its place, the one after it — is a guess about intent that would silently
   * change which message someone receives. Refusing and naming the paths that
   * have to be repointed first leaves the decision with the person who knows
   * the answer.
   */
  const removeStep = (id: string) => {
    const refs = findReferencesTo(steps, id);
    if (refs.length > 0) {
      toast({
        title: 'Repoint these branches first',
        description: `${capitalise(joinList(refs))} `
          + `lead${refs.length === 1 ? 's' : ''} to this step. `
          + 'Send them somewhere else, then delete it.',
        variant: 'destructive',
      });
      return;
    }
    setSteps((prev) => prev.filter((step) => step.id !== id));
  };

  /** Swaps a step with its neighbour. Branch targets are ids, so nothing a
   * branch points at moves with it. */
  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      next[index] = prev[target];
      next[target] = prev[index];
      return next;
    });
  };

  const patchWait = (id: string, patch: Partial<Omit<WaitStepForm, 'id' | 'type'>>) => {
    setSteps((prev) => prev.map((s) => (s.id === id && s.type === 'wait' ? { ...s, ...patch } : s)));
  };

  const patchPush = (id: string, patch: Partial<Omit<PushStepForm, 'id' | 'type'>>) => {
    setSteps((prev) => prev.map((s) => (
      s.id === id && s.type === 'send_push' ? { ...s, ...patch } : s
    )));
  };

  const patchEmail = (id: string, patch: Partial<Omit<EmailStepForm, 'id' | 'type'>>) => {
    setSteps((prev) => prev.map((s) => (
      s.id === id && s.type === 'send_email' ? { ...s, ...patch } : s
    )));
  };

  const patchSms = (id: string, patch: Partial<Omit<SmsStepForm, 'id' | 'type'>>) => {
    setSteps((prev) => prev.map((s) => (
      s.id === id && s.type === 'send_sms' ? { ...s, ...patch } : s
    )));
  };

  const patchWhatsApp = (id: string, patch: Partial<Omit<WhatsAppStepForm, 'id' | 'type'>>) => {
    setSteps((prev) => prev.map((s) => (
      s.id === id && s.type === 'send_whatsapp' ? { ...s, ...patch } : s
    )));
  };

  const patchBranch = (id: string, patch: Partial<Omit<BranchStepForm, 'id' | 'type'>>) => {
    setSteps((prev) => prev.map((s) => (
      s.id === id && s.type === 'branch' ? { ...s, ...patch } : s
    )));
  };

  const nameError = getNameError(name);
  const triggerError = getTriggerError(trigger);
  const stepsError = getStepsError(steps);
  const saving = createJourney.isPending || updateJourney.isPending;

  const canSave =
    !readOnly &&
    !saving &&
    !journeyQuery.isLoading &&
    nameError === null &&
    triggerError === null &&
    stepsError === null;

  // Restated next to the button, because a disabled Save with no reason on
  // screen is indistinguishable from a broken one — and for a journey the
  // reason is usually several steps further down the page.
  const actionBarMessage = (() => {
    if (readOnly) return 'This journey is active. Pause it before making changes.';
    if (nameError) return nameError;
    if (triggerError) return triggerError;
    if (stepsError) return stepsError;
    if (isCreate) return 'Saves as a draft — nobody is enrolled until you activate it.';
    return 'People already part-way through will resume against the edited steps.';
  })();

  const handleSubmit = async () => {
    if (!canSave) return;
    const input = {
      name: name.trim(),
      description: description.trim() || null,
      trigger: triggerType === 'event'
        ? ({ type: 'event', eventName: eventName.trim() } as const)
        : ({ type: 'segment_entry', segmentId: triggerSegmentId } as const),
      steps: toPayloadSteps(steps),
    };

    try {
      if (isCreate) {
        const created: Journey = await createJourney.mutateAsync(input);
        toast({
          title: 'Journey saved as a draft',
          description: 'Activate it from the journeys list when you want people to enter it.',
        });
        // Replaced rather than pushed: this page is now editing the journey
        // that was just created, and a second Save must update it rather than
        // create a duplicate.
        navigate(`/projects/${projectId}/journeys/${created.id}`, { replace: true });
      } else {
        await updateJourney.mutateAsync({ id: journeyId!, ...input });
        toast({ title: 'Journey updated' });
      }
    } catch (err) {
      toast({
        title: 'Could not save journey',
        description: describeError(err),
        variant: 'destructive',
      });
    }
  };

  const handlePause = async () => {
    try {
      await setJourneyStatus.mutateAsync({ id: journeyId!, status: 'paused' });
      toast({
        title: 'Journey paused',
        description: 'Nobody new enters it. People already inside will finish.',
      });
    } catch (err) {
      toast({
        title: 'Could not pause journey',
        description: describeError(err),
        variant: 'destructive',
      });
    }
  };

  if (!isCreate && journeyQuery.isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-48" />
        ))}
      </div>
    );
  }

  if (!isCreate && !journey) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(backToList)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to journeys
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p className="text-sm">
              Journey not found. It may have been deleted.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(backToList)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold">
            {isCreate ? 'New journey' : journey?.name || 'Journey'}
          </h1>
          <p className="text-muted-foreground mt-1">
            Choose what puts someone in, then the steps they move through.
          </p>
        </div>
      </div>

      {readOnly && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4" /> This journey is active
            </CardTitle>
            <CardDescription>
              People are part-way through the steps as they stand, so editing
              is closed while it runs. Pausing stops anyone new entering and
              lets everyone already inside finish — then the steps can change.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={handlePause}
              disabled={setJourneyStatus.isPending}
            >
              {setJourneyStatus.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PauseCircle className="mr-2 h-4 w-4" />
              )}
              Pause to edit
            </Button>
          </CardContent>
        </Card>
      )}

      {/* A disabled fieldset rather than a `disabled` prop on each of the
          dozens of controls below: one place to be right about read-only, and
          nothing new can be added later that forgets to honour it. */}
      <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-6 border-0 p-0">
        {/* ── 1. Basics ───────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Route className="h-5 w-5" /> Journey
            </CardTitle>
            <CardDescription>What this journey is for.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                maxLength={255}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Abandoned cart follow-up"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional — what this journey does and why."
                rows={2}
                className="max-h-32 resize-y"
              />
            </div>
          </CardContent>
        </Card>

        {/* ── 2. Trigger ──────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" /> Trigger
            </CardTitle>
            <CardDescription>What puts someone into this journey.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Enter when</Label>
                <Select
                  value={triggerType}
                  onValueChange={(v) => setTriggerType(v as JourneyTrigger['type'])}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="event">They do something</SelectItem>
                    <SelectItem
                      value="segment_entry"
                      disabled={!segmentsLoading && !segmentsError && segments.length === 0}
                    >
                      {segmentsLoading
                        ? 'They join a segment (loading…)'
                        : segmentsError
                          ? 'They join a segment (couldn’t load)'
                          : segments.length === 0
                            ? 'They join a segment (none defined)'
                            : 'They join a segment'}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {triggerType === 'event' ? (
                <div className="space-y-2">
                  <Label>Event name</Label>
                  <Input
                    value={eventName}
                    maxLength={255}
                    onChange={(e) => setEventName(e.target.value)}
                    placeholder="e.g. cart_abandoned"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Segment</Label>
                  <Select
                    value={triggerSegmentId}
                    onValueChange={setTriggerSegmentId}
                    disabled={segmentsLoading}
                  >
                    <SelectTrigger><SelectValue placeholder="Choose a segment" /></SelectTrigger>
                    <SelectContent>
                      {segments.map((seg) => (
                        <SelectItem key={seg.id} value={seg.id}>{seg.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {segmentsError && (
                    <p className="text-xs text-destructive">
                      Couldn&rsquo;t load segments. Reload the page to try again.
                    </p>
                  )}
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {triggerType === 'event'
                ? 'Anyone who fires this event enters the journey at step 1.'
                : 'Anyone who becomes a member of this segment enters the journey at step 1.'}
            </p>
          </CardContent>
        </Card>

        {/* ── 3. Steps ────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" /> Steps
            </CardTitle>
            <CardDescription>
              Run top to bottom. A step with nothing after it ends the journey,
              and a branch sends each path wherever you point it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {steps.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No steps yet. Add the first one below.
              </p>
            )}

            {steps.map((step, index) => {
              const StepIcon = STEP_ICONS[step.type];
              return (
                <div key={step.id} className="space-y-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant="secondary">Step {index + 1}</Badge>
                      <StepIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">
                        {describeStep(step, segments)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === 0}
                        onClick={() => moveStep(index, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeStep(step.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {step.type === 'wait' && (
                    <div className="flex items-end gap-2">
                      <div className="w-32 space-y-2">
                        <Label>Wait for</Label>
                        <Input
                          value={step.amount}
                          inputMode="decimal"
                          onChange={(e) => patchWait(step.id, { amount: e.target.value })}
                        />
                      </div>
                      <div className="w-40 space-y-2">
                        <Label>Unit</Label>
                        <Select
                          value={step.unit}
                          onValueChange={(v) => patchWait(step.id, { unit: v as WaitUnit })}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="minutes">minutes</SelectItem>
                            <SelectItem value="hours">hours</SelectItem>
                            <SelectItem value="days">days</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {step.type === 'send_push' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Title</Label>
                        <Input
                          value={step.title}
                          maxLength={255}
                          onChange={(e) => patchPush(step.id, { title: e.target.value })}
                          placeholder="Still thinking it over?"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Body</Label>
                        <Textarea
                          value={step.body}
                          onChange={(e) => patchPush(step.id, { body: e.target.value })}
                          placeholder="Optional"
                          rows={2}
                          className="max-h-32 resize-y"
                        />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Image URL</Label>
                          <Input
                            value={step.imageUrl}
                            onChange={(e) => patchPush(step.id, { imageUrl: e.target.value })}
                            placeholder="Optional"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Deep link</Label>
                          <Input
                            value={step.deepLinkUrl}
                            onChange={(e) => patchPush(step.id, { deepLinkUrl: e.target.value })}
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {step.type === 'send_email' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Subject</Label>
                        <Input
                          value={step.subject}
                          maxLength={255}
                          onChange={(e) => patchEmail(step.id, { subject: e.target.value })}
                          placeholder="Your cart is waiting, {{firstName|there}}"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Preview text</Label>
                        <Input
                          value={step.preheader}
                          maxLength={255}
                          onChange={(e) => patchEmail(step.id, { preheader: e.target.value })}
                          placeholder="Optional"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>HTML</Label>
                        <Textarea
                          value={step.html}
                          onChange={(e) => patchEmail(step.id, { html: e.target.value })}
                          placeholder="<p>Hi {{firstName}}, ...</p>"
                          rows={6}
                          className="font-mono text-xs"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Sent only if the person has an address, consent and no
                        unsubscribe. Anyone who can't be emailed moves on to the
                        next step.
                      </p>
                    </div>
                  )}

                  {step.type === 'send_whatsapp' && (
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-2 sm:col-span-2">
                          <Label>Template</Label>
                          <Input
                            value={step.templateId}
                            onChange={(e) => patchWhatsApp(step.id, { templateId: e.target.value })}
                            placeholder="order_shipped"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Language</Label>
                          <Input
                            value={step.language}
                            onChange={(e) => patchWhatsApp(step.id, { language: e.target.value })}
                            placeholder="en"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Values, one per line</Label>
                        <Textarea
                          value={step.values}
                          onChange={(e) => patchWhatsApp(step.id, { values: e.target.value })}
                          placeholder={'{{firstName|there}}\n{{trait.orderId}}'}
                          rows={3}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        The template's name for Meta and Interakt, its template ID for
                        Gupshup, or its Content SID (HX…) for Twilio. Checked against
                        your approved templates when the step sends. Anyone without
                        WhatsApp consent, or who opted out, moves on to the next step.
                      </p>
                    </div>
                  )}

                  {step.type === 'send_sms' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Text</Label>
                        <Textarea
                          value={step.body}
                          maxLength={1600}
                          onChange={(e) => patchSms(step.id, { body: e.target.value })}
                          placeholder="Hi {{firstName|there}}, your order has shipped."
                          rows={3}
                        />
                        {step.body.trim() && (
                          <p className="text-xs text-muted-foreground">
                            {countSegments(step.body.trim()).segments} segment(s) before the opt-out line.
                          </p>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Sent only if the person has a number with a country code,
                        SMS consent and no STOP. Anyone who can't be texted moves
                        on to the next step.
                      </p>
                    </div>
                  )}

                  {step.type === 'branch' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label>Segment</Label>
                        <Select
                          value={step.segmentId}
                          onValueChange={(v) => patchBranch(step.id, { segmentId: v })}
                          disabled={segmentsLoading}
                        >
                          <SelectTrigger><SelectValue placeholder="Choose a segment" /></SelectTrigger>
                          <SelectContent>
                            {segments.map((seg) => (
                              <SelectItem key={seg.id} value={seg.id}>{seg.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>If they are a member, go to</Label>
                          <Select
                            value={step.ifMemberId}
                            onValueChange={(v) => patchBranch(step.id, { ifMemberId: v })}
                          >
                            <SelectTrigger><SelectValue placeholder="Choose a step" /></SelectTrigger>
                            <SelectContent>
                              {steps.map((target, targetIndex) => (
                                <SelectItem key={target.id} value={target.id}>
                                  {targetIndex + 1}. {describeStep(target, segments)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>If they are not, go to</Label>
                          <Select
                            value={step.ifNotId}
                            onValueChange={(v) => patchBranch(step.id, { ifNotId: v })}
                          >
                            <SelectTrigger><SelectValue placeholder="Choose a step" /></SelectTrigger>
                            <SelectContent>
                              {steps.map((target, targetIndex) => (
                                <SelectItem key={target.id} value={target.id}>
                                  {targetIndex + 1}. {describeStep(target, segments)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Each path follows the step you chose, not its number —
                        reordering the list moves the step and the path with it.
                      </p>
                    </div>
                  )}

                  {step.type === 'exit' && (
                    <p className="text-sm text-muted-foreground">
                      Ends the journey here. Anyone reaching this step stops,
                      whatever comes after it in the list.
                    </p>
                  )}
                </div>
              );
            })}

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => addStep('wait')}>
                <Plus className="mr-2 h-4 w-4" /> Wait
              </Button>
              <Button type="button" variant="outline" onClick={() => addStep('send_push')}>
                <Plus className="mr-2 h-4 w-4" /> Send push
              </Button>
              <Button type="button" variant="outline" onClick={() => addStep('send_email')}>
                <Plus className="mr-2 h-4 w-4" /> Send email
              </Button>
              <Button type="button" variant="outline" onClick={() => addStep('send_sms')}>
                <Plus className="mr-2 h-4 w-4" /> Send text
              </Button>
              <Button type="button" variant="outline" onClick={() => addStep('send_whatsapp')}>
                <Plus className="mr-2 h-4 w-4" /> Send WhatsApp
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => addStep('branch')}
                disabled={!segmentsLoading && !segmentsError && segments.length === 0}
              >
                <Plus className="mr-2 h-4 w-4" /> Branch
              </Button>
              <Button type="button" variant="outline" onClick={() => addStep('exit')}>
                <Plus className="mr-2 h-4 w-4" /> Exit
              </Button>
            </div>
          </CardContent>
        </Card>
      </fieldset>

      {/* Sticky rather than fixed, for the same reason as the push composer:
          a fixed bar sits outside the dashboard's scroll container and covers
          the last field. */}
      <div className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 py-4">
          <p className="text-sm text-muted-foreground">{actionBarMessage}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(backToList)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!canSave}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {isCreate ? 'Save draft' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
