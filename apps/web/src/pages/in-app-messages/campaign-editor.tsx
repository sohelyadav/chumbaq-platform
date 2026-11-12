import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Save, ChevronRight, X, Plus, Smartphone, Monitor,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  SelectRoot as Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useInAppMessage,
  useCreateInAppMessage,
  useUpdateInAppMessage,
  type InAppMessage,
  type MessageType,
  type TriggerType,
  type UserType,
  type MessageButton,
  type MessageTheme,
} from '@/hooks/use-in-app-messages';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { InAppTemplateGallery } from '@/components/in-app-template-gallery';
import type { InAppPreset } from '@/lib/in-app-content';

// ─── Constants ──────────────────────────────────────

const MESSAGE_TYPES: Array<{ value: MessageType; label: string; icon: string; desc: string }> = [
  { value: 'modal', label: 'Modal', icon: '💬', desc: 'Center dialog' },
  { value: 'bottom_sheet', label: 'Bottom Sheet', icon: '📋', desc: 'Slides up' },
  { value: 'banner_top', label: 'Top Banner', icon: '🔔', desc: 'Top sticky' },
  { value: 'banner_bottom', label: 'Bottom Banner', icon: '📢', desc: 'Bottom sticky' },
  { value: 'fullscreen', label: 'Full Screen', icon: '📱', desc: 'Full takeover' },
];

const TRIGGER_TYPES: Array<{ value: TriggerType; label: string; desc: string }> = [
  { value: 'on_app_open', label: 'App Open', desc: 'When app opens or page loads' },
  { value: 'on_event', label: 'On Event', desc: 'When a specific event fires' },
  { value: 'on_screen', label: 'On Screen', desc: 'When a screen/page is viewed' },
  { value: 'immediate', label: 'Server Push', desc: 'Trigger instantly from dashboard' },
  { value: 'scheduled', label: 'Scheduled', desc: 'Within a time window' },
];

const USER_TYPES: Array<{ value: UserType; label: string }> = [
  { value: 'all', label: 'All Users' },
  { value: 'cohort', label: 'Mixpanel Cohort' },
  { value: 'segment', label: 'Custom Segment' },
];

const ANIMATIONS = [
  { value: 'fade', label: 'Fade' },
  { value: 'slide_up', label: 'Slide Up' },
  { value: 'slide_down', label: 'Slide Down' },
  { value: 'scale', label: 'Scale' },
  { value: 'none', label: 'None' },
];

type EditorStep = 'content' | 'trigger' | 'users' | 'schedule';

const STEPS: Array<{ key: EditorStep; label: string; num: number }> = [
  { key: 'content', label: 'Content & Design', num: 1 },
  { key: 'trigger', label: 'Trigger', num: 2 },
  { key: 'users', label: 'Users', num: 3 },
  { key: 'schedule', label: 'Schedule & Limits', num: 4 },
];

// ─── Form State ─────────────────────────────────────

interface FormState {
  name: string;
  messageType: MessageType;
  title: string;
  body: string;
  imageUrl: string;
  imagePosition: string;
  buttons: MessageButton[];
  theme: MessageTheme;
  dismissOnTapOutside: boolean;
  autoDismissSeconds: number | null;
  triggerType: TriggerType;
  triggerEvent: string;
  triggerScreen: string;
  triggerDelaySeconds: number;
  userType: UserType;
  mixpanelCohortId: string;
  startsAt: string;
  endsAt: string;
  priority: number;
  maxImpressionsPerUser: number | null;
  minIntervalSeconds: number | null;
  tags: string[];
}

