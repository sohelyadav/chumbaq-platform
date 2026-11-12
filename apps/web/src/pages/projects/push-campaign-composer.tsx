import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Users, Send, CalendarClock, Bell, Smartphone, Link2, Loader2,
  ChevronDown, FlaskConical, Plus, Trash2, Languages, FileText,
  MousePointerClick, X, Repeat, Images, Timer, ArrowUp, ArrowDown,
  Check, ChevronRight, AlertCircle, ClipboardList, Globe,
  LayoutTemplate, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useProjectUsers, type ProjectUser } from '@/hooks/use-project-users';
import {
  PUSH_PRESETS, LAYOUT_LABELS, pushContentCaveats,
  type ActionForm, type CarouselSlideForm,
  type TimerKind, type TimerDurationUnit,
  type PushPreset,
} from '@/lib/push-content';
import { PushPreview, type PreviewPlatform } from '@/components/push-preview';
import { PushTemplateGallery } from '@/components/push-template-gallery';
import {
  usePushConfigStatus,
  useSendPushNotification,
  useAudiencePreview,
  MIN_CAROUSEL_SLIDES,
  MAX_CAROUSEL_SLIDES,
  MIN_TIMER_DURATION_SECONDS,
  type PushAction,
  type PushDeliveryOptions,
  type PushVariant,
  type PushTranslations,
  type PushRecurrence,
  type RecurrenceFrequency,
  type PushCarouselSlide,
  type PushTimer,
} from '@/hooks/use-push-notifications';
import { usePushTemplates, type PushTemplate } from '@/hooks/use-push-templates';
import { useSegments } from '@/hooks/use-segments';
import { toast } from '@/components/ui/use-toast';

/** One experiment arm as edited in the form — always strings, trimmed and
 * turned into `undefined`/numbers only when building the send payload. */
interface VariantForm {
  key: string;
  title: string;
  body: string;
  imageUrl: string;
  deepLinkUrl: string;
  weight: number;
  /** This arm's own per-language copy. Translations are per-arm and not
   * campaign-wide because a shared translation would replace whatever copy
   * the arm is testing — the one thing an experiment must not do. */
  translations: TranslationForm[];
  /** The arm's draft language tag and its error, held on the arm rather than
   * beside it so adding or removing a variant keeps them paired with it. */
  newLang: string;
  newLangError: string | null;
}

/** One language's override for title/body, as edited in the form. Both are
 * optional at send time — the campaign's own copy fills whichever is blank —
 * but kept as plain strings here like every other form field. */
interface TranslationForm {
  lang: string;
  title: string;
  body: string;
}


/** Lowercased, hyphen-only form, so `PT_br` and `pt-BR` compare equal — the
 * same normalisation `pickTranslation` applies on the API. */
function normaliseLangTag(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase();
}

/**
 * True for a syntactically plausible BCP 47 tag (`hi`, `pt-BR`, `zh-Hans-CN`).
 * The API stores translation keys as opaque strings with no format check of
 * its own, so a typo here would not 400 — it would just silently never match
 * anyone. `Intl.getCanonicalLocales` throws on a malformed tag without
 * needing a dependency; it can't confirm the language is real, only that the
 * tag is well-formed.
 */
function isPlausibleLanguageTag(tag: string): boolean {
  try {
    Intl.getCanonicalLocales(tag.trim().replace(/_/g, '-'));
    return true;
  } catch {
    return false;
  }
}

/** Validates a new language tag against the existing list before it's added. */
function getNewTranslationError(tag: string, existing: TranslationForm[]): string | null {
  const trimmed = tag.trim();
  if (!trimmed) return 'Enter a language tag.';
  if (!isPlausibleLanguageTag(trimmed)) {
    return `"${trimmed}" doesn't look like a language tag — try "hi" or "pt-BR".`;
  }
  const normalised = normaliseLangTag(trimmed);
  if (existing.some((t) => normaliseLangTag(t.lang) === normalised)) {
    return `${trimmed} has already been added.`;
  }
  return null;
}

/**
 * A template's stored translations, back in the form's row shape.
 *
 * Collected through a Map keyed on the canonical tag because the API stores
 * translation keys as opaque strings: a template holding both `pt-BR` and
 * `pt_br` would otherwise open two rows the rest of this form treats as one
 * language.
 */
function toTranslationForms(translations: PushTranslations | null): TranslationForm[] {
  const rows = new Map<string, TranslationForm>();
  for (const [lang, copy] of Object.entries(translations ?? {})) {
    const canonical = isPlausibleLanguageTag(lang)
      ? Intl.getCanonicalLocales(lang.trim().replace(/_/g, '-'))[0]
      : lang;
    rows.set(canonical, { lang: canonical, title: copy.title ?? '', body: copy.body ?? '' });
  }
  return [...rows.values()];
}

/**
 * The rows a translations editor holds, as the API's map.
 *
 * A language whose fields are both blank is dropped rather than sent as empty
 * strings: an empty override would blank out the very copy it is supposed to
 * replace.
 */
function buildTranslationPayload(
  rows: TranslationForm[],
): PushTranslations | undefined {
  const payload: PushTranslations = {};
  for (const row of rows) {
    const title = row.title.trim();
    const body = row.body.trim();
    if (!title && !body) continue; // nothing entered for this language
    payload[row.lang] = { title: title || undefined, body: body || undefined };
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

interface TranslationsEditorProps {
  rows: TranslationForm[];
  newLang: string;
  newLangError: string | null;
  /** What a blank field falls back to — the campaign's copy, or the arm's. */
  titlePlaceholder: string;
  bodyPlaceholder: string;
  onNewLangChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, patch: Partial<TranslationForm>) => void;
}

/**
 * The add/remove-language editor, used by the campaign and by each experiment
 * arm.
 *
 * Shared rather than duplicated because the two differ only in whose copy
 * fills a blank field: canonicalisation, duplicate detection and the fallback
 * rule are identical, and two copies of them would drift apart.
 */
function TranslationsEditor({
  rows,
  newLang,
  newLangError,
  titlePlaceholder,
  bodyPlaceholder,
  onNewLangChange,
  onAdd,
  onRemove,
  onChange,
}: TranslationsEditorProps) {
  return (
    <>
      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((translation, index) => (
            <div key={translation.lang} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="secondary">{translation.lang}</Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={translation.title}
                  maxLength={255}
                  onChange={(e) => onChange(index, { title: e.target.value })}
                  placeholder={titlePlaceholder}
                />
              </div>
              <div className="space-y-2">
                <Label>Body</Label>
                <Textarea
                  value={translation.body}
                  onChange={(e) => onChange(index, { body: e.target.value })}
                  placeholder={bodyPlaceholder}
                  rows={2}
                  className="max-h-32 resize-y"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-2">
          <Label>Language tag</Label>
          <Input
            value={newLang}
            maxLength={35}
            onChange={(e) => onNewLangChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAdd();
              }
            }}
            placeholder="e.g. hi, pt-BR, ta"
          />
        </div>
        <Button type="button" variant="outline" onClick={onAdd}>
          <Plus className="mr-2 h-4 w-4" /> Add language
        </Button>
      </div>
      {newLangError && <p className="text-xs text-destructive">{newLangError}</p>}
    </>
  );
}

/**
 * Same contract as `getExperimentError` — the message the action bar shows
 * and the reason Send is disabled.
 *
 * Ids are compared trimmed but case-sensitively: the id is echoed back
 * verbatim on the click event, so `open` and `Open` really are two different
 * buttons and collapsing them here would reject a legitimate pair.
 */
function getActionsError(actions: ActionForm[]): string | null {
  if (actions.length === 0) return null;
  const ids = actions.map((a) => a.id.trim());
  if (ids.some((id) => !id)) return 'Every action button needs an id.';
  if (actions.some((a) => !a.title.trim())) return 'Every action button needs a title.';
  if (new Set(ids).size !== ids.length) return 'Action button ids must be unique.';
  return null;
}

/**
 * Same contract as `getActionsError` — the message the action bar shows and
 * the reason Send is disabled.
 *
 * Only the empty case is an error. A selection where nobody holds a token is
 * something a user can legitimately have built, and the reach panel already
 * says in as many words that it reaches nothing.
 */
function getDevicesError(selected: ProjectUser[]): string | null {
  if (selected.length === 0) return 'Choose at least one device to send to.';
  return null;
}

/**
 * Client-side mirror of the API's `validateCarousel` (see
 * `apps/api/.../rich-content.ts`) — same contract as `getActionsError`.
 *
 * An empty list is not an error: it means this campaign has no carousel, and
 * no `carousel` key is sent at all.
 */
function getCarouselError(slides: CarouselSlideForm[]): string | null {
  if (slides.length === 0) return null;
  if (slides.length < MIN_CAROUSEL_SLIDES) {
    return `A carousel needs at least ${MIN_CAROUSEL_SLIDES} slides — add another, `
      + 'or remove the last one to send without a carousel.';
  }
  if (slides.length > MAX_CAROUSEL_SLIDES) {
    return `A carousel supports at most ${MAX_CAROUSEL_SLIDES} slides.`;
  }
  // A slide with no image is a blank frame the recipient pages into.
  if (slides.some((slide) => !slide.imageUrl.trim())) {
    return 'Every carousel slide needs an image.';
  }
  return null;
}


const TIMER_UNIT_SECONDS: Record<TimerDurationUnit, number> = {
  hours: 3600,
  days: 86400,
};

/**
 * The duration field as seconds. Null means the field is empty, which is "no
 * countdown" rather than an error; NaN means something was typed that is not a
 * usable number, which `getTimerError` reports.
 */
function getTimerDurationSeconds(amount: string, unit: TimerDurationUnit): number | null {
  if (!amount.trim()) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * TIMER_UNIT_SECONDS[unit]);
}

/**
 * Client-side mirror of the API's `validateTimer` — same contract as
 * `getActionsError`.
 *
 * A fixed end is checked against `scheduledAt`, when the campaign will
 * actually go out, never when it is being composed: a campaign booked for next
 * week with a countdown ending tomorrow passes every naive check and arrives
 * already expired. Undefined means an immediate send, which is exactly what
 * the API measures against when the payload carries no `scheduledAt`.
 *
 * A duration is deliberately not compared with the send time at all: it is
 * measured from whenever each send happens, so there is no send time it could
 * fall before. Only a floor applies, below which it is over before it is read.
 */
function getTimerError(
  kind: TimerKind,
  endsAt: Date | undefined,
  durationSeconds: number | null,
  scheduledAt: Date | undefined,
): string | null {
  if (kind === 'duration') {
    if (durationSeconds === null) return null; // no countdown on this campaign
    if (Number.isNaN(durationSeconds)) return 'Enter the countdown length as a number.';
    if (durationSeconds < MIN_TIMER_DURATION_SECONDS) {
      return `A countdown must last at least ${MIN_TIMER_DURATION_SECONDS / 60} minute — `
        + 'any shorter and it is over before anyone reads it.';
    }
    return null;
  }
  if (!endsAt) return null; // no countdown on this campaign
  const sendsAt = scheduledAt ?? new Date();
  if (endsAt.getTime() > sendsAt.getTime()) return null;
  return scheduledAt
    ? `The countdown ends before this campaign sends on ${scheduledAt.toLocaleString()}, `
      + 'so it would arrive already expired.'
    : 'The countdown has already ended, so it would arrive expired.';
}

/** First unused single letter, so a new arm doesn't collide with existing keys. */
function nextVariantKey(existingKeys: string[]): string {
  const used = new Set(existingKeys.map((k) => k.trim().toUpperCase()));
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return `V${existingKeys.length + 1}`;
}

/** Whole-percent weights for `count` arms that always sum to exactly 100 —
 * the remainder from integer division goes to the first arms. */
function evenSplit(count: number): number[] {
  const base = Math.floor(100 / count);
  const remainder = 100 - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function createVariant(key: string, weight: number): VariantForm {
  return {
    key,
    title: '',
    body: '',
    imageUrl: '',
    deepLinkUrl: '',
    weight,
    translations: [],
    newLang: '',
    newLangError: null,
  };
}

function createDefaultVariants(): VariantForm[] {
  const [a, b] = evenSplit(2);
  return [createVariant('A', a), createVariant('B', b)];
}

/** Clamps a raw input string to a whole number in [0, max]. */
function clampPercent(raw: string, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, Math.round(n)));
}

