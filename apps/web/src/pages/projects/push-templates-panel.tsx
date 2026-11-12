import { useState } from 'react';
import {
  FileText, Plus, Pencil, Trash2, AlertTriangle, ChevronDown, Braces, Smartphone, Languages,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  usePushTemplates,
  useCreatePushTemplate,
  useUpdatePushTemplate,
  useDeletePushTemplate,
  type PushTemplate,
  type PushTemplateInput,
} from '@/hooks/use-push-templates';
import type { PushDeliveryOptions, PushTranslations } from '@/hooks/use-push-notifications';
import { toast } from '@/components/ui/use-toast';

interface PushTemplatesPanelProps {
  projectId: string;
}

const EMPTY_FORM: PushTemplateInput = {
  name: '',
  description: null,
  title: '',
  body: null,
  imageUrl: null,
  deepLinkUrl: null,
  silent: false,
  data: null,
  deliveryOptions: null,
  translations: null,
};

function templateToForm(template: PushTemplate): PushTemplateInput {
  return {
    name: template.name,
    description: template.description,
    title: template.title,
    body: template.body,
    imageUrl: template.imageUrl,
    deepLinkUrl: template.deepLinkUrl,
    silent: template.silent,
    data: template.data,
    deliveryOptions: template.deliveryOptions,
    translations: template.translations,
  };
}

/** Blank textboxes are saved as `null`, not `''` — the API's own convention
 * for "not set" on optional content fields. */
function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** One custom data row as edited in the form. An empty key means "not filled
 * in yet", not a pair to send — `buildData` drops it rather than sending `""`. */
interface DataPairForm {
  key: string;
  value: string;
}

function dataToForm(data: Record<string, string> | null): DataPairForm[] {
  return data ? Object.entries(data).map(([key, value]) => ({ key, value })) : [];
}