const defaultForm: FormState = {
  name: '',
  messageType: 'modal',
  title: '',
  body: '',
  imageUrl: '',
  imagePosition: 'top',
  buttons: [],
  theme: {
    backgroundColor: '#ffffff',
    textColor: '#374151',
    titleColor: '#111827',
    buttonPrimaryColor: '#6366f1',
    buttonSecondaryColor: '#e5e7eb',
    overlayColor: 'rgba(0,0,0,0.5)',
    borderRadius: 16,
    animation: 'fade',
  },
  dismissOnTapOutside: true,
  autoDismissSeconds: null,
  triggerType: 'on_app_open',
  triggerEvent: '',
  triggerScreen: '',
  triggerDelaySeconds: 0,
  userType: 'all',
  mixpanelCohortId: '',
  startsAt: '',
  endsAt: '',
  priority: 0,
  maxImpressionsPerUser: null,
  minIntervalSeconds: null,
  tags: [],
};

// ─── Phone Preview ──────────────────────────────────

function PhonePreview({ form }: { form: FormState }) {
  const t = form.theme;
  const radius = `${t.borderRadius ?? 16}px`;

  const renderButtons = () => {
    if (!form.buttons.length) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {form.buttons.map((btn) => {
          const isPrimary = btn.style === 'primary';
          const isText = btn.style === 'text';
          return (
            <div
              key={btn.id}
              style={{
                padding: '8px 0',
                borderRadius: 8,
                textAlign: 'center',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'default',
                ...(isPrimary
                  ? { backgroundColor: t.buttonPrimaryColor, color: '#fff' }
                  : isText
                    ? { color: t.buttonPrimaryColor, textDecoration: 'underline', background: 'transparent' }
                    : { border: `1.5px solid ${t.buttonPrimaryColor}`, color: t.buttonPrimaryColor, background: 'transparent' }),
              }}
            >
              {btn.text}
            </div>
          );
        })}
      </div>
    );
  };

  // A banner and a sheet have less room for a picture than a modal, which
  // is the same split both SDKs draw.
  const pictureHeight = (compact: boolean) => (compact ? 70 : 100);

  const picture = (compact: boolean) => (
    <div style={{ width: '100%', height: pictureHeight(compact), background: '#e5e7eb', overflow: 'hidden' }}>
      <img src={form.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
    </div>
  );

  const messageCard = (style: React.CSSProperties = {}, compact = false) => {
    const hasImage = Boolean(form.imageUrl);
    const position = form.imagePosition;

    return (
    <div
      style={{
        background: t.backgroundColor,
        borderRadius: radius,
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        // `background` puts the picture behind the copy, which needs a
        // stacking context for the scrim to sit between them.
        ...(hasImage && position === 'background'
          ? {
              backgroundImage: `url(${form.imageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : {}),
        ...style,
      }}
    >
      {hasImage && position === 'top' && picture(compact)}
      <div
        style={{
          padding: '16px 18px',
          // The theme's text colours were chosen against the background
          // *colour*; a photograph swallows either of them. Both SDKs lay
          // the same scrim over it.
          ...(hasImage && position === 'background'
            ? { background: t.overlayColor || 'rgba(0,0,0,0.4)' }
            : {}),
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: t.titleColor,
            lineHeight: '1.3',
            marginBottom: form.body ? 6 : 0,
          }}
        >
          {form.title || 'Message Title'}
        </div>
        {form.body && (
          <div style={{ fontSize: 12, color: t.textColor, lineHeight: '1.5', opacity: 0.85 }}>
            {form.body}
          </div>
        )}
        {/* `center` is "between the copy and the call to action", which is
            the only reading that tells it apart from `top`. */}
        {hasImage && position === 'center' && (
          <div style={{ marginTop: 10, borderRadius: 8, overflow: 'hidden' }}>{picture(compact)}</div>
        )}
        {renderButtons()}
      </div>
    </div>
    );
  };

  // Status bar dots
  const statusBar = (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 16px 2px', fontSize: 10, fontWeight: 600, color: '#1f2937' }}>
      <span>9:41</span>
      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        <div style={{ width: 14, height: 8, border: '1px solid #374151', borderRadius: 2, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 9, height: 5, background: '#374151', borderRadius: 1, marginLeft: 1 }} />
        </div>
      </div>
    </div>
  );

  const appContent = (
    <div style={{ padding: '8px 12px' }}>
      {/* Fake app header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#111' }}>My App</div>
          <div style={{ fontSize: 8, color: '#9ca3af' }}>Welcome back</div>
        </div>
      </div>
      {/* Fake content cards */}
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ background: '#f3f4f6', borderRadius: 10, padding: 10, marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: i === 1 ? '#dbeafe' : i === 2 ? '#fce7f3' : '#d1fae5', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ height: 8, background: '#d1d5db', borderRadius: 4, marginBottom: 4, width: `${70 + i * 8}%` }} />
            <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, width: `${50 + i * 5}%` }} />
          </div>
        </div>
      ))}
    </div>
  );

  const phoneFrame = (content: React.ReactNode) => (
    <div
      style={{
        width: 260,
        height: 520,
        borderRadius: 32,
        border: '6px solid #1f2937',
        background: '#ffffff',
        overflow: 'hidden',
        position: 'relative',
        boxShadow: '0 20px 60px rgba(0,0,0,0.15), inset 0 0 0 1px rgba(255,255,255,0.1)',
      }}
    >
      {/* Notch */}
      <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 80, height: 22, background: '#1f2937', borderRadius: '0 0 16px 16px', zIndex: 50 }} />
      {statusBar}
      <div style={{ position: 'relative', height: 'calc(100% - 24px)', overflow: 'hidden' }}>
        {content}
      </div>
      {/* Home indicator */}
      <div style={{ position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50)', width: 100, height: 4, background: '#1f2937', borderRadius: 2 }} />
    </div>
  );

  // Render based on message type
  if (form.messageType === 'modal') {
    return phoneFrame(
      <>
        {appContent}
        <div style={{ position: 'absolute', inset: 0, background: t.overlayColor, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 10 }}>
          <div style={{ width: '100%', position: 'relative' }}>
            <button
              style={{ position: 'absolute', top: -8, right: -4, width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', fontSize: 12, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}
            >
              ✕
            </button>
            {messageCard({ borderRadius: radius })}
          </div>
        </div>
      </>
    );
  }

  if (form.messageType === 'bottom_sheet') {
    return phoneFrame(
      <>
        {appContent}
        <div style={{ position: 'absolute', inset: 0, background: t.overlayColor, display: 'flex', alignItems: 'flex-end', zIndex: 10 }}>
          <div style={{ width: '100%', position: 'relative' }}>
            {/* Drag handle */}
            <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', width: 36, height: 4, borderRadius: 2, background: 'rgba(0,0,0,0.2)', zIndex: 2 }} />
            {messageCard({ borderRadius: `${t.borderRadius}px ${t.borderRadius}px 0 0`, paddingTop: 8 }, true)}
          </div>
        </div>
      </>
    );
  }

  if (form.messageType === 'banner_top') {
    return phoneFrame(
      <>
        <div style={{ position: 'absolute', top: 24, left: 0, right: 0, zIndex: 10, padding: '0 8px' }}>
          {messageCard({ borderRadius: radius, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }, true)}
        </div>
        {appContent}
      </>
    );
  }

  if (form.messageType === 'banner_bottom') {
    return phoneFrame(
      <>
        {appContent}
        <div style={{ position: 'absolute', bottom: 14, left: 0, right: 0, zIndex: 10, padding: '0 8px' }}>
          {messageCard({ borderRadius: radius, boxShadow: '0 -4px 16px rgba(0,0,0,0.12)' }, true)}
        </div>
      </>
    );
  }

  // fullscreen
  const fullscreenImage = Boolean(form.imageUrl) && form.imagePosition !== 'background';
  return phoneFrame(
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: t.backgroundColor,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
        // `background` fills the screen behind the copy. This branch used to
        // draw the picture at 40% height whatever the campaign chose, so
        // `background` and `center` both came out as `top`.
        ...(Boolean(form.imageUrl) && form.imagePosition === 'background'
          ? { backgroundImage: `url(${form.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : {}),
      }}
    >
      <button
        style={{ position: 'absolute', top: 8, right: 12, width: 24, height: 24, borderRadius: '50%', background: 'rgba(0,0,0,0.3)', color: '#fff', border: 'none', fontSize: 12, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}
      >
        ✕
      </button>
      {fullscreenImage && form.imagePosition === 'top' && (
        <div style={{ width: '100%', height: '40%', background: '#e5e7eb', overflow: 'hidden' }}>
          <img src={form.imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
      )}
      <div
        style={{
          flex: 1,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          ...(Boolean(form.imageUrl) && form.imagePosition === 'background'
            ? { background: t.overlayColor || 'rgba(0,0,0,0.4)' }
            : {}),
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: t.titleColor, marginBottom: 8, lineHeight: '1.3' }}>
          {form.title || 'Message Title'}
        </div>
        {form.body && (
          <div style={{ fontSize: 12, color: t.textColor, lineHeight: '1.6', opacity: 0.85 }}>
            {form.body}
          </div>
        )}
        {fullscreenImage && form.imagePosition === 'center' && (
          <div style={{ marginTop: 12, borderRadius: 8, overflow: 'hidden', maxHeight: 140 }}>
            <img src={form.imageUrl} alt="" style={{ width: '100%', height: 140, objectFit: 'cover' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
        {renderButtons()}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────

export default function CampaignEditorPage() {
  const { projectId, id } = useParams<{ projectId: string; id?: string }>();
  const navigate = useNavigate();
  const isEditing = !!id;

  const { data: existingMessage } = useInAppMessage(projectId, id);
  const createMutation = useCreateInAppMessage(projectId!);
  const updateMutation = useUpdateInAppMessage(projectId!, id || '');

  const [form, setForm] = useState<FormState>(defaultForm);
  const [step, setStep] = useState<EditorStep>('content');
  /** Which preset the content came from, for the gallery's selected state. */
  const [presetId, setPresetId] = useState('');
  const [pendingPreset, setPendingPreset] = useState<InAppPreset | null>(null);

  /**
   * Fills the content fields from a preset.
   *
   * Presentation only — trigger, audience and schedule are left alone,
   * because those are decisions about this campaign rather than about its
   * shape, and the steps after this one ask for them. The campaign's name is
   * left alone too: it is how someone finds this message later, and a preset
   * cannot know what to call it.
   */
  /** True when there is content a preset would overwrite. */
  const hasContent =
    form.title.trim() !== '' ||
    form.body.trim() !== '' ||
    form.imageUrl.trim() !== '' ||
    form.buttons.length > 0;

  const handlePresetSelect = (preset: InAppPreset) => {
    if (hasContent) {
      setPendingPreset(preset);
      return;
    }
    applyPreset(preset);
  };

  const applyPreset = (preset: InAppPreset) => {
    const content = preset.content;
    setForm((current) => ({
      ...current,
      messageType: content.messageType,
      title: content.title,
      body: content.body,
      imageUrl: content.imageUrl,
      imagePosition: content.imagePosition,
      // Copied rather than shared: editing a button afterwards must not
      // rewrite the preset for the rest of the session.
      buttons: content.buttons.map((b) => ({ ...b })),
      theme: { ...current.theme, ...content.theme },
      dismissOnTapOutside: content.dismissOnTapOutside,
      autoDismissSeconds: content.autoDismissSeconds,
    }));
    setPresetId(preset.id);
  };

  const startBlank = () => {
    setForm((current) => ({
      ...current,
      messageType: defaultForm.messageType,
      title: '',
      body: '',
      imageUrl: '',
      imagePosition: defaultForm.imagePosition,
      buttons: [],
      theme: defaultForm.theme,
      dismissOnTapOutside: defaultForm.dismissOnTapOutside,
      autoDismissSeconds: defaultForm.autoDismissSeconds,
    }));
    setPresetId('');
  };

  useEffect(() => {
    if (existingMessage) {
      setForm({
        name: existingMessage.name,
        messageType: existingMessage.messageType,
        title: existingMessage.title,
        body: existingMessage.body || '',
        imageUrl: existingMessage.imageUrl || '',
        imagePosition: existingMessage.imagePosition || 'top',
        buttons: existingMessage.buttons || [],
        theme: existingMessage.theme || defaultForm.theme,
        dismissOnTapOutside: existingMessage.dismissOnTapOutside,
        autoDismissSeconds: existingMessage.autoDismissSeconds,
        triggerType: existingMessage.triggerType,
        triggerEvent: existingMessage.triggerEvent || '',
        triggerScreen: existingMessage.triggerScreen || '',
        triggerDelaySeconds: existingMessage.triggerDelaySeconds,
        userType: existingMessage.userType,
        mixpanelCohortId: existingMessage.mixpanelCohortId || '',
        startsAt: existingMessage.startsAt || '',
        endsAt: existingMessage.endsAt || '',
        priority: existingMessage.priority,
        maxImpressionsPerUser: existingMessage.maxImpressionsPerUser,
        minIntervalSeconds: existingMessage.minIntervalSeconds,
        tags: existingMessage.tags || [],
      });
    }
  }, [existingMessage]);

  const handleSave = async () => {
    if (!form.name || !form.title) {
      toast({ title: 'Name and title are required', variant: 'destructive' });
      return;
    }
    try {
      const payload = {
        ...form,
        body: form.body || undefined,
        imageUrl: form.imageUrl || undefined,
        triggerEvent: form.triggerEvent || undefined,
        triggerScreen: form.triggerScreen || undefined,
        mixpanelCohortId: form.mixpanelCohortId || undefined,
        startsAt: form.startsAt || undefined,
        endsAt: form.endsAt || undefined,
        tags: form.tags.length > 0 ? form.tags : undefined,
      };
      if (isEditing) {
        await updateMutation.mutateAsync(payload);
        toast({ title: 'Campaign updated' });
      } else {
        const created = await createMutation.mutateAsync(payload);
        toast({ title: 'Campaign created' });
        navigate(`/projects/${projectId}/in-app-messages/${created.id}`, { replace: true });
      }
    } catch {
      toast({ title: 'Failed to save', variant: 'destructive' });
    }
  };

  const addButton = () => {
    setForm({
      ...form,
      buttons: [
        ...form.buttons,
        {
          id: `btn_${Date.now()}`,
          text: 'Click Me',
          action: 'dismiss',
          style: form.buttons.length === 0 ? 'primary' : 'secondary',
        },
      ],
    });
  };

  const updateButton = (i: number, u: Partial<MessageButton>) => {
    const btns = [...form.buttons];
    btns[i] = { ...btns[i], ...u };
    setForm({ ...form, buttons: btns });
  };

  const removeButton = (i: number) => {
    setForm({ ...form, buttons: form.buttons.filter((_, idx) => idx !== i) });
  };

  const updateTheme = (key: keyof MessageTheme, value: any) => {
    setForm({ ...form, theme: { ...form.theme, [key]: value } });
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const currentStepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* ─── Top Bar ─── */}
      <div className="flex items-center justify-between border-b bg-background px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/projects/${projectId}/in-app-messages`)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{isEditing ? 'Edit Campaign' : 'New Campaign'}</h1>
              <Badge variant="outline" className="text-[10px]">
                {MESSAGE_TYPES.find((t) => t.value === form.messageType)?.label || 'Modal'}
              </Badge>
            </div>
            {form.name && (
              <p className="text-xs text-muted-foreground">{form.name}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/in-app-messages`)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? 'Saving...' : isEditing ? 'Update' : 'Save Campaign'}
          </Button>
        </div>
      </div>

      {/* ─── Step Progress ─── */}
      <div className="flex items-center gap-1 border-b bg-muted/30 px-4 py-2 shrink-0">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            onClick={() => setStep(s.key)}
            className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all ${
              step === s.key
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
              step === s.key ? 'bg-primary-foreground text-primary' : 'bg-muted text-muted-foreground'
            }`}>
              {s.num}
            </span>
            {s.label}
          </button>
        ))}
      </div>

      {/* ─── Main Content: Editor + Preview ─── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Editor Panel */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* ── Step 1: Content & Design ── */}
          {step === 'content' && (
            <>
              {/* Above the fields, because choosing one rewrites them —
                  a decision that comes first, not one offered halfway down. */}
              <InAppTemplateGallery
                selectedPresetId={presetId}
                onSelect={handlePresetSelect}
                onStartBlank={startBlank}
              />

              {/* Campaign Name */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Campaign Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Welcome Offer Modal"
                  className="h-10"
                />
              </div>

              {/* Message Type */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Message Type</Label>
                <div className="grid grid-cols-5 gap-2">
                  {MESSAGE_TYPES.map((type) => (
                    <button
                      key={type.value}
                      onClick={() => setForm({ ...form, messageType: type.value })}
                      className={`flex flex-col items-center gap-1 rounded-lg border-2 p-2.5 text-center transition-all ${
                        form.messageType === type.value
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-transparent bg-muted/50 hover:bg-muted'
                      }`}
                    >
                      <span className="text-lg">{type.icon}</span>
                      <span className="text-[11px] font-semibold leading-tight">{type.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Message Content */}
              <Card className="border-dashed">
                <CardContent className="p-4 space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Title *</Label>
                    <Input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="🎉 Welcome to our app!"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Body</Label>
                    <Textarea
                      value={form.body}
                      onChange={(e) => setForm({ ...form, body: e.target.value })}
                      placeholder="Add a description for your message..."
                      rows={2}
                      className="resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2 space-y-1.5">
                      <Label className="text-sm">Image URL</Label>
                      <Input
                        value={form.imageUrl}
                        onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                        placeholder="https://example.com/hero.png"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm">Position</Label>
                      <Select value={form.imagePosition} onValueChange={(v) => setForm({ ...form, imagePosition: v })}>
                        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="top">Top</SelectItem>
                          <SelectItem value="center">Center</SelectItem>
                          <SelectItem value="background">Background</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* CTA Buttons */}
              <Card className="border-dashed">
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">CTA Buttons</CardTitle>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={addButton} disabled={form.buttons.length >= 3}>
                      <Plus className="mr-1 h-3 w-3" /> Add Button
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-2">
                  {form.buttons.map((btn, i) => (
                    <div key={btn.id} className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5">
                      <div className="flex-1 grid grid-cols-3 gap-2">
                        <Input
                          value={btn.text}
                          onChange={(e) => updateButton(i, { text: e.target.value })}
                          placeholder="Label"
                          className="h-8 text-xs"
                        />
                        <Select value={btn.action} onValueChange={(v: any) => updateButton(i, { action: v })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="dismiss">Dismiss</SelectItem>
                            <SelectItem value="url">Open URL</SelectItem>
                            <SelectItem value="deep_link">Deep Link</SelectItem>
                            <SelectItem value="custom_event">Event</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select value={btn.style} onValueChange={(v: any) => updateButton(i, { style: v })}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="primary">Primary</SelectItem>
                            <SelectItem value="secondary">Secondary</SelectItem>
                            <SelectItem value="text">Text</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeButton(i)}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  {form.buttons.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      No buttons — message will have a close/dismiss button only
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Appearance */}
              <Card className="border-dashed">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm">Appearance</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { key: 'backgroundColor', label: 'Background' },
                      { key: 'titleColor', label: 'Title' },
                      { key: 'textColor', label: 'Body Text' },
                    ].map(({ key, label }) => (
                      <div key={key} className="space-y-1">
                        <Label className="text-xs">{label}</Label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="color"
                            value={(form.theme as any)[key] || '#000000'}
                            onChange={(e) => updateTheme(key as keyof MessageTheme, e.target.value)}
                            className="w-7 h-7 rounded border cursor-pointer p-0"
                          />
                          <Input
                            value={(form.theme as any)[key] || ''}
                            onChange={(e) => updateTheme(key as keyof MessageTheme, e.target.value)}
                            className="h-8 text-xs font-mono"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Button Color</Label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="color"
                          value={form.theme.buttonPrimaryColor || '#6366f1'}
                          onChange={(e) => updateTheme('buttonPrimaryColor', e.target.value)}
                          className="w-7 h-7 rounded border cursor-pointer p-0"
                        />
                        <Input
                          value={form.theme.buttonPrimaryColor || ''}
                          onChange={(e) => updateTheme('buttonPrimaryColor', e.target.value)}
                          className="h-8 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Corner Radius</Label>
                      <Input
                        type="number"
                        value={form.theme.borderRadius ?? 16}
                        onChange={(e) => updateTheme('borderRadius', parseInt(e.target.value, 10))}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Animation</Label>
                      <Select value={form.theme.animation || 'fade'} onValueChange={(v: any) => updateTheme('animation', v)}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ANIMATIONS.map((a) => (
                            <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <Label className="text-xs">Dismiss on Tap Outside</Label>
                    </div>
                    <Switch
                      checked={form.dismissOnTapOutside}
                      onCheckedChange={(v) => setForm({ ...form, dismissOnTapOutside: v })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Auto-dismiss (seconds)</Label>
                    <Input
                      type="number"
                      value={form.autoDismissSeconds ?? ''}
                      onChange={(e) => setForm({ ...form, autoDismissSeconds: e.target.value ? parseInt(e.target.value, 10) : null })}
                      placeholder="Leave empty to disable"
                      className="h-8 text-xs"
                    />
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {/* ── Step 2: Trigger ── */}
          {step === 'trigger' && (
            <>
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">When to show</Label>
                <div className="space-y-1.5">
                  {TRIGGER_TYPES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setForm({ ...form, triggerType: t.value })}
                      className={`w-full flex items-center justify-between rounded-lg border-2 px-4 py-3 text-left transition-all ${
                        form.triggerType === t.value
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-transparent bg-muted/40 hover:bg-muted/70'
                      }`}
                    >
                      <div>
                        <p className="text-sm font-medium">{t.label}</p>
                        <p className="text-[11px] text-muted-foreground">{t.desc}</p>
                      </div>
                      {form.triggerType === t.value && (
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {form.triggerType === 'on_event' && (
                <Card className="border-dashed">
                  <CardContent className="p-4 space-y-2">
                    <Label className="text-sm">Event Name</Label>
                    <Input
                      value={form.triggerEvent}
                      onChange={(e) => setForm({ ...form, triggerEvent: e.target.value })}
                      placeholder="e.g. purchase_completed"
                      className="h-9"
                    />
                  </CardContent>
                </Card>
              )}

              {form.triggerType === 'on_screen' && (
                <Card className="border-dashed">
                  <CardContent className="p-4 space-y-2">
                    <Label className="text-sm">Screen Name</Label>
                    <Input
                      value={form.triggerScreen}
                      onChange={(e) => setForm({ ...form, triggerScreen: e.target.value })}
                      placeholder="e.g. home, product_detail"
                      className="h-9"
                    />
                  </CardContent>
                </Card>
              )}

              <Card className="border-dashed">
                <CardContent className="p-4 space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Delay before showing (seconds)</Label>
                    <Input
                      type="number"
                      value={form.triggerDelaySeconds}
                      onChange={(e) => setForm({ ...form, triggerDelaySeconds: parseInt(e.target.value, 10) || 0 })}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Priority</Label>
                    <Input
                      type="number"
                      value={form.priority}
                      onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value, 10) || 0 })}
                      className="h-9"
                    />
                    <p className="text-[11px] text-muted-foreground">Higher = shown first when multiple messages match</p>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {/* ── Step 3: Users ── */}
          {step === 'users' && (
            <>
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Target Users</Label>
                <div className="space-y-1.5">
                  {USER_TYPES.map((a) => (
                    <button
                      key={a.value}
                      onClick={() => setForm({ ...form, userType: a.value })}
                      className={`w-full flex items-center justify-between rounded-lg border-2 px-4 py-3 text-left transition-all ${
                        form.userType === a.value
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-transparent bg-muted/40 hover:bg-muted/70'
                      }`}
                    >
                      <p className="text-sm font-medium">{a.label}</p>
                      {form.userType === a.value && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </button>
                  ))}
                </div>
              </div>

              {form.userType === 'cohort' && (
                <Card className="border-dashed">
                  <CardContent className="p-4 space-y-2">
                    <Label className="text-sm">Mixpanel Cohort ID</Label>
                    <Input
                      value={form.mixpanelCohortId}
                      onChange={(e) => setForm({ ...form, mixpanelCohortId: e.target.value })}
                      placeholder="Paste cohort ID"
                      className="h-9"
                    />
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* ── Step 4: Schedule & Limits ── */}
          {step === 'schedule' && (
            <>
              <Card className="border-dashed">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm">Schedule Window</CardTitle>
                  <CardDescription className="text-xs">Optionally restrict when this message is shown</CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Start Date</Label>
                      <Input
                        type="datetime-local"
                        value={form.startsAt ? form.startsAt.slice(0, 16) : ''}
                        onChange={(e) => setForm({ ...form, startsAt: e.target.value ? new Date(e.target.value).toISOString() : '' })}
                        className="h-9 text-xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">End Date</Label>
                      <Input
                        type="datetime-local"
                        value={form.endsAt ? form.endsAt.slice(0, 16) : ''}
                        onChange={(e) => setForm({ ...form, endsAt: e.target.value ? new Date(e.target.value).toISOString() : '' })}
                        className="h-9 text-xs"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-dashed">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm">Frequency Caps</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Max shows per user</Label>
                      <Input
                        type="number"
                        value={form.maxImpressionsPerUser ?? ''}
                        onChange={(e) => setForm({ ...form, maxImpressionsPerUser: e.target.value ? parseInt(e.target.value, 10) : null })}
                        placeholder="Unlimited"
                        className="h-9 text-xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Min interval (seconds)</Label>
                      <Input
                        type="number"
                        value={form.minIntervalSeconds ?? ''}
                        onChange={(e) => setForm({ ...form, minIntervalSeconds: e.target.value ? parseInt(e.target.value, 10) : null })}
                        placeholder="No limit"
                        className="h-9 text-xs"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-dashed">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-sm">Tags</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <Input
                    value={form.tags.join(', ')}
                    onChange={(e) => setForm({ ...form, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                    placeholder="onboarding, promo, seasonal"
                    className="h-9 text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">Comma-separated for organization</p>
                </CardContent>
              </Card>
            </>
          )}

          {/* ── Step Navigation ─── */}
          <div className="flex items-center justify-between pt-2 pb-4">
            <Button
              variant="outline"
              size="sm"
              disabled={currentStepIdx === 0}
              onClick={() => setStep(STEPS[currentStepIdx - 1].key)}
            >
              ← Previous
            </Button>
            {currentStepIdx < STEPS.length - 1 ? (
              <Button
                size="sm"
                onClick={() => setStep(STEPS[currentStepIdx + 1].key)}
              >
                Next →
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {isSaving ? 'Saving...' : 'Save Campaign'}
              </Button>
            )}
          </div>
        </div>

        {/* Right: Live Preview Panel */}
        <div className="w-[340px] shrink-0 border-l bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 flex flex-col items-center justify-center">
          <div className="sticky top-0 w-full text-center pt-3 pb-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Live Preview</p>
          </div>
          <div className="flex-1 flex items-center justify-center pb-8">
            <PhonePreview form={form} />
          </div>
        </div>
      </div>

      <Dialog
        open={pendingPreset !== null}
        onOpenChange={(open) => { if (!open) setPendingPreset(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Replace what you&rsquo;ve written?</DialogTitle>
            <DialogDescription>
              Applying &ldquo;{pendingPreset?.name}&rdquo; overwrites the
              layout, title, body, image and buttons of this message. The
              name, trigger, audience and schedule are left as they are.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingPreset(null)}>
              Keep what I have
            </Button>
            <Button
              onClick={() => {
                if (pendingPreset) applyPreset(pendingPreset);
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