/**
 * Client-side mirror of the API's `validateVariants` (see
 * `apps/api/.../variant-assignment.ts`) — the server is still the source of
 * truth, but repeating its rules here means a marketer sees exactly why
 * Send is disabled instead of finding out from a 400 after submitting.
 */
function getExperimentError(
  campaignName: string,
  variants: VariantForm[],
  controlPercentage: number,
): string | null {
  if (!campaignName.trim()) return 'Name this experiment.';
  if (variants.length < 2) return 'An experiment needs at least two variants.';
  if (variants.length > 5) return 'An experiment supports at most five variants.';

  const keys = variants.map((v) => v.key.trim());
  if (keys.some((k) => !k)) return 'Every variant needs a key.';
  if (new Set(keys).size !== keys.length) return 'Variant keys must be unique.';
  if (variants.some((v) => !v.title.trim())) return 'Every variant needs a title.';
  if (variants.some((v) => !(v.weight > 0))) return 'Every variant needs a weight above zero.';

  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  if (Math.abs(total - 100) > 0.01) {
    return `Variant weights must total 100% — currently ${total}%.`;
  }

  if (controlPercentage < 0 || controlPercentage > 50) {
    return 'Control group must be between 0 and 50 percent.';
  }

  return null;
}

/** 0 = Sunday, matching the `daysOfWeek` the API expects. */
const WEEKDAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Every zone the browser knows, with UTC and the local one first.
 *
 * `Intl.supportedValuesOf` is ES2022 and this app compiles against ES2020, so
 * it is reached through a narrow local type instead of being assumed: a
 * browser without it gets a two-entry list rather than a blank page.
 */
const TIMEZONES: string[] = (() => {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  return [...new Set(['UTC', LOCAL_TIMEZONE, ...(intl.supportedValuesOf?.('timeZone') ?? [])])];
})();

/** Plural unit for a frequency, e.g. `weeks` for `weekly`. */
function recurrenceUnit(frequency: RecurrenceFrequency, plural: boolean): string {
  const unit = frequency === 'daily' ? 'day' : frequency === 'weekly' ? 'week' : 'month';
  return plural ? `${unit}s` : unit;
}

/**
 * Client-side mirror of the API's `validateRecurrence` (see
 * `apps/api/.../recurrence.ts`) — same contract as `getExperimentError`: the
 * message the action bar shows and the reason Send is disabled.
 *
 * `daysOfWeek` is not checked here because the form can only produce valid
 * ones, and an empty selection is a legitimate weekly rule ("the same weekday
 * each time"), not an error.
 */
function getRecurrenceError(
  interval: string,
  atTime: string,
  endsAt: Date | undefined,
  firstOccurrence: Date | undefined,
): string | null {
  const every = Number(interval);
  if (!interval.trim() || !Number.isInteger(every) || every < 1 || every > 52) {
    return 'Repeat every must be a whole number of periods between 1 and 52.';
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(atTime)) {
    return 'Give the time of day each occurrence fires at, as HH:MM.';
  }
  // A series that can never produce an occurrence would sit in the campaign
  // list looking scheduled while quietly sending nothing, ever.
  if (endsAt && endsAt.getTime() <= Date.now()) {
    return 'The end date has already passed, so no occurrence would ever fire.';
  }
  if (endsAt && firstOccurrence && endsAt.getTime() <= firstOccurrence.getTime()) {
    return 'The end date is on or before the first occurrence, so nothing would be sent.';
  }
  return null;
}

/**
 * The rule restated in plain language.
 *
 * Shown in the Schedule card and again next to Send, from one function, so
 * the two can never disagree about what was actually configured.
 */
function describeRecurrence(
  frequency: RecurrenceFrequency,
  interval: string,
  atTime: string,
  daysOfWeek: number[],
  timezone: string,
  endsAt: Date | undefined,
): string {
  const every = Number(interval);
  const cadence = every === 1
    ? `every ${recurrenceUnit(frequency, false)}`
    : `every ${every} ${recurrenceUnit(frequency, true)}`;
  const days = frequency === 'weekly' && daysOfWeek.length > 0
    ? ` on ${[...daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAYS[d].label).join(', ')}`
    : '';
  const ending = endsAt ? ` until ${endsAt.toLocaleDateString()}` : ' until you cancel it';
  return `${cadence}${days} at ${atTime} ${timezone}${ending}`;
}

/**
 * Full-page campaign composer.
 *
 * Deliberately a page and not a dialog: audience, content, deep link,
 * per-platform delivery options and scheduling do not fit in a modal, and a
 * marketer needs to see the whole campaign at once before sending something
 * irreversible to an entire install base.
 */
/**
 * The composer as stages rather than one page.
 *
 * Everything here used to be a single scroll: audience, message, action
 * buttons, rich content, delivery options and schedule, six cards deep, with
 * the send button at the bottom. That asks someone to hold the whole campaign
 * in their head at once and makes the irreversible action the thing you reach
 * by scrolling past everything else.
 *
 * The split follows the order the decisions are actually made in — who, what,
 * when — and puts the send behind a review that restates all three.
 */
type ComposerStep = 'audience' | 'message' | 'delivery' | 'review';

const COMPOSER_STEPS: Array<{
  key: ComposerStep;
  label: string;
  hint: string;
}> = [
  { key: 'audience', label: 'Audience', hint: 'Who receives it' },
  { key: 'message', label: 'Message', hint: 'What it says' },
  { key: 'delivery', label: 'Delivery', hint: 'When and how' },
  { key: 'review', label: 'Review', hint: 'Check, then send' },
];