function buildData(pairs: DataPairForm[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const trimmedKey = key.trim();
    if (trimmedKey === '') continue;
    result[trimmedKey] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** True once two rows share a (trimmed) key — the later row would silently
 * win when `buildData` collapses them into an object, so this blocks saving
 * instead of guessing which row the user meant to keep. */
function hasDuplicateDataKeys(pairs: DataPairForm[]): boolean {
  const seen = new Set<string>();
  for (const { key } of pairs) {
    const trimmedKey = key.trim();
    if (trimmedKey === '') continue;
    if (seen.has(trimmedKey)) return true;
    seen.add(trimmedKey);
  }
  return false;
}

/** Delivery options as edited in the form. Kept as strings/UI-friendly union
 * so a blank numeric box is `''`, not `NaN`, until `buildDeliveryOptions` runs. */
interface DeliveryOptionsForm {
  priority: 'default' | 'normal' | 'high';
  ttlSeconds: string;
  collapseKey: string;
  androidChannelId: string;
  androidSound: string;
  iosSound: string;
  iosBadge: string;
  iosThreadId: string;
}

const EMPTY_DELIVERY_FORM: DeliveryOptionsForm = {
  priority: 'default',
  ttlSeconds: '',
  collapseKey: '',
  androidChannelId: '',
  androidSound: '',
  iosSound: '',
  iosBadge: '',
  iosThreadId: '',
};

function deliveryOptionsToForm(options: PushDeliveryOptions | null): DeliveryOptionsForm {
  return {
    priority: options?.priority ?? 'default',
    ttlSeconds: options?.ttlSeconds !== undefined ? String(options.ttlSeconds) : '',
    collapseKey: options?.collapseKey ?? '',
    androidChannelId: options?.android?.channelId ?? '',
    androidSound: options?.android?.sound ?? '',
    iosSound: options?.ios?.sound ?? '',
    iosBadge: options?.ios?.badge !== undefined ? String(options.ios.badge) : '',
    iosThreadId: options?.ios?.threadId ?? '',
  };
}

/** An all-empty form means "leave FCM's own defaults alone", so it submits
 * `null` for the whole object rather than one full of `undefined` fields. */
function buildDeliveryOptions(form: DeliveryOptionsForm): PushDeliveryOptions | null {
  const options: PushDeliveryOptions = {};
  if (form.priority !== 'default') options.priority = form.priority;
  if (form.ttlSeconds.trim() !== '') options.ttlSeconds = Number(form.ttlSeconds);
  if (form.collapseKey.trim() !== '') options.collapseKey = form.collapseKey.trim();

  const android: NonNullable<PushDeliveryOptions['android']> = {};
  if (form.androidChannelId.trim() !== '') android.channelId = form.androidChannelId.trim();
  if (form.androidSound.trim() !== '') android.sound = form.androidSound.trim();
  if (Object.keys(android).length > 0) options.android = android;

  const ios: NonNullable<PushDeliveryOptions['ios']> = {};
  if (form.iosSound.trim() !== '') ios.sound = form.iosSound.trim();
  if (form.iosBadge.trim() !== '') ios.badge = Number(form.iosBadge);
  if (form.iosThreadId.trim() !== '') ios.threadId = form.iosThreadId.trim();
  if (Object.keys(ios).length > 0) options.ios = ios;

  return Object.keys(options).length > 0 ? options : null;
}

/** One language's title/body override, as edited in the form. */
interface TranslationForm {
  lang: string;
  title: string;
  body: string;
}

function translationsToForm(translations: PushTranslations | null): TranslationForm[] {
  return translations
    ? Object.entries(translations).map(([lang, t]) => ({
        lang,
        title: t.title ?? '',
        body: t.body ?? '',
      }))
    : [];
}

function buildTranslations(forms: TranslationForm[]): PushTranslations | null {
  const payload: PushTranslations = {};
  for (const t of forms) {
    const title = t.title.trim();
    const body = t.body.trim();
    if (!title && !body) continue; // nothing entered for this language
    payload[t.lang] = { title: title || undefined, body: body || undefined };
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

/** Lowercased, hyphen-only form, so `PT_br` and `pt-BR` compare equal — the
 * same normalisation `pickTranslation` applies on the API. */
function normaliseLangTag(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase();
}

/**
 * True for a syntactically plausible BCP 47 tag (`hi`, `pt-BR`). The API
 * stores translation keys as opaque strings with no format check of its own,
 * so a typo here would not error — it would just silently never match
 * anyone's device language.
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
 * Content-only template CRUD: list, create, edit, delete. Applying a
 * template when composing a campaign is a separate, later piece of work —
 * this panel only manages the saved content itself.
 */
export function PushTemplatesPanel({ projectId }: PushTemplatesPanelProps) {
  const { data: templates, isLoading } = usePushTemplates(projectId);
  const createTemplate = useCreatePushTemplate(projectId);
  const updateTemplate = useUpdatePushTemplate(projectId);
  const deleteTemplate = useDeletePushTemplate(projectId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PushTemplateInput>(EMPTY_FORM);
  const [nameError, setNameError] = useState<string | null>(null);

  // The three advanced content fields live in their own state, edited as
  // UI-friendly shapes (row lists, strings) and only turned into the
  // API's shapes in `handleSave` — same split as the campaign composer.
  const [dataPairs, setDataPairs] = useState<DataPairForm[]>([]);
  const [deliveryForm, setDeliveryForm] = useState<DeliveryOptionsForm>(EMPTY_DELIVERY_FORM);
  const [translationsList, setTranslationsList] = useState<TranslationForm[]>([]);
  const [newLang, setNewLang] = useState('');
  const [newLangError, setNewLangError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isSaving = createTemplate.isPending || updateTemplate.isPending;
  const isValid =
    form.name.trim() !== '' && form.title.trim() !== '' && !hasDuplicateDataKeys(dataPairs);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDataPairs([]);
    setDeliveryForm(EMPTY_DELIVERY_FORM);
    setTranslationsList([]);
    setNewLang('');
    setNewLangError(null);
    setAdvancedOpen(false);
    setNameError(null);
    setDialogOpen(true);
  };

  const openEdit = (template: PushTemplate) => {
    setEditingId(template.id);
    setForm(templateToForm(template));
    setDataPairs(dataToForm(template.data));
    setDeliveryForm(deliveryOptionsToForm(template.deliveryOptions));
    setTranslationsList(translationsToForm(template.translations));
    setNewLang('');
    setNewLangError(null);
    // Opened when the template actually has advanced content: leaving it
    // collapsed would hide data keys, delivery tuning or translations that
    // are already set, and saving from a form that never showed them reads
    // as the edit having silently dropped them.
    setAdvancedOpen(
      template.data !== null ||
        template.deliveryOptions !== null ||
        template.translations !== null,
    );
    setNameError(null);
    setDialogOpen(true);
  };

  const addDataPair = () => {
    setDataPairs((prev) => [...prev, { key: '', value: '' }]);
  };

  const updateDataPair = (index: number, patch: Partial<DataPairForm>) => {
    setDataPairs((prev) => prev.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  };

  const removeDataPair = (index: number) => {
    setDataPairs((prev) => prev.filter((_, i) => i !== index));
  };

  const addTranslation = () => {
    const error = getNewTranslationError(newLang, translationsList);
    if (error) {
      setNewLangError(error);
      return;
    }
    // Canonicalised so a sloppily-cased or underscored entry (`PT_br`) is
    // stored and displayed the way the API's own docs write it (`pt-BR`).
    const canonical = Intl.getCanonicalLocales(newLang.trim().replace(/_/g, '-'))[0];
    setTranslationsList((prev) => [...prev, { lang: canonical, title: '', body: '' }]);
    setNewLang('');
    setNewLangError(null);
  };

  const removeTranslation = (index: number) => {
    setTranslationsList((prev) => prev.filter((_, i) => i !== index));
  };

  const updateTranslation = (index: number, patch: Partial<TranslationForm>) => {
    setTranslationsList((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  };

  const handleSave = async () => {
    if (!isValid) return;
    setNameError(null);

    const payload: PushTemplateInput = {
      name: form.name.trim(),
      title: form.title.trim(),
      description: blankToNull(form.description),
      body: blankToNull(form.body),
      imageUrl: blankToNull(form.imageUrl),
      deepLinkUrl: blankToNull(form.deepLinkUrl),
      silent: form.silent,
      data: buildData(dataPairs),
      deliveryOptions: buildDeliveryOptions(deliveryForm),
      translations: buildTranslations(translationsList),
    };

    try {
      if (editingId) {
        await updateTemplate.mutateAsync({ id: editingId, ...payload });
        toast({ title: 'Template updated' });
      } else {
        await createTemplate.mutateAsync(payload);
        toast({ title: 'Template created' });
      }
      setDialogOpen(false);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        // The one failure mode worth calling out specifically: a picker with
        // two templates of the same name is how the wrong copy gets sent.
        setNameError(
          err?.response?.data?.message ?? `A template named "${payload.name}" already exists.`,
        );
      } else {
        toast({
          title: editingId ? 'Could not update template' : 'Could not create template',
          description: err?.response?.data?.message ?? 'Unknown error',
          variant: 'destructive',
        });
      }
    }
  };

  const handleDelete = (template: PushTemplate) => {
    if (!confirm(`Delete the template "${template.name}"? This cannot be undone.`)) return;
    deleteTemplate.mutate(template.id, {
      onError: (err: any) => {
        toast({
          title: 'Could not delete template',
          description: err?.response?.data?.message ?? 'Unknown error',
          variant: 'destructive',
        });
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> New template
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
          <CardDescription>
            Reusable notification content — title, body, image, deep link.
            A template never holds an audience or a schedule; those are
            chosen fresh each time you send.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : !templates || templates.length === 0 ? (
            <div className="py-12 text-center">
              <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No templates yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                A template saves a notification's content so it can be reused
                across campaigns. It holds content only — no audience and no
                schedule — since those are decisions about a particular send,
                not something worth freezing into a saved template.
              </p>
              <Button variant="outline" className="mt-4" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> Create your first template
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Uses</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell className="font-medium">{template.name}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                      {template.description || '—'}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-sm">
                      {template.title}
                      {template.silent && (
                        <span className="ml-2 text-xs text-muted-foreground">(silent)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {template.useCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEdit(template)}>
                          <Pencil className="mr-1 h-4 w-4" /> Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(template)}
                          disabled={deleteTemplate.isPending}
                        >
                          <Trash2 className="mr-1 h-4 w-4" /> Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit template' : 'New template'}</DialogTitle>
            <DialogDescription>
              Content only — audience and schedule are chosen when you send a
              campaign, not saved here.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  if (nameError) setNameError(null);
                }}
                placeholder="e.g. Weekly promo"
              />
              {nameError && (
                <p className="flex items-start gap-1 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {nameError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={form.description ?? ''}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this template is for, and when to use it"
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Notification title"
              />
            </div>

            <div className="space-y-2">
              <Label>Body</Label>
              <Textarea
                value={form.body ?? ''}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="Notification body"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Image URL</Label>
              <Input
                value={form.imageUrl ?? ''}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                placeholder="https://…"
              />
            </div>

            <div className="space-y-2">
              <Label>Deep link URL</Label>
              <Input
                value={form.deepLinkUrl ?? ''}
                onChange={(e) => setForm({ ...form, deepLinkUrl: e.target.value })}
                placeholder="Where a tap should land"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>Silent</Label>
                <p className="text-xs text-muted-foreground">
                  Data-only push — no notification is shown to the recipient.
                </p>
              </div>
              <Switch
                checked={form.silent}
                onCheckedChange={(checked) => setForm({ ...form, silent: checked })}
              />
            </div>

            <Separator />

            {/* Secondary content, tucked away so the common case (name,
               title, body) stays a short form. */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-left text-sm font-medium">
                Advanced options
                <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  {advancedOpen ? 'Hide' : 'Show'}
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                  />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-6 pt-4">
                {/* Data */}
                <div className="space-y-3">
                  <div>
                    <Label className="flex items-center gap-2">
                      <Braces className="h-4 w-4" /> Data
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Custom key/value pairs delivered with the message, for
                      the app to act on — never shown to the recipient.
                    </p>
                  </div>
                  {dataPairs.length > 0 && (
                    <div className="space-y-2">
                      {dataPairs.map((pair, index) => {
                        const trimmedKey = pair.key.trim();
                        const isDuplicate = trimmedKey !== '' && dataPairs.some(
                          (other, otherIndex) => otherIndex !== index && other.key.trim() === trimmedKey,
                        );
                        return (
                          <div key={index} className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Input
                                value={pair.key}
                                onChange={(e) => updateDataPair(index, { key: e.target.value })}
                                placeholder="Key"
                                className={isDuplicate ? 'border-destructive' : ''}
                              />
                              <Input
                                value={pair.value}
                                onChange={(e) => updateDataPair(index, { value: e.target.value })}
                                placeholder="Value"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeDataPair(index)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                            {isDuplicate && (
                              <p className="text-xs text-destructive">
                                Duplicate key — pick a different one for each row.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <Button type="button" variant="outline" size="sm" onClick={addDataPair}>
                    <Plus className="mr-2 h-4 w-4" /> Add pair
                  </Button>
                </div>

                <Separator />

                {/* Delivery options */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" /> Delivery options
                  </Label>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">Priority</Label>
                      <Select
                        value={deliveryForm.priority}
                        onValueChange={(v) =>
                          setDeliveryForm({ ...deliveryForm, priority: v as DeliveryOptionsForm['priority'] })
                        }
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
                      <Label className="text-xs font-normal text-muted-foreground">
                        Time to live (seconds)
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        value={deliveryForm.ttlSeconds}
                        onChange={(e) => setDeliveryForm({ ...deliveryForm, ttlSeconds: e.target.value })}
                        placeholder="e.g. 3600"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">Collapse key</Label>
                      <Input
                        value={deliveryForm.collapseKey}
                        onChange={(e) => setDeliveryForm({ ...deliveryForm, collapseKey: e.target.value })}
                        placeholder="e.g. order-updates"
                      />
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">
                        Android notification channel
                      </Label>
                      <Input
                        value={deliveryForm.androidChannelId}
                        onChange={(e) =>
                          setDeliveryForm({ ...deliveryForm, androidChannelId: e.target.value })
                        }
                        placeholder="e.g. promotions"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">Android sound</Label>
                      <Input
                        value={deliveryForm.androidSound}
                        onChange={(e) => setDeliveryForm({ ...deliveryForm, androidSound: e.target.value })}
                        placeholder="e.g. default"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">iOS sound</Label>
                      <Input
                        value={deliveryForm.iosSound}
                        onChange={(e) => setDeliveryForm({ ...deliveryForm, iosSound: e.target.value })}
                        placeholder="e.g. default"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">iOS badge</Label>
                      <Input
                        type="number"
                        min={0}
                        value={deliveryForm.iosBadge}
                        onChange={(e) => setDeliveryForm({ ...deliveryForm, iosBadge: e.target.value })}
                        placeholder="e.g. 1"
                      />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label className="text-xs font-normal text-muted-foreground">iOS thread id</Label>
                      <Input
                        value={deliveryForm.iosThreadId}
                        onChange={(e) => setDeliveryForm({ ...deliveryForm, iosThreadId: e.target.value })}
                        placeholder="Groups related notifications"
                      />
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Translations */}
                <div className="space-y-3">
                  <div>
                    <Label className="flex items-center gap-2">
                      <Languages className="h-4 w-4" /> Translations
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Per-language title/body overrides. A language with no
                      entry here still gets this template's own title and body.
                    </p>
                  </div>

                  {translationsList.length > 0 && (
                    <div className="space-y-3">
                      {translationsList.map((translation, index) => (
                        <div key={translation.lang} className="space-y-3 rounded-lg border p-3">
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="secondary">{translation.lang}</Badge>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeTranslation(index)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-normal text-muted-foreground">Title</Label>
                            <Input
                              value={translation.title}
                              onChange={(e) => updateTranslation(index, { title: e.target.value })}
                              placeholder="Leave blank to use the title above"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-normal text-muted-foreground">Body</Label>
                            <Textarea
                              value={translation.body}
                              onChange={(e) => updateTranslation(index, { body: e.target.value })}
                              placeholder="Leave blank to use the body above"
                              rows={2}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-2">
                      <Label className="text-xs font-normal text-muted-foreground">Language tag</Label>
                      <Input
                        value={newLang}
                        onChange={(e) => {
                          setNewLang(e.target.value);
                          setNewLangError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addTranslation();
                          }
                        }}
                        placeholder="e.g. hi, pt-BR"
                      />
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addTranslation}>
                      <Plus className="mr-2 h-4 w-4" /> Add
                    </Button>
                  </div>
                  {newLangError && <p className="text-xs text-destructive">{newLangError}</p>}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!isValid || isSaving}>
              {isSaving ? 'Saving…' : editingId ? 'Save changes' : 'Create template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