function Stepper({
  current,
  furthest,
  problems,
  onSelect,
}: {
  current: ComposerStep;
  /** How far the user has reached; later steps are not selectable yet. */
  furthest: number;
  problems: Record<ComposerStep, string | null>;
  onSelect: (step: ComposerStep) => void;
}) {
  const currentIndex = COMPOSER_STEPS.findIndex((s) => s.key === current);

  return (
    <nav aria-label="Campaign steps" className="flex flex-wrap items-center gap-1">
      {COMPOSER_STEPS.map((step, index) => {
        const isCurrent = step.key === current;
        const isPast = index < currentIndex;
        // A problem is shown on any step already visited, not only the one
        // being edited: a countdown is validated against the send time, so
        // choosing a schedule in a later step can invalidate the message step
        // behind you. Surfacing it here beats reaching Review puzzled.
        const problem = index <= furthest ? problems[step.key] : null;
        const reachable = index <= furthest;

        return (
          <div key={step.key} className="flex items-center">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onSelect(step.key)}
              aria-current={isCurrent ? 'step' : undefined}
              className={[
                'flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors',
                reachable ? 'hover:bg-muted' : 'cursor-not-allowed opacity-50',
                isCurrent ? 'bg-muted' : '',
              ].join(' ')}
            >
              <span
                className={[
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                  problem
                    ? 'border-destructive bg-destructive text-destructive-foreground'
                    : isCurrent
                      ? 'border-primary bg-primary text-primary-foreground'
                      : isPast
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-muted-foreground/40 text-muted-foreground',
                ].join(' ')}
              >
                {problem ? (
                  <AlertCircle className="h-3.5 w-3.5" />
                ) : isPast ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="hidden sm:block">
                <span className="block text-sm font-medium leading-tight">{step.label}</span>
                <span className="block text-xs leading-tight text-muted-foreground">
                  {problem ?? step.hint}
                </span>
              </span>
            </button>
            {index < COMPOSER_STEPS.length - 1 && (
              <ChevronRight className="mx-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** One line of the review summary. */
function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2">
      <dt className="w-32 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
    </div>
  );
}

export default function PushCampaignComposerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const backToList = `/projects/${projectId}/push-notifications`;

  const { data: configStatus } = usePushConfigStatus(projectId);
  const {
    data: segmentsData,
    isLoading: segmentsLoading,
    isError: segmentsError,
  } = useSegments(projectId);
  const segments = segmentsData ?? [];
  // The gallery always has the built-in presets to show, so a loading state
  // for saved templates would be an empty row that fills in — not worth a
  // spinner. Only a genuine failure is surfaced.
  const { data: templatesData, isError: templatesError } =
    usePushTemplates(projectId);
  const templates = templatesData ?? [];
  const sendPush = useSendPushNotification(projectId!);
  const audiencePreview = useAudiencePreview(projectId!);

  const [step, setStep] = useState<ComposerStep>('audience');
  /** The furthest step reached, so the stepper can go back but not skip ahead. */
  const [furthestStep, setFurthestStep] = useState(0);

  const [audience, setAudience] = useState<'project' | 'segment' | 'devices'>('project');
  const [segmentId, setSegmentId] = useState('');
  // Device picker. The selection holds whole rows rather than ids so that a
  // chosen identity stays listed — and removable — once a search or a page
  // change has taken it out of the results below.
  const [selectedDevices, setSelectedDevices] = useState<ProjectUser[]>([]);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceSearchTerm, setDeviceSearchTerm] = useState('');
  const [showUnreachable, setShowUnreachable] = useState(false);
  const [devicePage, setDevicePage] = useState(1);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [deepLinkUrl, setDeepLinkUrl] = useState('');
  const [silent, setSilent] = useState(false);
  const [customData, setCustomData] = useState<Record<string, string>>({});
  const [templateId, setTemplateId] = useState('');
  /** Which preset the content came from, for the gallery's selected state. */
  const [presetId, setPresetId] = useState('');
  const [previewPlatform, setPreviewPlatform] = useState<PreviewPlatform>('android');
  const [pendingTemplate, setPendingTemplate] = useState<PushTemplate | null>(null);
  const [pendingPreset, setPendingPreset] = useState<PushPreset | null>(null);
  const [translations, setTranslations] = useState<TranslationForm[]>([]);
  const [newLang, setNewLang] = useState('');
  const [newLangError, setNewLangError] = useState<string | null>(null);
  const [experimentMode, setExperimentMode] = useState(false);
  const [variants, setVariants] = useState<VariantForm[]>([]);
  const [controlPercentage, setControlPercentage] = useState(0);
  const [sendAt, setSendAt] = useState<Date | undefined>(undefined);
  const [localTimeDelivery, setLocalTimeDelivery] = useState(false);
  const [localSendTime, setLocalSendTime] = useState('09:00');
  const [sendTimeOptimised, setSendTimeOptimised] = useState(false);

  // Repeat schedule. Kept as separate fields rather than one object because
  // `interval` comes from a text input and is only a number in the payload.
  const [recurring, setRecurring] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>('weekly');
  const [recurrenceInterval, setRecurrenceInterval] = useState('1');
  const [recurrenceAtTime, setRecurrenceAtTime] = useState('09:00');
  const [recurrenceDays, setRecurrenceDays] = useState<number[]>([]);
  const [recurrenceTimezone, setRecurrenceTimezone] = useState(LOCAL_TIMEZONE);
  const [recurrenceEndsAt, setRecurrenceEndsAt] = useState<Date | undefined>(undefined);

  // Delivery options, kept as strings because they come from text inputs.
  const [priority, setPriority] = useState<'default' | 'normal' | 'high'>('default');
  const [ttlSeconds, setTtlSeconds] = useState('');
  const [collapseKey, setCollapseKey] = useState('');
  const [androidChannelId, setAndroidChannelId] = useState('');
  const [androidSound, setAndroidSound] = useState('');
  const [iosSound, setIosSound] = useState('');
  const [iosBadge, setIosBadge] = useState('');
  const [iosThreadId, setIosThreadId] = useState('');
  const [deliveryOptionsOpen, setDeliveryOptionsOpen] = useState(false);

  // Buttons under the notification. Their own section rather than part of the
  // message, because they are rarely used and the two platforms build them
  // from different things — see the card below.
  const [actions, setActions] = useState<ActionForm[]>([]);
  const [iosCategory, setIosCategory] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false);

  // Content no provider carries, drawn by the client SDK from data keys. Its
  // own section because both are rare and neither replaces the message above.
  const [carousel, setCarousel] = useState<CarouselSlideForm[]>([]);
  const [timerKind, setTimerKind] = useState<TimerKind>('fixed');
  const [timerEndsAt, setTimerEndsAt] = useState<Date | undefined>(undefined);
  const [timerDurationAmount, setTimerDurationAmount] = useState('');
  const [timerDurationUnit, setTimerDurationUnit] = useState<TimerDurationUnit>('hours');
  const [timerExpiredTitle, setTimerExpiredTitle] = useState('');
  const [timerExpiredBody, setTimerExpiredBody] = useState('');
  const [richContentOpen, setRichContentOpen] = useState(false);

  const isScheduling = !!sendAt && sendAt.getTime() > Date.now();
  // The instant this campaign actually goes out, and precisely what the
  // payload sends as `scheduledAt` — a time already past is not held back, it
  // goes now. Anything checked against send time reads it from here, so the
  // check and the payload can never disagree about when that is.
  const scheduledSendAt = isScheduling ? sendAt : undefined;
  const isConfigured = configStatus?.configured && configStatus?.isActive;
  // Optimisation is a per-recipient-clock send by definition, so it implies
  // timezone delivery whether or not that switch was touched.
  const localDelivery = localTimeDelivery || sendTimeOptimised;

  // One request after typing stops, not one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDeviceSearchTerm(deviceSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [deviceSearch]);

  // A different filter renumbers the pages underneath you, so page 3 of the
  // old results would land somewhere arbitrary in the new ones.
  useEffect(() => {
    setDevicePage(1);
  }, [deviceSearchTerm, showUnreachable]);

  const {
    data: deviceResults,
    isLoading: devicesLoading,
    isError: devicesLoadError,
  } = useProjectUsers(
    projectId,
    {
      search: deviceSearchTerm || undefined,
      // `false` would ask for *only* unreachable identities; showing both
      // means sending no filter at all.
      pushEnabled: showUnreachable ? undefined : true,
      page: devicePage,
    },
    audience === 'devices',
  );
  const deviceRows = deviceResults?.data ?? [];
  const deviceMeta = deviceResults?.meta;
  const selectedDeviceIds = selectedDevices.map((u) => u.id);

  const previewMutate = audiencePreview.mutate;
  // Joined into a string so the effect re-runs when the selection actually
  // changes, rather than on every render — the array itself is new each time.
  const selectedDeviceKey = selectedDeviceIds.join(',');
  useEffect(() => {
    if (audience === 'segment' && !segmentId) return;
    if (audience === 'devices' && !selectedDeviceKey) return;
    previewMutate(
      audience === 'segment'
        ? { segmentId }
        : audience === 'devices'
          ? { deviceIdentityIds: selectedDeviceKey.split(',') }
          : {},
    );
  }, [audience, segmentId, selectedDeviceKey, previewMutate]);

  const buildDeliveryOptions = (): PushDeliveryOptions | undefined => {
    const options: PushDeliveryOptions = {};
    if (priority !== 'default') options.priority = priority;
    if (ttlSeconds.trim()) options.ttlSeconds = Number(ttlSeconds);
    if (collapseKey.trim()) options.collapseKey = collapseKey.trim();
    const android: NonNullable<PushDeliveryOptions['android']> = {};
    if (androidChannelId.trim()) android.channelId = androidChannelId.trim();
    if (androidSound.trim()) android.sound = androidSound.trim();
    if (Object.keys(android).length > 0) options.android = android;
    const ios: NonNullable<PushDeliveryOptions['ios']> = {};
    if (iosSound.trim()) ios.sound = iosSound.trim();
    if (iosBadge.trim()) ios.badge = Number(iosBadge);
    if (iosThreadId.trim()) ios.threadId = iosThreadId.trim();
    if (Object.keys(ios).length > 0) options.ios = ios;
    return Object.keys(options).length > 0 ? options : undefined;
  };

  // Everything applying a template would overwrite. Audience, schedule and
  // action buttons are left out on purpose: a template carries no such
  // content, so having filled them in is no reason to be warned.
  const hasContent =
    title.trim() !== '' ||
    body.trim() !== '' ||
    imageUrl.trim() !== '' ||
    deepLinkUrl.trim() !== '' ||
    silent ||
    translations.length > 0 ||
    Object.keys(customData).length > 0 ||
    buildDeliveryOptions() !== undefined;

  const applyDeliveryOptions = (options: PushDeliveryOptions | null) => {
    setPriority(options?.priority ?? 'default');
    setTtlSeconds(options?.ttlSeconds !== undefined ? String(options.ttlSeconds) : '');
    setCollapseKey(options?.collapseKey ?? '');
    setAndroidChannelId(options?.android?.channelId ?? '');
    setAndroidSound(options?.android?.sound ?? '');
    setIosSound(options?.ios?.sound ?? '');
    setIosBadge(options?.ios?.badge !== undefined ? String(options.ios.badge) : '');
    setIosThreadId(options?.ios?.threadId ?? '');
    // Expanded when the template actually set something, so copied transport
    // settings are visible rather than quietly changing how this campaign
    // behaves from behind a collapsed section.
    if (options && Object.keys(options).length > 0) setDeliveryOptionsOpen(true);
  };

  /**
   * Copies a template's content into the form.
   *
   * A copy, not a live binding: every field stays editable and the send
   * carries what is on screen, so editing the template later cannot rewrite
   * what an already-composed campaign said. `templateId` travels with the
   * send for one reason only — the API counts the use, which is what orders
   * this picker.
   */
  const applyTemplate = (template: PushTemplate) => {
    setTitle(template.title);
    setBody(template.body ?? '');
    setImageUrl(template.imageUrl ?? '');
    setDeepLinkUrl(template.deepLinkUrl ?? '');
    setCustomData(template.data ?? {});
    // An experiment can never be silent (see the toggle below), so a silent
    // template must not smuggle that back in behind a hidden switch.
    setSilent(experimentMode ? false : template.silent);
    applyDeliveryOptions(template.deliveryOptions);
    setTranslations(toTranslationForms(template.translations));
    setNewLangError(null);

    // Rich content, which a template could not carry until it had columns for
    // it — applying one used to silently drop buttons, slides and countdowns
    // and leave whatever the form already had.
    setActions(
      (template.actions ?? []).map((action) => ({
        id: action.id,
        title: action.title,
        deepLinkUrl: action.deepLinkUrl ?? '',
      })),
    );
    setIosCategory(template.iosCategory ?? '');
    setActionsOpen((template.actions ?? []).length > 0);
    setCarousel(
      (template.carousel ?? []).map((slide) => ({
        imageUrl: slide.imageUrl,
        caption: slide.caption ?? '',
        deepLinkUrl: slide.deepLinkUrl ?? '',
      })),
    );
    applyTimerDuration(template.timer?.durationSeconds);
    setRichContentOpen(
      (template.carousel ?? []).length > 0 || template.timer !== null,
    );

    setTemplateId(template.id);
    setPresetId('');
  };

  /**
   * Puts a countdown into the form as a duration.
   *
   * Only durations arrive here: the API refuses a fixed `endsAt` on a
   * template, because a reused template would hand every later campaign a
   * countdown that had already run out.
   */
  const applyTimerDuration = (seconds: number | undefined) => {
    if (!seconds) {
      setTimerKind('fixed');
      setTimerEndsAt(undefined);
      setTimerDurationAmount('');
      return;
    }
    setTimerEndsAt(undefined);
    setTimerKind('duration');
    // Whole days when it divides evenly, so "24 hours" reopens as 1 day
    // rather than as 24 of something.
    if (seconds % 86400 === 0) {
      setTimerDurationUnit('days');
      setTimerDurationAmount(String(seconds / 86400));
    } else {
      setTimerDurationUnit('hours');
      setTimerDurationAmount(String(Math.round(seconds / 3600)));
    }
  };

  /**
   * Fills the form from a preset.
   *
   * Presets land in the fields rather than bypassing them: a preset is a
   * starting point someone then edits, so everything it sets has to be
   * visible and changeable afterwards. It carries no `templateId` — nothing
   * was used, so nothing's usage count should move.
   */
  const applyPreset = (preset: PushPreset) => {
    const content = preset.content;
    setTitle(content.title);
    setBody(content.body ?? '');
    setImageUrl(content.imageUrl ?? '');
    setDeepLinkUrl(content.deepLinkUrl ?? '');
    setCustomData(content.data ?? {});
    setSilent(experimentMode ? false : (content.silent ?? false));
    setTranslations([]);
    setNewLangError(null);

    setActions(content.actions ?? []);
    setIosCategory(content.iosCategory ?? '');
    setActionsOpen((content.actions ?? []).length > 0);
    setCarousel(content.carousel ?? []);
    applyTimerDuration(
      content.timerDurationHours ? content.timerDurationHours * 3600 : undefined,
    );
    setRichContentOpen(
      (content.carousel ?? []).length > 0 || !!content.timerDurationHours,
    );

    setTemplateId('');
    setPresetId(preset.id);
  };

  const handleTemplateSelect = (id: string) => {
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    // Applying replaces every content field, so a draft already in progress
    // would be gone without warning. An untouched form has nothing to lose.
    if (hasContent) {
      setPendingTemplate(template);
      return;
    }
    applyTemplate(template);
  };

  const handlePresetSelect = (preset: PushPreset) => {
    // Same guard as a saved template: applying rewrites every content field,
    // so a draft already in progress is confirmed before it is thrown away.
    if (hasContent) {
      setPendingPreset(preset);
      return;
    }
    applyPreset(preset);
  };

  /**
   * Returns to an empty campaign.
   *
   * Clears the content fields as well as the selection, because leaving a
   * preset's copy behind while saying "starting blank" would be a lie about
   * what is going to be sent.
   */
  const startBlank = () => {
    setTitle('');
    setBody('');
    setImageUrl('');
    setDeepLinkUrl('');
    setCustomData({});
    setSilent(false);
    setTranslations([]);
    setNewLangError(null);
    setActions([]);
    setIosCategory('');
    setActionsOpen(false);
    setCarousel([]);
    applyTimerDuration(undefined);
    setRichContentOpen(false);
    setTemplateId('');
    setPresetId('');
  };

  // Detaches the campaign from the template without touching the copy on
  // screen: deselecting shouldn't destroy work, it only stops `templateId`
  // being sent — and with it, this send counting towards the template.
  const clearTemplate = () => setTemplateId('');

  // Handled together because turning an experiment on removes the one thing
  // (a silent push) that a variant cannot meaningfully differ on — see the
  // note rendered next to the silent row below.
  const handleExperimentToggle = (checked: boolean) => {
    setExperimentMode(checked);
    if (checked) {
      setSilent(false);
      setVariants((prev) => (prev.length >= 2 ? prev : createDefaultVariants()));
    }
  };

  // Optimisation reads each recipient's own clock, so it can only work on a
  // per-timezone send — turning it on turns that on too, and the fixed local
  // time stops being what sets the hour (see the Schedule card).
  const handleSendTimeOptimisedToggle = (checked: boolean) => {
    setSendTimeOptimised(checked);
    if (checked) setLocalTimeDelivery(true);
  };

  const toggleRecurrenceDay = (day: number) => {
    setRecurrenceDays((prev) => (
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    ));
  };

  const addVariant = () => {
    setVariants((prev) => {
      if (prev.length >= 5) return prev;
      const key = nextVariantKey(prev.map((v) => v.key));
      const next = [...prev, createVariant(key, 0)];
      const weights = evenSplit(next.length);
      return next.map((v, i) => ({ ...v, weight: weights[i] }));
    });
  };

  const removeVariant = (index: number) => {
    setVariants((prev) => {
      if (prev.length <= 2) return prev;
      const next = prev.filter((_, i) => i !== index);
      const weights = evenSplit(next.length);
      return next.map((v, i) => ({ ...v, weight: weights[i] }));
    });
  };

  const evenSplitAll = () => {
    setVariants((prev) => {
      const weights = evenSplit(prev.length);
      return prev.map((v, i) => ({ ...v, weight: weights[i] }));
    });
  };

  const updateVariant = (index: number, patch: Partial<VariantForm>) => {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };

  const addTranslation = () => {
    const error = getNewTranslationError(newLang, translations);
    if (error) {
      setNewLangError(error);
      return;
    }
    // Canonicalised so a sloppily-cased or underscored entry (`PT_br`) is
    // stored and displayed the way the API's own docs write it (`pt-BR`).
    const canonical = Intl.getCanonicalLocales(newLang.trim().replace(/_/g, '-'))[0];
    setTranslations((prev) => [...prev, { lang: canonical, title: '', body: '' }]);
    setNewLang('');
    setNewLangError(null);
  };

  const removeTranslation = (index: number) => {
    setTranslations((prev) => prev.filter((_, i) => i !== index));
  };

  const updateTranslation = (index: number, patch: Partial<TranslationForm>) => {
    setTranslations((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  };

  // Same rules as the campaign-level editor above, applied to one arm's own
  // list — an arm's languages are validated against that arm only, so two
  // arms may perfectly well both carry `pt-BR`.
  const addVariantTranslation = (index: number) => {
    const variant = variants[index];
    const error = getNewTranslationError(variant.newLang, variant.translations);
    if (error) {
      updateVariant(index, { newLangError: error });
      return;
    }
    const canonical = Intl.getCanonicalLocales(variant.newLang.trim().replace(/_/g, '-'))[0];
    updateVariant(index, {
      translations: [...variant.translations, { lang: canonical, title: '', body: '' }],
      newLang: '',
      newLangError: null,
    });
  };

  const removeVariantTranslation = (index: number, langIndex: number) => {
    updateVariant(index, {
      translations: variants[index].translations.filter((_, i) => i !== langIndex),
    });
  };

  const updateVariantTranslation = (
    index: number,
    langIndex: number,
    patch: Partial<TranslationForm>,
  ) => {
    updateVariant(index, {
      translations: variants[index].translations.map((t, i) => (
        i === langIndex ? { ...t, ...patch } : t
      )),
    });
  };

  const addAction = () => {
    setActions((prev) => [...prev, { id: '', title: '', deepLinkUrl: '' }]);
  };

  const removeAction = (index: number) => {
    setActions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateAction = (index: number, patch: Partial<ActionForm>) => {
    setActions((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };

  // Opens on a whole carousel rather than a single slide: one slide is not a
  // carousel, so adding one would land straight in an invalid state the user
  // then has to fix before Send comes back.
  const addSlide = () => {
    setCarousel((prev) => {
      if (prev.length >= MAX_CAROUSEL_SLIDES) return prev;
      const blank: CarouselSlideForm = { imageUrl: '', caption: '', deepLinkUrl: '' };
      return prev.length === 0
        ? Array.from({ length: MIN_CAROUSEL_SLIDES }, () => ({ ...blank }))
        : [...prev, blank];
    });
  };

  const removeSlide = (index: number) => {
    setCarousel((prev) => prev.filter((_, i) => i !== index));
  };

  const updateSlide = (index: number, patch: Partial<CarouselSlideForm>) => {
    setCarousel((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  /** Swaps a slide with its neighbour — the list order is the paging order. */
  const moveSlide = (index: number, direction: -1 | 1) => {
    setCarousel((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      next[index] = prev[target];
      next[target] = prev[index];
      return next;
    });
  };

  const toggleDevice = (user: ProjectUser) => {
    setSelectedDevices((prev) => (
      prev.some((u) => u.id === user.id)
        ? prev.filter((u) => u.id !== user.id)
        : [...prev, user]
    ));
  };

  const removeDevice = (id: string) => {
    setSelectedDevices((prev) => prev.filter((u) => u.id !== id));
  };

  const removeDataKey = (key: string) => {
    setCustomData((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // A silent push has no visible copy, so a title is only required when the
  // notification will actually be shown. In experiment mode `title` doubles
  // as the campaign's internal name (see the Message card), so the same
  // check requires that instead.
  const missingTitle = !silent && !title.trim();
  const reach = audiencePreview.data?.totalTokens;
  const experimentError = experimentMode
    ? getExperimentError(title, variants, controlPercentage)
    : null;
  const actionsError = getActionsError(actions);
  const carouselError = getCarouselError(carousel);
  const timerDurationSeconds = getTimerDurationSeconds(timerDurationAmount, timerDurationUnit);
  const timerError = getTimerError(timerKind, timerEndsAt, timerDurationSeconds, scheduledSendAt);
  // Only the selected kind counts: a value left in the other kind's field is
  // never sent and must not switch the countdown on.
  const hasTimer = timerKind === 'duration' ? timerDurationSeconds !== null : !!timerEndsAt;
  // A carousel is invisible to an app build that doesn't draw one, and those
  // recipients fall back to the plain image — so a carousel with no image
  // behind it is worth pointing out. Each arm's own image counts too.
  const carouselHasNoStillFallback =
    carousel.length > 0 &&
    !imageUrl.trim() &&
    (!experimentMode || variants.some((v) => !v.imageUrl.trim()));
  const devicesError = audience === 'devices' ? getDevicesError(selectedDevices) : null;
  const recurrenceError = recurring
    ? getRecurrenceError(recurrenceInterval, recurrenceAtTime, recurrenceEndsAt, sendAt)
    : null;
  const recurrenceSummary = describeRecurrence(
    recurrenceFrequency,
    recurrenceInterval,
    recurrenceAtTime,
    recurrenceDays,
    recurrenceTimezone,
    recurrenceEndsAt,
  );

  // Recipients, not just percentages — control is carved off the whole
  // audience first, then each variant's weight is applied to what's left.
  const controlRecipients = reach !== undefined
    ? Math.round((reach * controlPercentage) / 100)
    : undefined;
  const treatedRecipients = reach !== undefined && controlRecipients !== undefined
    ? reach - controlRecipients
    : undefined;
  const variantRecipients = variants.map((v) => (
    treatedRecipients !== undefined ? Math.round((treatedRecipients * v.weight) / 100) : undefined
  ));
  const weightTotal = variants.reduce((sum, v) => sum + (Number.isFinite(v.weight) ? v.weight : 0), 0);
  const weightValid = Math.abs(weightTotal - 100) < 0.01;

  const canSend =
    isConfigured &&
    !missingTitle &&
    !(experimentMode && experimentError !== null) &&
    actionsError === null &&
    carouselError === null &&
    timerError === null &&
    recurrenceError === null &&
    !(audience === 'segment' && !segmentId) &&
    devicesError === null &&
    !audiencePreview.isPending &&
    !audiencePreview.isError &&
    reach !== undefined &&
    reach !== 0 &&
    !sendPush.isPending;

  // Restated next to the submit button — this is the last moment before an
  // irreversible send to a whole install base, so it must never be blank
  // about *why* sending is (or isn't) about to happen.
  const actionBarMessage = (() => {
    if (missingTitle) return experimentMode ? 'Name this experiment.' : 'A title is required.';
    if (experimentMode && experimentError) return experimentError;
    if (actionsError) return actionsError;
    if (carouselError) return carouselError;
    if (timerError) return timerError;
    if (recurrenceError) return recurrenceError;
    if (audience === 'segment' && !segmentId) return 'Choose a segment to see its reach.';
    if (devicesError) return devicesError;
    if (audiencePreview.isPending) return 'Calculating reach…';
    if (audiencePreview.isError) return "Couldn't calculate reach for this audience — try again.";
    if (reach === 0) return 'This audience has no reachable devices.';
    if (reach !== undefined) {
      // Recurrence comes first: a repeating campaign never sends now, and
      // saying "sending to N devices" about a template would be wrong even
      // when it is also an experiment.
      if (recurring) {
        return `${experimentMode ? 'An experiment repeating' : 'Repeating'} ${recurrenceSummary}`
          + `, reaching about ${reach} device${reach === 1 ? '' : 's'} each time.`;
      }
      if (experimentMode) {
        return `${isScheduling ? 'Scheduling' : 'Starting'} an experiment across `
          + `${variants.length} variants (${controlPercentage}% control), reaching ${reach} `
          + `device${reach === 1 ? '' : 's'}.`;
      }
      return `${isScheduling ? 'Scheduling' : 'Sending'} to ${reach} device${reach === 1 ? '' : 's'}.`;
    }
    return '';
  })();

  /**
   * The first thing stopping each step, or null.
   *
   * Built from the same checks `canSend` uses rather than a parallel set, so a
   * step can never read as finished while the send button disagrees with it.
   */
  const audienceProblem =
    audience === 'segment' && !segmentId
      ? 'Choose a segment.'
      : devicesError
        ? devicesError
        : audiencePreview.isError
          ? "Couldn't calculate reach."
          : reach === 0
            ? 'No reachable devices.'
            : null;

  const messageProblem = missingTitle
    ? experimentMode
      ? 'Name this experiment.'
      : 'A title is required.'
    : experimentMode && experimentError
      ? experimentError
      : actionsError ?? carouselError ?? timerError;

  const stepProblems: Record<ComposerStep, string | null> = {
    audience: audienceProblem,
    message: messageProblem,
    delivery: recurrenceError,
    // Review has no fields of its own; what blocks it is whatever is still
    // wrong behind it, which the steps above already report.
    review: null,
  };

  /**
   * Seconds the preview should count down from.
   *
   * A fixed countdown is measured from now, a relative one is its own
   * duration — which is what each recipient will actually see, since a
   * duration is resolved against the moment its send goes out.
   */
  const previewCountdownSeconds = (() => {
    if (timerKind === 'duration') return timerDurationSeconds;
    if (!timerEndsAt) return null;
    const remaining = Math.round((timerEndsAt.getTime() - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
  })();

  // Experiments have no single message to draw, so the preview shows the
  // first arm rather than campaign-level copy that is never sent.
  const previewArm = experimentMode ? variants[0] : undefined;

  const previewContent = {
    title: previewArm?.title || title,
    body: previewArm?.body || body,
    imageUrl: previewArm?.imageUrl || imageUrl,
    silent,
    actions,
    iosCategory,
    carousel,
    countdownSeconds: previewCountdownSeconds,
  };

  // Platform truths about what is currently composed — including the one
  // that is otherwise invisible, a carousel or countdown with no iOS
  // category. See `pushContentCaveats`.
  const activeCaveats = pushContentCaveats({
    silent,
    imageUrl,
    carouselSlides: carousel.length,
    hasTimer,
    actions: actions.length,
    iosCategory,
  });

  const stepIndex = COMPOSER_STEPS.findIndex((s) => s.key === step);
  const goToStep = (next: ComposerStep) => {
    const index = COMPOSER_STEPS.findIndex((s) => s.key === next);
    setStep(next);
    setFurthestStep((seen) => Math.max(seen, index));
    // A step change is a page change in everything but the URL; landing
    // half-way down the previous step's scroll position is disorienting.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Never sent for an experiment: each arm carries its own languages instead,
  // because a campaign-wide translation would replace the arm's copy — the
  // one thing being compared.
  const buildTranslations = (): PushTranslations | undefined => (
    experimentMode ? undefined : buildTranslationPayload(translations)
  );

  // An empty list would read as "this campaign has no buttons" where the API
  // expects the field simply not to be there.
  const buildActions = (): PushAction[] | undefined => {
    if (actions.length === 0) return undefined;
    return actions.map((a) => ({
      id: a.id.trim(),
      title: a.title.trim(),
      deepLinkUrl: a.deepLinkUrl.trim() || undefined,
    }));
  };

  // No slides is no carousel: the key is left off entirely rather than sent
  // as an empty list, which the API would reject as a carousel of nothing.
  const buildCarousel = (): PushCarouselSlide[] | undefined => {
    if (carousel.length === 0) return undefined;
    return carousel.map((slide) => ({
      imageUrl: slide.imageUrl.trim(),
      caption: slide.caption.trim() || undefined,
      deepLinkUrl: slide.deepLinkUrl.trim() || undefined,
    }));
  };

  // Likewise: the end is the countdown, so without one there is nothing to
  // send — expired copy on its own would count down to nothing. Exactly one of
  // `endsAt` / `durationSeconds` goes out; the API rejects both and neither.
  const buildTimer = (): PushTimer | undefined => {
    const end = timerKind === 'duration'
      ? timerDurationSeconds !== null ? { durationSeconds: timerDurationSeconds } : undefined
      : timerEndsAt ? { endsAt: timerEndsAt.toISOString() } : undefined;
    if (!end) return undefined;
    return {
      ...end,
      expiredTitle: timerExpiredTitle.trim() || undefined,
      expiredBody: timerExpiredBody.trim() || undefined,
    };
  };

  const handleSubmit = async () => {
    try {
      const variantsPayload: PushVariant[] | undefined = experimentMode
        ? variants.map((v) => ({
            key: v.key.trim(),
            title: v.title.trim(),
            body: v.body.trim() || undefined,
            imageUrl: v.imageUrl.trim() || undefined,
            deepLinkUrl: v.deepLinkUrl.trim() || undefined,
            weight: v.weight,
            translations: buildTranslationPayload(v.translations),
          }))
        : undefined;

      // Built whole or not at all: a half-filled rule would be rejected by
      // the API, and `endsAt` is omitted rather than sent as null because
      // "no end date" already means the series runs until it is cancelled.
      const recurrencePayload: PushRecurrence | undefined = recurring
        ? {
            frequency: recurrenceFrequency,
            interval: Number(recurrenceInterval),
            atTime: recurrenceAtTime,
            // Weekday selection is weekly-only — the API rejects `daysOfWeek`
            // outright on a daily or monthly rule.
            ...(recurrenceFrequency === 'weekly' && recurrenceDays.length > 0
              ? { daysOfWeek: [...recurrenceDays].sort((a, b) => a - b) }
              : {}),
            timezone: recurrenceTimezone,
            ...(recurrenceEndsAt ? { endsAt: recurrenceEndsAt.toISOString() } : {}),
          }
        : undefined;

      const result = await sendPush.mutateAsync({
        title: title.trim() || '(silent)',
        body: body.trim() || undefined,
        imageUrl: imageUrl.trim() || undefined,
        deepLinkUrl: deepLinkUrl.trim() || undefined,
        data: Object.keys(customData).length > 0 ? customData : undefined,
        silent: silent || undefined,
        deliveryOptions: buildDeliveryOptions(),
        segmentId: audience === 'segment' ? segmentId : undefined,
        deviceIdentityIds: audience === 'devices' ? selectedDeviceIds : undefined,
        scheduledAt: scheduledSendAt?.toISOString(),
        deliverInRecipientTimezone: localDelivery || undefined,
        // Dropped when optimisation is on: the API ignores it there, and
        // sending an hour that will not be used is how a UI ends up
        // disagreeing with what actually happened.
        localSendTime: localDelivery && !sendTimeOptimised ? localSendTime : undefined,
        sendTimeOptimised: sendTimeOptimised || undefined,
        recurrence: recurrencePayload,
        variants: variantsPayload,
        controlPercentage: experimentMode ? controlPercentage : undefined,
        translations: buildTranslations(),
        actions: buildActions(),
        iosCategory: iosCategory.trim() || undefined,
        carousel: buildCarousel(),
        timer: buildTimer(),
        // Still sent when the copy has since been edited — the user did reach
        // for this template, which is what the usage count records. Cleared
        // selection, no id.
        templateId: templateId || undefined,
      });
      toast({
        title: recurring
          ? 'Repeating campaign scheduled'
          : experimentMode
            ? (isScheduling ? 'Experiment scheduled' : 'Experiment started')
            : (isScheduling ? 'Campaign scheduled' : 'Campaign queued'),
        description: recurring
          ? `Repeats ${recurrenceSummary}, reaching about ${result.totalTokens} device(s) each time.`
          : isScheduling
            ? `Will send to ${result.totalTokens} device(s) at ${sendAt!.toLocaleString()}.`
            : experimentMode
              ? `Splitting ${result.totalTokens} device(s) across ${variants.length} variant(s) and control.`
              : `Sending to ${result.totalTokens} device(s).`,
      });
      navigate(backToList);
    } catch (err: any) {
      toast({
        title: 'Could not create campaign',
        description: err?.response?.data?.message ?? 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(backToList)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold">New push campaign</h1>
          <p className="text-muted-foreground mt-1">
            {/* Spelled out because the stepper hides its labels on small
                screens, where bare numbered circles say nothing. */}
            Step {stepIndex + 1} of {COMPOSER_STEPS.length} ·{' '}
            {COMPOSER_STEPS[stepIndex].hint}
          </p>
        </div>
      </div>

      {!isConfigured && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm">
            FCM is not configured for this project, so nothing can be sent yet.
            Set it up under Settings on the push notifications page.
          </CardContent>
        </Card>
      )}

      <Stepper
        current={step}
        furthest={furthestStep}
        problems={stepProblems}
        onSelect={goToStep}
      />

      {/* Each stage is a plain conditional: all the state lives in this
          component, so hiding a stage cannot lose what was typed into it. */}
      {step === 'audience' && (
        <div className="space-y-6">
      {/* ── 1. Audience ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Audience
          </CardTitle>
          <CardDescription>Who receives this campaign.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Send to</Label>
              <Select
                value={audience}
                onValueChange={(v) => setAudience(v as typeof audience)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">Everyone in this project</SelectItem>
                  <SelectItem
                    value="segment"
                    disabled={!segmentsLoading && !segmentsError && segments.length === 0}
                  >
                    {segmentsLoading
                      ? 'A segment (loading…)'
                      : segmentsError
                        ? 'A segment (couldn’t load)'
                        : segments.length === 0
                          ? 'A segment (none defined)'
                          : 'A segment'}
                  </SelectItem>
                  <SelectItem value="devices">Specific devices</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {audience === 'segment' && (
              <div className="space-y-2">
                <Label>Segment</Label>
                <Select value={segmentId} onValueChange={setSegmentId} disabled={segmentsLoading}>
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

          {audience === 'devices' && (
            <div className="space-y-4 rounded-lg border p-4">
              <div>
                <Label className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4" /> Devices
                </Label>
                {/* A row is one device identity, not a person: someone using
                    three phones appears three times, so selecting a row
                    reaches that one device and not the other two. */}
                <p className="mt-1 text-xs text-muted-foreground">
                  Each row is a single device identity. Someone using more
                  than one device appears once per device, so pick every row
                  you mean to reach — a row&rsquo;s device count is how many
                  that person has, not how many this selection covers.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Search</Label>
                  <Input
                    value={deviceSearch}
                    onChange={(e) => setDeviceSearch(e.target.value)}
                    placeholder="Name, email or distinct id"
                  />
                </div>
                <div className="flex items-start justify-between rounded-lg border p-3">
                  <div className="space-y-0.5 pr-4">
                    <Label>Show unreachable</Label>
                    <p className="text-xs text-muted-foreground">
                      Identities holding no active push token. Selecting one
                      adds nothing to the send, so they are left out unless
                      you ask for them.
                    </p>
                  </div>
                  <Switch checked={showUnreachable} onCheckedChange={setShowUnreachable} />
                </div>
              </div>

              {/* Kept beside the results rather than inside them: the search
                  and the page below both move, and a selection you can no
                  longer see is a selection you cannot take back. */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>
                    Selected ({selectedDevices.length})
                  </Label>
                  {selectedDevices.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedDevices([])}
                    >
                      Clear all
                    </Button>
                  )}
                </div>
                {selectedDevices.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nothing selected yet. Add devices from the results below —
                    what you pick here stays selected while you keep searching.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {selectedDevices.map((user) => (
                      <Badge key={user.id} variant="secondary" className="gap-1 font-normal">
                        {user.displayName}
                        {!user.pushEnabled && (
                          <span className="text-destructive">no push token</span>
                        )}
                        <button
                          type="button"
                          aria-label={`Remove ${user.displayName}`}
                          onClick={() => removeDevice(user.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Results</Label>
                {devicesLoading ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Searching devices…
                  </p>
                ) : devicesLoadError ? (
                  <p className="text-sm text-destructive">
                    Couldn&rsquo;t load this project&rsquo;s devices. Reload the
                    page to try again.
                  </p>
                ) : deviceRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {deviceSearchTerm
                      ? `Nothing matches “${deviceSearchTerm}”.`
                      : showUnreachable
                        ? 'This project has no device identities yet.'
                        : 'No identity here holds an active push token. Turn on “Show unreachable” to see the rest.'}
                  </p>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {deviceRows.map((user) => {
                      const isSelected = selectedDeviceIds.includes(user.id);
                      return (
                        <div
                          key={user.id}
                          className="flex items-center justify-between gap-3 p-3"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="truncate text-sm font-medium">
                              {user.displayName}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {user.email ?? user.distinctId}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {user.platform && (
                              <Badge variant="outline" className="font-normal">
                                {user.platform}
                              </Badge>
                            )}
                            {user.deviceCount > 1 && (
                              <span className="text-xs text-muted-foreground">
                                1 of {user.deviceCount} devices
                              </span>
                            )}
                            <span
                              className={
                                user.pushEnabled
                                  ? 'text-xs text-muted-foreground'
                                  : 'text-xs text-destructive'
                              }
                            >
                              {user.pushEnabled ? 'Reachable' : 'No push token'}
                            </span>
                            <Button
                              type="button"
                              variant={isSelected ? 'secondary' : 'outline'}
                              size="sm"
                              onClick={() => toggleDevice(user)}
                            >
                              {isSelected ? (
                                <>
                                  <X className="mr-2 h-4 w-4" /> Remove
                                </>
                              ) : (
                                <>
                                  <Plus className="mr-2 h-4 w-4" /> Add
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {deviceMeta && deviceMeta.totalPages > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Page {deviceMeta.page} of {deviceMeta.totalPages} —{' '}
                    {deviceMeta.total} device{deviceMeta.total === 1 ? '' : 's'} match
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={devicePage <= 1}
                      onClick={() => setDevicePage((p) => p - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={devicePage >= deviceMeta.totalPages}
                      onClick={() => setDevicePage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}

              {devicesError && <p className="text-xs text-destructive">{devicesError}</p>}
            </div>
          )}

          <div className="rounded-lg border bg-muted/30 p-4">
            {audience === 'segment' && !segmentId ? (
              <p className="text-sm text-muted-foreground">
                Pick a segment to see its reach.
              </p>
            ) : audience === 'devices' && selectedDevices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Select at least one device to see its reach.
              </p>
            ) : audiencePreview.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Counting devices…
              </p>
            ) : audiencePreview.isError ? (
              <p className="text-sm text-destructive">
                Couldn&rsquo;t calculate reach for this audience. Try changing the
                audience or reloading the page.
              </p>
            ) : audiencePreview.data ? (
              <div>
                <p className="text-3xl font-semibold">
                  {audiencePreview.data.totalTokens}
                </p>
                <p className="text-sm text-muted-foreground">
                  device{audiencePreview.data.totalTokens === 1 ? '' : 's'} will be reached
                  {audiencePreview.data.deviceCount !== null &&
                    audiencePreview.data.deviceCount !==
                      audiencePreview.data.totalTokens &&
                    ` — ${audience === 'devices' ? 'the selection covers' : 'the segment matches'} ${audiencePreview.data.deviceCount}, the rest have no push token`}
                  .
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Reach unavailable.</p>
            )}
          </div>
        </CardContent>
      </Card>

        </div>
      )}

      {step === 'message' && (
        <div className="space-y-6">
          {/* Where a campaign starts. Above the fields rather than beside
              them: choosing a template rewrites those fields, so it is a
              decision that comes first, not one offered halfway down. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LayoutTemplate className="h-5 w-5" /> Template
              </CardTitle>
              <CardDescription>
                Pick a shape to begin from, then edit everything below. A
                preset is a starting point, not a constraint.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PushTemplateGallery
                templates={templates}
                selectedPresetId={presetId}
                selectedTemplateId={templateId}
                onSelectPreset={handlePresetSelect}
                onSelectTemplate={handleTemplateSelect}
                onStartBlank={startBlank}
              />
              {activeCaveats.length > 0 && (
                <ul className="mt-4 space-y-1.5 border-t pt-3">
                  {activeCaveats.map((caveat) => (
                    <li
                      key={caveat}
                      className="flex gap-2 text-xs text-muted-foreground"
                    >
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {caveat}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-6">
      {/* ── 2. Message ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" /> Message
          </CardTitle>
          <CardDescription>
            {experimentMode
              ? 'Shared defaults, plus what each variant says.'
              : 'What the user sees.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The template picker used to live here as a dropdown of saved
              templates. It is a gallery above this card now: choosing one
              rewrites every field below, which makes it a decision that comes
              first rather than one offered halfway down the form. */}
          {templatesError && (
            <p className="text-sm text-destructive">
              Couldn&rsquo;t load saved templates. Reload the page to try
              again — the built-in presets above still work.
            </p>
          )}
          {templateId !== '' && (
            <p className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
              <span>
                These fields hold a copy you can edit freely — this campaign
                sends what is on screen, and later edits to the template
                can&rsquo;t change it.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 text-xs"
                onClick={clearTemplate}
              >
                Detach
              </Button>
            </p>
          )}

          {Object.keys(customData).length > 0 && (
            <div className="space-y-2">
              <Label>Custom data</Label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(customData).map(([key, value]) => (
                  <Badge key={key} variant="secondary" className="gap-1 font-normal">
                    {key}: {value}
                    <button
                      type="button"
                      aria-label={`Remove ${key}`}
                      onClick={() => removeDataKey(key)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Key/value pairs copied from the template and delivered with the
                message, alongside the deep link. Remove one to drop it from
                this campaign.
              </p>
            </div>
          )}

          <div className="flex items-start justify-between rounded-lg border p-4">
            <div className="space-y-0.5 pr-4">
              <Label className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4" /> A/B experiment
              </Label>
              <p className="text-xs text-muted-foreground">
                Split this campaign into 2–5 variants with different copy,
                each sent to a slice of the audience, plus an optional control
                group that receives nothing — so you can tell whether any arm
                actually moved the needle.
              </p>
            </div>
            <Switch checked={experimentMode} onCheckedChange={handleExperimentToggle} />
          </div>

          {experimentMode ? (
            <div className="space-y-2">
              <Label>Campaign name *</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Weekend sale headline test"
                maxLength={255}
              />
              <p className="text-xs text-muted-foreground">
                Identifies this experiment in your campaign list — recipients
                never see it. Each variant below has its own title.
              </p>
            </div>
          ) : (
            <div className="flex items-start justify-between rounded-lg border p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Silent push</Label>
                <p className="text-xs text-muted-foreground">
                  Wakes the app with data but shows nothing. There is no visible
                  notification at all, so title, body and image are not sent.
                </p>
              </div>
              <Switch checked={silent} onCheckedChange={setSilent} />
            </div>
          )}

          {experimentMode && (
            <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              Silent push isn&rsquo;t available for experiments — a silent
              push shows nothing, so there is no visible copy for the variants
              to compare. Turn off the experiment to send a silent campaign
              instead.
            </p>
          )}

          {experimentMode ? (
            <>
              <div className="space-y-2">
                <Label>Default body</Label>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Used by any variant that leaves its own body blank"
                  rows={2}
                  className="max-h-48 resize-y"
                />
              </div>
              <div className="space-y-2">
                <Label>Default image URL</Label>
                <Input
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="Used by any variant that leaves its own image blank"
                />
                {imageUrl.trim() !== '' && (
                  <p className="text-xs text-muted-foreground">
                    Images show on Firebase Cloud Messaging. On APNs direct they
                    need a notification service extension in your app, and Mi
                    Push cannot show one at all — those devices get the same
                    notification without the picture, never no notification.
                  </p>
                )}
              </div>
            </>
          ) : (
            !silent && (
              <>
                <div className="space-y-2">
                  <Label>Title *</Label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Your order has shipped"
                    maxLength={255}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Body</Label>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Supporting line shown under the title"
                    rows={3}
                    className="max-h-48 resize-y"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Image URL</Label>
                  <Input
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://example.com/banner.png"
                  />
                  {imageUrl.trim() !== '' && (
                    <p className="text-xs text-muted-foreground">
                      Images show on Firebase Cloud Messaging. On APNs direct they
                      need a notification service extension in your app, and Mi
                      Push cannot show one at all — those devices get the same
                      notification without the picture, never no notification.
                    </p>
                  )}
                </div>
              </>
            )
          )}

          {!silent && (
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Personalisation</p>
              <p className="mt-1">
                {experimentMode
                  ? 'Each variant’s title, body and deep link, and the defaults above,'
                  : 'Title, body and deep link'}{' '}
                accept <code>{'{{firstName}}'}</code>-style tokens, resolved per
                recipient at send time. Give a fallback with{' '}
                <code>{'{{firstName|there}}'}</code> — without one an unknown
                value renders as nothing rather than as raw{' '}
                <code>{'{{ }}'}</code>.
              </p>
              <p className="mt-1">
                Available: <code>firstName</code>, <code>lastName</code>,{' '}
                <code>phone</code>, <code>city</code>, <code>country</code>,{' '}
                <code>countryCode</code>, <code>region</code>,{' '}
                <code>locale</code>, <code>language</code>,{' '}
                <code>externalUserId</code>, <code>distinctId</code>, and any
                custom trait as <code>{'{{trait.yourKey}}'}</code>.
              </p>
              <p className="mt-1">
                The same tokens work inside translated copy, too.
              </p>
            </div>
          )}

          {experimentMode ? (
            <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              Translations live on each variant below, not on the campaign: a
              shared translation would replace whatever copy that arm is
              testing, which is the one thing an experiment must not do. An arm
              with no entry for a language still sends that arm&rsquo;s own
              title and body — nobody is skipped for lacking a translation.
            </p>
          ) : (
            !silent && (
              <div className="space-y-3">
                <div>
                  <Label className="flex items-center gap-2">
                    <Languages className="h-4 w-4" /> Translations
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Copy for a specific language, matched against the
                    recipient&rsquo;s device language (falling back to their
                    locale). A language with no entry here still gets this
                    campaign — it receives the title and body above, not
                    nothing.
                  </p>
                </div>

                <TranslationsEditor
                  rows={translations}
                  newLang={newLang}
                  newLangError={newLangError}
                  titlePlaceholder="Leave blank to use the title above"
                  bodyPlaceholder="Leave blank to use the body above"
                  onNewLangChange={(value) => {
                    setNewLang(value);
                    setNewLangError(null);
                  }}
                  onAdd={addTranslation}
                  onRemove={removeTranslation}
                  onChange={updateTranslation}
                />
              </div>
            )
          )}

          <Separator />

          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Link2 className="h-4 w-4" /> {experimentMode ? 'Default deep link' : 'Deep link'}
            </Label>
            <Input
              value={deepLinkUrl}
              onChange={(e) => setDeepLinkUrl(e.target.value)}
              placeholder={
                experimentMode
                  ? 'Used by any variant that leaves its own deep link blank'
                  : 'myapp://offers/42 or https://…'
              }
            />
            <p className="text-xs text-muted-foreground">
              {experimentMode
                ? 'Fallback for variants that don’t set their own deep link.'
                : (
                  <>
                    Where a tap lands. Sent as the <code>deep_link_url</code>{' '}
                    data key, which the Android SDK already routes taps from.
                  </>
                )}
            </p>
          </div>

          {experimentMode && (
            <>
              <Separator />

              <div className="space-y-2 rounded-lg border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5 pr-4">
                    <Label>Control group</Label>
                    <p className="text-xs text-muted-foreground">
                      Held back and sent nothing at all — not even the
                      fallback copy above — so the campaign&rsquo;s effect can
                      be measured against people who received no push.
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      max={50}
                      className="w-20"
                      value={controlPercentage}
                      onChange={(e) => setControlPercentage(clampPercent(e.target.value, 50))}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {reach === undefined
                    ? 'Reach is still loading.'
                    : `~${controlRecipients} of ${reach} ${reach === 1 ? 'person' : 'people'} will receive nothing.`}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Variants</Label>
                <div className="flex items-center gap-3">
                  <span
                    className={
                      weightValid
                        ? 'text-sm text-muted-foreground'
                        : 'text-sm font-medium text-destructive'
                    }
                  >
                    Total weight: {weightTotal}%{weightValid ? '' : ' — must total 100%'}
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={evenSplitAll}>
                    Even split
                  </Button>
                </div>
              </div>

              <div className="space-y-4">
                {variants.map((variant, index) => (
                  <div key={index} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="secondary">Variant {variant.key || '?'}</Badge>
                      <div className="flex items-center gap-3">
                        {treatedRecipients !== undefined && (
                          <span className="text-xs text-muted-foreground">
                            ~{variantRecipients[index]}{' '}
                            {variantRecipients[index] === 1 ? 'person' : 'people'}
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeVariant(index)}
                          disabled={variants.length <= 2}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-[6rem_1fr_7rem]">
                      <div className="space-y-2">
                        <Label>Key</Label>
                        <Input
                          value={variant.key}
                          maxLength={16}
                          onChange={(e) => updateVariant(index, { key: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Title *</Label>
                        <Input
                          value={variant.title}
                          maxLength={255}
                          onChange={(e) => updateVariant(index, { title: e.target.value })}
                          placeholder="e.g. Free shipping today only"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Weight</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={variant.weight}
                            onChange={(e) => updateVariant(index, {
                              weight: clampPercent(e.target.value, 100),
                            })}
                          />
                          <span className="text-sm text-muted-foreground">%</span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Body</Label>
                      <Textarea
                        value={variant.body}
                        onChange={(e) => updateVariant(index, { body: e.target.value })}
                        placeholder="Leave blank to use the default body above"
                        rows={2}
                        className="max-h-32 resize-y"
                      />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Image URL</Label>
                        <Input
                          value={variant.imageUrl}
                          onChange={(e) => updateVariant(index, { imageUrl: e.target.value })}
                          placeholder="Leave blank to use the default image above"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Deep link</Label>
                        <Input
                          value={variant.deepLinkUrl}
                          onChange={(e) => updateVariant(index, { deepLinkUrl: e.target.value })}
                          placeholder="Leave blank to use the default deep link above"
                        />
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <div>
                        <Label className="flex items-center gap-2">
                          <Languages className="h-4 w-4" /> Translations for
                          variant {variant.key || '?'}
                        </Label>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Translate this arm&rsquo;s own copy, so the thing the
                          experiment is comparing survives translation. A
                          recipient whose language isn&rsquo;t listed here
                          still gets this variant&rsquo;s title and body above.
                        </p>
                      </div>

                      <TranslationsEditor
                        rows={variant.translations}
                        newLang={variant.newLang}
                        newLangError={variant.newLangError}
                        titlePlaceholder="Leave blank to use this variant's title"
                        bodyPlaceholder="Leave blank to use this variant's body"
                        onNewLangChange={(value) => updateVariant(index, {
                          newLang: value,
                          newLangError: null,
                        })}
                        onAdd={() => addVariantTranslation(index)}
                        onRemove={(langIndex) => removeVariantTranslation(index, langIndex)}
                        onChange={(langIndex, patch) => (
                          updateVariantTranslation(index, langIndex, patch)
                        )}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addVariant}
                disabled={variants.length >= 5}
              >
                <Plus className="mr-2 h-4 w-4" /> Add variant
              </Button>

              {experimentError && (
                <p className="text-xs text-destructive">{experimentError}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Action buttons ───────────────────────────────────── */}
      <Card>
        <Collapsible open={actionsOpen} onOpenChange={setActionsOpen}>
          <CardHeader>
            <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <MousePointerClick className="h-5 w-5" /> Action buttons
                </CardTitle>
                <CardDescription>
                  Optional buttons under the notification. Leave this alone for
                  a message that just opens the app when tapped.
                </CardDescription>
              </div>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                {actionsOpen
                  ? 'Hide'
                  : actions.length > 0
                    ? `${actions.length} button${actions.length === 1 ? '' : 's'}`
                    : 'Show'}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${actionsOpen ? 'rotate-180' : ''}`}
                />
              </span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              {/* The platforms genuinely diverge here, and someone who assumes
                  otherwise ships buttons half their audience never sees — so
                  it is stated before the fields, not under them. */}
              <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Android</span>{' '}
                  builds these buttons from the message itself, so exactly what
                  you type below is what it shows.
                </p>
                <p className="mt-1">
                  <span className="font-medium text-foreground">iOS</span> can
                  only show buttons the app registered at launch. The payload
                  just names the category below and the app owns the titles —
                  nothing typed here appears on iOS.
                </p>
                <p className="mt-1">
                  Each id is reported back with the click event, so a button
                  tap can be told apart from a tap on the notification itself.
                </p>
              </div>

              {actions.map((action, index) => (
                <div key={index} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="secondary">Button {index + 1}</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeAction(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Id *</Label>
                      <Input
                        value={action.id}
                        maxLength={64}
                        onChange={(e) => updateAction(index, { id: e.target.value })}
                        placeholder="e.g. track_order"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Title *</Label>
                      <Input
                        value={action.title}
                        maxLength={64}
                        onChange={(e) => updateAction(index, { title: e.target.value })}
                        placeholder="e.g. Track package"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Deep link</Label>
                    <Input
                      value={action.deepLinkUrl}
                      onChange={(e) => updateAction(index, { deepLinkUrl: e.target.value })}
                      placeholder="Leave blank to use the campaign's deep link above"
                    />
                  </div>
                </div>
              ))}

              <Button type="button" variant="outline" size="sm" onClick={addAction}>
                <Plus className="mr-2 h-4 w-4" /> Add button
              </Button>

              {actionsError && <p className="text-xs text-destructive">{actionsError}</p>}

              {silent && actions.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  This is a silent push, so nothing is shown and these buttons
                  never appear.
                </p>
              )}

              <Separator />

              <div className="space-y-2">
                <Label>iOS category</Label>
                <Input
                  value={iosCategory}
                  maxLength={64}
                  onChange={(e) => setIosCategory(e.target.value)}
                  placeholder="e.g. ORDER_UPDATE"
                />
                <p className="text-xs text-muted-foreground">
                  Must match a notification category the iOS app registers at
                  launch — the app owns those buttons. A name it never
                  registered simply shows none; leave this blank if the app
                  registers no categories.
                </p>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* ── 4. Rich content ─────────────────────────────────────── */}
      <Card>
        <Collapsible open={richContentOpen} onOpenChange={setRichContentOpen}>
          <CardHeader>
            <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Images className="h-5 w-5" /> Carousel &amp; countdown
                </CardTitle>
                <CardDescription>
                  Optional images to page through and a countdown to a
                  deadline. Leave this alone for an ordinary notification.
                </CardDescription>
              </div>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                {richContentOpen
                  ? 'Hide'
                  : carousel.length > 0
                    ? `${carousel.length} slide${carousel.length === 1 ? '' : 's'}`
                      + (hasTimer ? ', countdown' : '')
                    : hasTimer
                      ? 'Countdown'
                      : 'Show'}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${richContentOpen ? 'rotate-180' : ''}`}
                />
              </span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-6">
              {/* Whether these appear is a property of the recipient's app
                  build, not of this server, so it is said before the fields
                  rather than under them — nobody should plan a campaign
                  around a guarantee that isn't one. */}
              <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p>
                  No push provider carries a carousel or a countdown, so both
                  travel as data and your app draws them. A recipient whose app
                  build doesn&rsquo;t support them gets the ordinary
                  notification above instead — never nothing.
                </p>
                <p className="mt-1">
                  Support therefore depends on the app version installed and on
                  the platform, not on this project&rsquo;s push setup.
                </p>
              </div>

              {experimentMode && (
                <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Every variant carries this same carousel and countdown. Like
                  the action buttons, they are campaign-level furniture rather
                  than part of what an arm is testing — vary an arm&rsquo;s
                  title, body, image or deep link instead.
                </p>
              )}

              <div className="space-y-4">
                <div>
                  <Label className="flex items-center gap-2">
                    <Images className="h-4 w-4" /> Carousel
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Between {MIN_CAROUSEL_SLIDES} and {MAX_CAROUSEL_SLIDES}{' '}
                    images the recipient pages through, in the order below. A
                    slide without its own deep link lands wherever the
                    notification itself does.
                  </p>
                </div>

                {carousel.map((slide, index) => (
                  <div key={index} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="secondary">Slide {index + 1}</Badge>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Move slide ${index + 1} earlier`}
                          disabled={index === 0}
                          onClick={() => moveSlide(index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Move slide ${index + 1} later`}
                          disabled={index === carousel.length - 1}
                          onClick={() => moveSlide(index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove slide ${index + 1}`}
                          onClick={() => removeSlide(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Image URL *</Label>
                      <Input
                        value={slide.imageUrl}
                        onChange={(e) => updateSlide(index, { imageUrl: e.target.value })}
                        placeholder="https://example.com/slide.png"
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Caption</Label>
                        <Input
                          value={slide.caption}
                          maxLength={255}
                          onChange={(e) => updateSlide(index, { caption: e.target.value })}
                          placeholder="Shown under this image"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Deep link</Label>
                        <Input
                          value={slide.deepLinkUrl}
                          onChange={(e) => updateSlide(index, { deepLinkUrl: e.target.value })}
                          placeholder="Leave blank to use the campaign's deep link"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addSlide}
                  disabled={carousel.length >= MAX_CAROUSEL_SLIDES}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {carousel.length === 0 ? 'Add a carousel' : 'Add slide'}
                </Button>

                {carouselError && <p className="text-xs text-destructive">{carouselError}</p>}

                {carouselHasNoStillFallback && (
                  <p className="text-xs text-muted-foreground">
                    No image is set in the message above, so an app build that
                    doesn&rsquo;t draw carousels shows this campaign with no
                    picture at all. Setting one gives those recipients
                    something to see.
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-4">
                <div>
                  <Label className="flex items-center gap-2">
                    <Timer className="h-4 w-4" /> Countdown
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Counts down in the notification to a deadline — an offer
                    closing, a match starting. Android has a native chronometer
                    for it; on iOS it needs a notification content extension in
                    the app.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Countdown type</Label>
                  <Select
                    value={timerKind}
                    onValueChange={(v) => setTimerKind(v as TimerKind)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed end time — a deadline everyone shares</SelectItem>
                      <SelectItem value="duration">Duration — ends a set time after each send</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {timerKind === 'fixed'
                      ? 'For a real deadline — a launch, an event, a sale that ends when it ends.'
                      : 'For anything that sends more than once. Every send, and every timezone wave, gets its own deadline.'}
                  </p>
                </div>

                {timerKind === 'fixed' ? (
                  <div className="space-y-2">
                    <Label>Ends at</Label>
                    <DateTimePicker
                      value={timerEndsAt}
                      onChange={setTimerEndsAt}
                      placeholder="No countdown"
                    />
                    <p className="text-xs text-muted-foreground">
                      {!timerEndsAt
                        ? 'Leave this empty to send without a countdown.'
                        : scheduledSendAt
                          ? `Checked against ${scheduledSendAt.toLocaleString()}, when this campaign goes out — not against now, or a countdown could be over before anyone receives it.`
                          : 'This campaign goes out as soon as you submit, so the countdown is checked against now.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>Ends after each send</Label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={timerDurationAmount}
                        onChange={(e) => setTimerDurationAmount(e.target.value)}
                        placeholder="No countdown"
                        className="sm:max-w-[10rem]"
                      />
                      <Select
                        value={timerDurationUnit}
                        onValueChange={(v) => setTimerDurationUnit(v as TimerDurationUnit)}
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hours">Hours</SelectItem>
                          <SelectItem value="days">Days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {timerDurationAmount.trim()
                        ? 'Counted from the moment each send goes out, so it is never checked against the schedule.'
                        : 'Leave this empty to send without a countdown.'}
                    </p>
                  </div>
                )}

                {hasTimer && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Title once it has ended</Label>
                        <Input
                          value={timerExpiredTitle}
                          maxLength={255}
                          onChange={(e) => setTimerExpiredTitle(e.target.value)}
                          placeholder="Leave blank to keep the title above"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Body once it has ended</Label>
                        <Textarea
                          value={timerExpiredBody}
                          onChange={(e) => setTimerExpiredBody(e.target.value)}
                          placeholder="Leave blank to keep the body above"
                          rows={2}
                          className="max-h-32 resize-y"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Shown by the app when the countdown reaches zero on a
                      notification still sitting in the tray. Left blank, it
                      keeps the campaign&rsquo;s own copy.
                    </p>
                  </>
                )}

                {timerError && <p className="text-xs text-destructive">{timerError}</p>}

                {/* Only a fixed end goes stale: a duration is resolved from each
                    send, so these describe a problem it does not have — and
                    for a fixed end they name the duration option as the fix. */}
                {timerKind === 'fixed' && timerEndsAt && localDelivery && (
                  <p className="text-xs text-muted-foreground">
                    Recipients are reached at their own local time, so the last
                    timezone can be the best part of a day behind the first. A
                    fixed end sooner than that arrives already expired for some
                    of them. Switch to a duration to give every wave its own
                    deadline.
                  </p>
                )}

                {timerKind === 'fixed' && timerEndsAt && recurring && (
                  <p className="text-xs text-muted-foreground">
                    A fixed end is one instant shared by every occurrence, so
                    each one after {timerEndsAt.toLocaleString()} arrives
                    expired and shows the copy above. Switch to a duration to
                    give every occurrence a fresh countdown.
                  </p>
                )}
              </div>

              {silent && (carousel.length > 0 || hasTimer) && (
                <p className="text-xs text-muted-foreground">
                  This is a silent push, so nothing is shown and neither the
                  carousel nor the countdown ever appears.
                </p>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

            </div>

            {/* Sticky, because the point of a preview is to watch it change
                while the fields above it are edited. */}
            <aside className="h-fit lg:sticky lg:top-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Smartphone className="h-4 w-4" /> Preview
                  </CardTitle>
                  <CardDescription>
                    How this will be drawn. Personalisation tokens are shown
                    as written — each recipient sees their own value.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PushPreview
                    content={previewContent}
                    platform={previewPlatform}
                    onPlatformChange={setPreviewPlatform}
                  />
                </CardContent>
              </Card>
            </aside>
          </div>
        </div>
      )}

      {step === 'delivery' && (
        <div className="space-y-6">
      {/* ── 5. Delivery options ─────────────────────────────────── */}
      <Card>
        <Collapsible open={deliveryOptionsOpen} onOpenChange={setDeliveryOptionsOpen}>
          <CardHeader>
            <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5" /> Delivery options
                </CardTitle>
                <CardDescription>
                  Transport behaviour and per-platform settings. Sensible
                  defaults apply if you leave these alone.
                </CardDescription>
              </div>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                {deliveryOptionsOpen ? 'Hide' : 'Show'}
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${deliveryOptionsOpen ? 'rotate-180' : ''}`}
                />
              </span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Select
                    value={priority}
                    onValueChange={(v) => setPriority(v as typeof priority)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Provider default</SelectItem>
                      <SelectItem value="high">High — deliver promptly</SelectItem>
                      <SelectItem value="normal">Normal — may be batched</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Time to live (seconds)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={ttlSeconds}
                    onChange={(e) => setTtlSeconds(e.target.value)}
                    placeholder="e.g. 3600"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Collapse key</Label>
                  <Input
                    value={collapseKey}
                    onChange={(e) => setCollapseKey(e.target.value)}
                    placeholder="e.g. order-updates"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Time to live is how long the provider keeps retrying an offline
                device. A collapse key makes a newer message replace an older
                undelivered one instead of stacking.
              </p>

              <Separator />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Android notification channel</Label>
                  <Input
                    value={androidChannelId}
                    onChange={(e) => setAndroidChannelId(e.target.value)}
                    placeholder="e.g. promotions"
                  />
                  <p className="text-xs text-muted-foreground">
                    Android 8 and above drops a notification whose channel does
                    not exist in the app.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Android sound</Label>
                  <Input
                    value={androidSound}
                    onChange={(e) => setAndroidSound(e.target.value)}
                    placeholder="e.g. default"
                  />
                </div>
                <div className="space-y-2">
                  <Label>iOS sound</Label>
                  <Input
                    value={iosSound}
                    onChange={(e) => setIosSound(e.target.value)}
                    placeholder="e.g. default"
                  />
                </div>
                <div className="space-y-2">
                  <Label>iOS badge</Label>
                  <Input
                    type="number"
                    min={0}
                    value={iosBadge}
                    onChange={(e) => setIosBadge(e.target.value)}
                    placeholder="e.g. 1"
                  />
                </div>
                <div className="space-y-2">
                  <Label>iOS thread id</Label>
                  <Input
                    value={iosThreadId}
                    onChange={(e) => setIosThreadId(e.target.value)}
                    placeholder="Groups related notifications"
                  />
                </div>
              </div>
              {silent && (
                <p className="text-xs text-muted-foreground">
                  This is a silent push, so iOS sound, badge and thread id are
                  not sent — a background push cannot present anything.
                </p>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* ── 6. Schedule ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5" /> Schedule
          </CardTitle>
          <CardDescription>When this campaign goes out.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between rounded-lg border p-4">
            <div className="space-y-0.5 pr-4">
              <Label>Deliver in each recipient's local time</Label>
              <p className="text-xs text-muted-foreground">
                Sends at the same time on every recipient's own clock rather
                than one instant worldwide. The campaign is split into one send
                per timezone, each tracked separately.
              </p>
              {sendTimeOptimised && (
                <p className="text-xs text-muted-foreground">
                  Held on by send-time optimisation below — a personalised hour
                  only means something on the recipient&rsquo;s own clock.
                </p>
              )}
            </div>
            <Switch
              checked={localDelivery}
              disabled={sendTimeOptimised}
              onCheckedChange={setLocalTimeDelivery}
            />
          </div>

          <div className="flex items-start justify-between rounded-lg border p-4">
            <div className="space-y-0.5 pr-4">
              <Label>Optimise send time per recipient</Label>
              <p className="text-xs text-muted-foreground">
                Chooses each recipient&rsquo;s hour from the hours they have
                clicked notifications before, instead of one fixed local time
                for everyone.
              </p>
            </div>
            <Switch
              checked={sendTimeOptimised}
              onCheckedChange={handleSendTimeOptimisedToggle}
            />
          </div>

          {/* Exactly one control ever sets the send hour. Optimisation wins —
              the API ignores `localSendTime` when it is on — so the fixed time
              is taken off screen rather than left there claiming otherwise. */}
          {sendTimeOptimised ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p>
                A fixed local time is not used while this is on — each
                recipient gets their own hour instead.
              </p>
              <p className="mt-1">
                Someone with fewer than three past clicks has no established
                habit yet and is sent at 09:00 on their own clock. Optimisation
                refines{' '}
                <span className="font-medium text-foreground">when</span> a
                campaign goes out, never who receives it — nobody is dropped
                for lacking history.
              </p>
            </div>
          ) : localDelivery ? (
            <div className="space-y-2">
              <Label>Local time</Label>
              <Input
                type="time"
                className="max-w-[10rem]"
                value={localSendTime}
                onChange={(e) => setLocalSendTime(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Each recipient receives it at {localSendTime} on their own
                clock, at the next occurrence. Anyone already past that time
                today gets it tomorrow — nobody is messaged immediately just
                because their morning has passed.
              </p>
            </div>
          ) : null}

          <div className="flex items-start justify-between rounded-lg border p-4">
            <div className="space-y-0.5 pr-4">
              <Label className="flex items-center gap-2">
                <Repeat className="h-4 w-4" /> Repeat
              </Label>
              <p className="text-xs text-muted-foreground">
                Makes this a template that spawns one campaign per period and
                then advances itself. Each occurrence is an ordinary campaign
                with its own delivery and its own report; the template is never
                sent on its own.
              </p>
            </div>
            <Switch checked={recurring} onCheckedChange={setRecurring} />
          </div>

          {recurring && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Frequency</Label>
                  <Select
                    value={recurrenceFrequency}
                    onValueChange={(v) => setRecurrenceFrequency(v as RecurrenceFrequency)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Repeat every</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={52}
                      value={recurrenceInterval}
                      onChange={(e) => setRecurrenceInterval(e.target.value)}
                    />
                    <span className="text-sm text-muted-foreground">
                      {recurrenceUnit(recurrenceFrequency, Number(recurrenceInterval) !== 1)}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>At</Label>
                  <Input
                    type="time"
                    value={recurrenceAtTime}
                    onChange={(e) => setRecurrenceAtTime(e.target.value)}
                  />
                </div>
              </div>

              {/* Weekday selection is weekly-only: the API rejects
                  `daysOfWeek` outright on a daily or monthly rule, so it is
                  hidden rather than shown and quietly dropped. */}
              {recurrenceFrequency === 'weekly' && (
                <div className="space-y-2">
                  <Label>On these days</Label>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map((day) => (
                      <Button
                        key={day.value}
                        type="button"
                        size="sm"
                        variant={recurrenceDays.includes(day.value) ? 'default' : 'outline'}
                        onClick={() => toggleRecurrenceDay(day.value)}
                      >
                        {day.label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Optional. Choose none and it repeats on the same weekday as
                    the first occurrence.
                  </p>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Timezone</Label>
                  <Select value={recurrenceTimezone} onValueChange={setRecurrenceTimezone}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    The clock the time above is read on, so a 09:00 send stays
                    at 09:00 across a daylight-saving change.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Ends</Label>
                  <DateTimePicker
                    value={recurrenceEndsAt}
                    onChange={setRecurrenceEndsAt}
                    placeholder="Never — runs until cancelled"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave this empty and the series repeats until someone
                    cancels it. With a date set, the last occurrence is the
                    final one falling on or before it.
                  </p>
                </div>
              </div>

              {recurrenceError ? (
                <p className="text-xs text-destructive">{recurrenceError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Repeats {recurrenceSummary}.
                </p>
              )}
            </div>
          )}

          {/* One date control, never two competing ones: with Repeat on this
              seeds the series rather than booking a send of its own, so it is
              relabelled instead of a second schedule appearing beside it. */}
          {(!localDelivery || recurring) && (
            <div className="space-y-2">
              <Label>{recurring ? 'First occurrence' : 'Send at'}</Label>
              <DateTimePicker
                value={sendAt}
                onChange={setSendAt}
                placeholder={recurring ? 'The next slot the rule allows' : 'Immediately'}
              />
              <p className="text-xs text-muted-foreground">
                {recurring
                  ? isScheduling
                    ? `The repeat rule takes over from here — this is only when the first occurrence fires, not a separate send. The series starts at ${sendAt!.toLocaleString()}.`
                    : 'The repeat rule takes over from here — this is only when the first occurrence fires, not a separate send. Left empty, the first one is the next slot the rule allows.'
                  : isScheduling
                    ? `Held until ${sendAt!.toLocaleString()}. You can cancel it any time before then.`
                    : 'Leave empty to send as soon as you submit.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

        </div>
      )}

      {step === 'review' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" /> Review
            </CardTitle>
            <CardDescription>
              Everything this campaign will do, in one place. Sending cannot be
              undone, so this restates the three decisions rather than trusting
              that they are still remembered.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Outstanding problems first, each a way back to the step that
                owns it — a review that only says "you cannot send" leaves
                someone hunting through four stages for the reason. */}
            {COMPOSER_STEPS.some((entry) => stepProblems[entry.key]) && (
              <div className="mb-4 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                {COMPOSER_STEPS.filter((entry) => stepProblems[entry.key]).map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => goToStep(entry.key)}
                    className="flex w-full items-center gap-2 text-left text-sm text-destructive hover:underline"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="font-medium">{entry.label}:</span>
                    <span>{stepProblems[entry.key]}</span>
                  </button>
                ))}
              </div>
            )}

            <dl className="divide-y">
              <ReviewRow label="Audience">
                {audience === 'project' && 'Everyone in this project'}
                {audience === 'segment' &&
                  (segments.find((seg) => seg.id === segmentId)?.name ?? 'A segment')}
                {audience === 'devices' &&
                  `${selectedDevices.length} chosen ${selectedDevices.length === 1 ? 'person' : 'people'}`}
                <span className="block text-muted-foreground">
                  {audiencePreview.isPending
                    ? 'Counting reachable devices…'
                    : reach === undefined
                      ? 'Reach unknown'
                      : `${reach} reachable device${reach === 1 ? '' : 's'}`}
                </span>
              </ReviewRow>

              <ReviewRow label={silent ? 'Payload' : 'Message'}>
                {silent ? (
                  <span className="text-muted-foreground">
                    Silent — nothing is shown; the app is woken with data only.
                  </span>
                ) : (
                  <>
                    <span className="font-medium">{title || <em>No title</em>}</span>
                    {body.trim() && <span className="block text-muted-foreground">{body}</span>}
                  </>
                )}
              </ReviewRow>

              {!silent && (actions.length > 0 || carousel.length > 0 || hasTimer || imageUrl.trim() || iosCategory.trim()) && (
                <ReviewRow label="Extras">
                  <div className="flex flex-wrap gap-1.5">
                    {imageUrl.trim() && <Badge variant="secondary">Image</Badge>}
                    {actions.length > 0 && (
                      <Badge variant="secondary">
                        {actions.length} action button{actions.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                    {iosCategory.trim() && <Badge variant="secondary">iOS category</Badge>}
                    {carousel.length > 0 && (
                      <Badge variant="secondary">{carousel.length}-slide carousel</Badge>
                    )}
                    {hasTimer && (
                      <Badge variant="secondary">
                        {timerKind === 'duration' ? 'Relative countdown' : 'Countdown'}
                      </Badge>
                    )}
                  </div>
                </ReviewRow>
              )}

              {deepLinkUrl.trim() && (
                <ReviewRow label="Opens">
                  <code className="break-all text-xs">{deepLinkUrl}</code>
                </ReviewRow>
              )}

              {translations.length > 0 && !experimentMode && (
                <ReviewRow label="Languages">
                  <span className="flex items-center gap-1.5">
                    <Languages className="h-3.5 w-3.5 text-muted-foreground" />
                    {translations.length} translation{translations.length === 1 ? '' : 's'}
                  </span>
                </ReviewRow>
              )}

              {experimentMode && (
                <ReviewRow label="Experiment">
                  {variants.length} variant{variants.length === 1 ? '' : 's'}, {controlPercentage}% held back as control
                  {treatedRecipients !== undefined && (
                    <span className="block text-muted-foreground">
                      about {controlRecipients} in control, {treatedRecipients} treated
                    </span>
                  )}
                </ReviewRow>
              )}

              <ReviewRow label="When">
                {recurring ? (
                  <span className="flex items-center gap-1.5">
                    <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
                    Repeats {recurrenceSummary}
                  </span>
                ) : isScheduling ? (
                  <span className="flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                    {sendAt!.toLocaleString()}
                  </span>
                ) : (
                  'As soon as you send'
                )}
                {localDelivery && (
                  <span className="block text-muted-foreground">
                    <Globe className="mr-1 inline h-3.5 w-3.5" />
                    {sendTimeOptimised
                      ? 'At each recipient\u2019s best hour, on their own clock'
                      : `At ${localSendTime} on each recipient\u2019s own clock`}
                  </span>
                )}
              </ReviewRow>
            </dl>
          </CardContent>
        </Card>
      )}

      {/* Sticky action bar: the reach is restated next to the button because
          this is the last moment before an irreversible send. */}
      {/* Sticky rather than fixed: a fixed bar sits outside the dashboard's
          scroll container, so no amount of page padding reliably reserves
          space for it and it covered the last field even at full scroll. */}
      <div className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 py-4">
          {/* On the editing stages this says what is wrong with *this* stage;
              only the review restates the whole send, because that is the only
              place a send can happen from. */}
          <p
            className={`text-sm ${
              step !== 'review' && stepProblems[step]
                ? 'text-destructive'
                : 'text-muted-foreground'
            }`}
          >
            {step === 'review'
              ? actionBarMessage
              : stepProblems[step] ??
                COMPOSER_STEPS.find((entry) => entry.key === step)?.hint}
          </p>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                stepIndex === 0
                  ? navigate(backToList)
                  : goToStep(COMPOSER_STEPS[stepIndex - 1].key)
              }
            >
              {stepIndex === 0 ? 'Cancel' : 'Back'}
            </Button>

            {step !== 'review' ? (
              <Button
                onClick={() => goToStep(COMPOSER_STEPS[stepIndex + 1].key)}
                // Blocked on this stage's own problem only. A countdown that
                // a later schedule invalidates is reported by the stepper
                // rather than by trapping someone on a stage they have
                // finished.
                //
                // Deliberately not gated on `isConfigured`: a project without
                // FCM still lets someone draft the whole campaign, exactly as
                // the single-page version did. Only the send is refused, which
                // `canSend` already does, and the warning above says why.
                disabled={!!stepProblems[step]}
              >
                Next
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            ) : (
            <Button onClick={handleSubmit} disabled={!canSend}>
              {sendPush.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : recurring ? (
                <Repeat className="mr-2 h-4 w-4" />
              ) : isScheduling ? (
                <CalendarClock className="mr-2 h-4 w-4" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {recurring
                ? (experimentMode ? 'Schedule repeating experiment' : 'Schedule repeating campaign')
                : localDelivery
                  ? (experimentMode ? 'Schedule experiment by timezone' : 'Schedule by timezone')
                  : experimentMode
                    ? (isScheduling ? 'Schedule experiment' : 'Start experiment')
                    : isScheduling
                      ? 'Schedule campaign'
                      : 'Send campaign'}
            </Button>
            )}
          </div>
        </div>
      </div>

      {/* Applying a template or a preset overwrites every content field, so a
          draft the user has already typed is confirmed before it is thrown
          away. One dialog for both: the consequence is identical, and two
          near-copies of this would drift. */}
      <Dialog
        open={pendingTemplate !== null || pendingPreset !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTemplate(null);
            setPendingPreset(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Replace what you&rsquo;ve written?</DialogTitle>
            <DialogDescription>
              Applying &ldquo;{pendingTemplate?.name ?? pendingPreset?.name}
              &rdquo; overwrites the title, body, image, deep link, custom
              data, translations, action buttons, carousel and countdown in
              this campaign. That can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingTemplate(null);
                setPendingPreset(null);
              }}
            >
              Keep what I have
            </Button>
            <Button
              onClick={() => {
                if (pendingTemplate) applyTemplate(pendingTemplate);
                else if (pendingPreset) applyPreset(pendingPreset);
                setPendingTemplate(null);
                setPendingPreset(null);
              }}
            >
              Replace content
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
