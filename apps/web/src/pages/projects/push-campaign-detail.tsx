import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarClock, Clock, Loader2, CheckCircle2, XCircle,
  AlertTriangle, Ban, BellOff, ExternalLink, Eye, EyeOff, MousePointerClick,
  CheckCheck, Percent, Server, Globe, Layers, Smartphone, FlaskConical,
  Trophy, Users, Mail, MailX, MessageCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useCampaign,
  useCampaignReport,
  useCancelScheduledPush,
  useExperimentReport,
  type NotificationStatus,
  type PushRecurrence,
} from '@/hooks/use-push-notifications';
import { useSegments } from '@/hooks/use-segments';
import { toast } from '@/components/ui/use-toast';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

// Kept local rather than imported from the list page: that file owns its own
// visual language and is free to change it without breaking this one.
const statusConfig: Record<
  NotificationStatus,
  { icon: typeof CalendarClock; label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className: string }
> = {
  scheduled: { icon: CalendarClock, label: 'Scheduled', variant: 'outline', className: 'text-blue-600' },
  queued: { icon: Clock, label: 'Queued', variant: 'secondary', className: 'text-muted-foreground' },
  sending: { icon: Loader2, label: 'Sending', variant: 'secondary', className: 'text-blue-600 animate-spin' },
  sent: { icon: CheckCircle2, label: 'Sent', variant: 'default', className: 'text-green-600' },
  failed: { icon: XCircle, label: 'Failed', variant: 'destructive', className: 'text-red-600' },
  partial: { icon: AlertTriangle, label: 'Partial', variant: 'outline', className: 'text-yellow-600' },
  expanded: { icon: CalendarClock, label: 'By timezone', variant: 'outline' as const, className: 'text-blue-600' },
  cancelled: { icon: Ban, label: 'Cancelled', variant: 'secondary', className: 'text-muted-foreground' },
};

/** Fallback glosses, keyed by FCM/googleapis status code, used only when a
 * failure's own JSON envelope didn't carry a human message. A code missing
 * from this map is still shown as-is — this is decoration, not the source of
 * truth. */
const FCM_ERROR_LABELS: Record<string, string> = {
  UNREGISTERED: 'Token no longer valid — app was uninstalled or the token expired',
  NOT_FOUND: 'Token no longer valid — app was uninstalled or the token expired',
  INVALID_ARGUMENT: 'Malformed request or invalid token format',
  SENDER_ID_MISMATCH: 'Token belongs to a different Firebase project',
  QUOTA_EXCEEDED: 'Rate limited by Firebase',
  UNAVAILABLE: 'Firebase Cloud Messaging was temporarily unavailable',
  INTERNAL: 'Internal error at Firebase',
  THIRD_PARTY_AUTH_ERROR: 'APNs certificate or key was rejected',
  UNAUTHENTICATED: 'The stored service account credentials were rejected',
  PERMISSION_DENIED: 'The service account does not have permission to send',
};

/**
 * Turns one persisted failure's `error` string into a code + message pair.
 *
 * `PushCampaignProcessor` stores the raw `FCM error <status>: <response
 * body>` string (see FcmProvider), where the body is FCM v1's JSON error
 * envelope — a `details[].errorCode` (e.g. `UNREGISTERED`) when FCM supplies
 * one, else a googleapis `error.status` (e.g. `NOT_FOUND`). Older or
 * synthetic data (tests, the seed script) may just be a bare code instead;
 * that isn't JSON, so it falls through and is shown as-is.
 */
function describeFailure(raw: string): { code: string; message?: string } {
  const match = raw.match(/^FCM error \d+: (.*)$/s);
  if (!match) return { code: raw };
  try {
    const parsed = JSON.parse(match[1]);
    const details = parsed?.error?.details;
    let code: string | undefined;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (typeof detail?.errorCode === 'string') {
          code = detail.errorCode;
          break;
        }
      }
    }
    code ??= typeof parsed?.error?.status === 'string' ? parsed.error.status : undefined;
    const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined;
    return code ? { code, message } : { code: raw };
  } catch {
    return { code: raw };
  }
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Renders a recurrence rule as one sentence a marketer reads at a glance
 * ("Every 2 weeks on Mon, Thu at 09:00 UTC, until Nov 3, 2026") rather than
 * exposing the underlying frequency/interval/atTime fields as-is.
 */
function formatRecurrence(recurrence: PushRecurrence): string {
  const { frequency, interval, atTime, daysOfWeek, timezone, endsAt } = recurrence;
  const unit = frequency === 'daily' ? 'day' : frequency === 'weekly' ? 'week' : 'month';
  let sentence = interval > 1 ? `Every ${interval} ${unit}s` : `Every ${unit}`;

  if (frequency === 'weekly' && daysOfWeek && daysOfWeek.length > 0) {
    const days = [...daysOfWeek].sort((a, b) => a - b).map((day) => WEEKDAY_LABELS[day]).join(', ');
    sentence += ` on ${days}`;
  }

  sentence += ` at ${atTime} ${timezone ?? 'UTC'}`;
  // `endsAt: null` is a real, common case — "runs until cancelled" — not a
  // missing value, so it earns its own clause instead of being dropped.
  sentence += endsAt ? `, until ${format(new Date(endsAt), 'MMM d, yyyy')}` : ', until cancelled';
  return sentence;
}

export default function PushCampaignDetailPage() {
  const { projectId, campaignId } = useParams<{ projectId: string; campaignId: string }>();
  const backToList = `/projects/${projectId}/push-notifications`;
  const [showCancel, setShowCancel] = useState(false);

  // Fetched by id rather than found in the paginated list: at the list's
  // default limit of 50, any older campaign rendered as "not found" despite
  // existing, and this page held the whole list to show one row.
  const { data: campaign, isLoading: logsLoading } = useCampaign(
    projectId,
    campaignId,
  );

  const campaignReport = useCampaignReport(projectId, campaignId ?? null);
  const experimentReport = useExperimentReport(projectId, campaignId);
  const { data: segments, isLoading: segmentsLoading } = useSegments(projectId);
  const cancelScheduled = useCancelScheduledPush(projectId!);

  const failureGroups = useMemo(() => {
    const groups = new Map<string, { count: number; message?: string }>();
    for (const failure of campaign?.failureDetails ?? []) {
      const { code, message } = describeFailure(failure.error);
      const existing = groups.get(code);
      if (existing) existing.count += 1;
      else groups.set(code, { count: 1, message });
    }
    return [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [campaign?.failureDetails]);

  if (logsLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link to={backToList}>
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to campaigns
          </Link>
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <p className="text-sm">
              Campaign not found. It may have been deleted, or it may simply be
              older than the most recent campaigns shown on the list page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = statusConfig[campaign.status];
  const StatusIcon = status.icon;

  const isScheduledTiming = campaign.status === 'scheduled' && !!campaign.scheduledAt;
  const timingLabel = isScheduledTiming ? 'Scheduled for' : 'Sent';
  const timingDate = isScheduledTiming ? campaign.scheduledAt! : campaign.sentAt;

  const handleCancel = () => {
    cancelScheduled.mutate(campaign.id, {
      onSuccess: () => {
        toast({ title: 'Campaign cancelled' });
        setShowCancel(false);
      },
      onError: (err: any) => {
        toast({
          title: 'Error',
          description: err?.response?.data?.message ?? 'Could not cancel',
          variant: 'destructive',
        });
      },
    });
  };

  const report = campaignReport.data;
  // These four are raw counts, not a claim about the campaign's health — a
  // brand-new campaign genuinely has zero of everything until the SDK
  // reports back. Only when every one of them is still zero do we call that
  // out; a nonzero delivered count alongside 0 clicks is just "nobody has
  // tapped it yet", not an empty report.
  const engagementStillEmpty =
    !!report && report.delivered === 0 && report.impressions === 0 &&
    report.clicks === 0 && report.dismissed === 0;

  // Email and SMS campaigns share this page: same row, same report. What
  // differs is who reports engagement (the provider, not the app SDK) and
  // which numbers mean anything — an email cannot be dismissed, a push cannot
  // bounce, and a text reports only whether it reached the phone.
  const isEmail = campaign.channel === 'email';
  const isSms = campaign.channel === 'sms';
  const isWhatsApp = campaign.channel === 'whatsapp';
  const isAddressed = isSms || isWhatsApp;
  const providerName = isSms
    ? 'Twilio'
    : isWhatsApp
      ? 'your WhatsApp provider'
      : isEmail
        ? 'your email provider'
        : 'Firebase';
  const listPath = isEmail
    ? `/projects/${projectId}/email`
    : isSms
      ? `/projects/${projectId}/sms`
      : isWhatsApp
        ? `/projects/${projectId}/whatsapp`
        : backToList;
  const engagementCards: Array<{ label: string; value: number | undefined; icon: typeof Eye }> = isWhatsApp
    ? [
        { label: 'Delivered', value: report?.delivered, icon: CheckCheck },
        { label: 'Read', value: report?.impressions, icon: Eye },
        { label: 'Failed', value: report?.bounced, icon: XCircle },
      ]
    : isSms
    ? [
        { label: 'Delivered', value: report?.delivered, icon: CheckCheck },
        { label: 'Undelivered', value: report?.bounced, icon: XCircle },
      ]
    : isEmail
    ? [
        { label: 'Delivered', value: report?.delivered, icon: CheckCheck },
        { label: 'Opened', value: report?.impressions, icon: Eye },
        { label: 'Clicks', value: report?.clicks, icon: MousePointerClick },
        { label: 'Bounced', value: report?.bounced, icon: MailX },
      ]
    : [
        { label: 'Delivered', value: report?.delivered, icon: CheckCheck },
        { label: 'Impressions', value: report?.impressions, icon: Eye },
        { label: 'Clicks', value: report?.clicks, icon: MousePointerClick },
        { label: 'Dismissed', value: report?.dismissed, icon: EyeOff },
      ];

  const segmentName = campaign.targetType === 'segment' && campaign.segmentId
    ? segments?.find((s) => s.id === campaign.segmentId)?.name
    : undefined;

  const experiment = experimentReport.data;

  const deliveryOptions = campaign.deliveryOptions;
  const hasAndroidDeliveryOptions = !!deliveryOptions?.android?.channelId || !!deliveryOptions?.android?.sound;
  const hasIosDeliveryOptions =
    !!deliveryOptions?.ios?.sound || deliveryOptions?.ios?.badge != null || !!deliveryOptions?.ios?.threadId;
  // Omitting the whole object means FCM's own defaults were used; a null
  // object is not the same claim as a set of deliberately-chosen defaults,
  // so this only turns on when at least one concrete key is present.
  const hasDeliveryOptions =
    !!deliveryOptions?.priority || deliveryOptions?.ttlSeconds != null || !!deliveryOptions?.collapseKey ||
    hasAndroidDeliveryOptions || hasIosDeliveryOptions;

  const hasActions = (campaign.actions?.length ?? 0) > 0 || !!campaign.iosCategory;
  const translationEntries = campaign.translations ? Object.entries(campaign.translations) : [];
  const hasTranslations = translationEntries.length > 0;

  // An optimised send has no single local time to show — displaying the
  // configured `localSendTime` here would claim a fixed hour that was never
  // actually used, since the real hour is chosen per recipient.
  const sendTimingNote = campaign.sendTimeOptimised
    ? "Each recipient's send hour was chosen from their own past click activity and delivered on their own clock — there is no single fixed local time."
    : campaign.deliverInRecipientTimezone && campaign.localSendTime
      ? `Delivered at ${campaign.localSendTime} on each recipient's own clock, not one fixed instant.`
      : null;

  const hasConfiguration =
    !!campaign.recurrence || hasActions || hasTranslations || hasDeliveryOptions || !!sendTimingNote;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to={listPath}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold">{campaign.title}</h1>
              {isEmail && (
                <Badge variant="outline">
                  <Mail className="mr-1 h-3 w-3" /> Email
                </Badge>
              )}
              {isSms && (
                <Badge variant="outline">
                  <Smartphone className="mr-1 h-3 w-3" /> SMS
                </Badge>
              )}
              {isWhatsApp && (
                <Badge variant="outline">
                  <MessageCircle className="mr-1 h-3 w-3" /> WhatsApp
                </Badge>
              )}
              <Badge variant={status.variant}>
                <StatusIcon className={`mr-1 h-3 w-3 ${status.className}`} />
                {status.label}
              </Badge>
              {campaign.silent && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline">
                      <BellOff className="mr-1 h-3 w-3" /> Silent
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Data-only push — nothing was shown to the user directly;
                    the app handled it in the background.
                  </TooltipContent>
                </Tooltip>
              )}
              {campaign.variantKey && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {campaign.parentCampaignId ? (
                      <Link to={`/projects/${projectId}/push-notifications/${campaign.parentCampaignId}`}>
                        <Badge variant="outline">
                          <FlaskConical className="mr-1 h-3 w-3" /> Variant {campaign.variantKey}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge variant="outline">
                        <FlaskConical className="mr-1 h-3 w-3" /> Variant {campaign.variantKey}
                      </Badge>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    One arm of an A/B experiment{campaign.parentCampaignId && ' — click to open the parent campaign'}.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {timingLabel} {format(new Date(timingDate), 'MMM d, yyyy HH:mm')}
              {campaign.completedAt && campaign.status !== 'scheduled' && (
                <> · completed {format(new Date(campaign.completedAt), 'MMM d, yyyy HH:mm')}</>
              )}
            </p>
            {campaign.deepLinkUrl && (
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <ExternalLink className="h-3 w-3" />
                Opens <span className="font-mono">{campaign.deepLinkUrl}</span>
              </p>
            )}
          </div>
        </div>

        {campaign.status === 'scheduled' && (
          <Button variant="outline" onClick={() => setShowCancel(true)}>
            <Ban className="mr-2 h-4 w-4" /> Cancel campaign
          </Button>
        )}
      </div>

      {campaign.errorMessage && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-2 pt-6 text-sm">
            <XCircle className="h-4 w-4 shrink-0 text-destructive" />
            {campaign.errorMessage}
          </CardContent>
        </Card>
      )}

      {isEmail && campaign.emailContent && (
        <Card>
          <CardHeader>
            <CardTitle>Email</CardTitle>
            <CardDescription>
              {campaign.emailContent.subject}
              {campaign.emailContent.preheader && <> — {campaign.emailContent.preheader}</>}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* No sandbox permissions: authored HTML must not run here. */}
            <iframe
              title="Email content"
              sandbox=""
              srcDoc={campaign.emailContent.html}
              className="h-96 w-full rounded-md border bg-white"
            />
          </CardContent>
        </Card>
      )}

      {isSms && campaign.body && (
        <Card>
          <CardHeader>
            <CardTitle>Text</CardTitle>
            <CardDescription>As written; personalised and given the opt-out line per person.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-w-md whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border bg-muted/40 px-3 py-2 text-sm">
              {campaign.body}
            </div>
          </CardContent>
        </Card>
      )}

      {isWhatsApp && campaign.whatsappContent && (
        <Card>
          <CardHeader>
            <CardTitle>Template</CardTitle>
            <CardDescription>
              {campaign.whatsappContent.template.name} · {campaign.whatsappContent.template.language}
              {campaign.whatsappContent.template.category && ` · ${campaign.whatsappContent.template.category.toLowerCase()}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {campaign.body && (
              <div className="max-w-md whitespace-pre-wrap break-words rounded-lg rounded-tl-none border bg-muted/40 px-3 py-2 text-sm">
                {campaign.body}
              </div>
            )}
            {campaign.whatsappContent.headerMediaUrl && (
              <p className="text-xs text-muted-foreground">Header: {campaign.whatsappContent.headerMediaUrl}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Engagement ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Engagement</CardTitle>
          <CardDescription>
            {isWhatsApp
              ? "Reported by your WhatsApp provider's webhook. Read needs the person's read receipts on."
              : isSms
              ? "Reported by Twilio's delivery callbacks. Texts have no opens or clicks to report."
              : isEmail
              ? 'Reported by your email provider through its delivery webhook.'
              : 'Reported by the Chumbaq SDK running in your app — not by Firebase.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {engagementCards.map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-lg border p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" /> {label}
                </div>
                {campaignReport.isLoading ? (
                  <Skeleton className="mt-1 h-8 w-12" />
                ) : (
                  <p className="mt-1 text-2xl font-semibold">{value ?? 0}</p>
                )}
              </div>
            ))}
            {!isAddressed && (
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Percent className="h-3.5 w-3.5" /> Click-through rate
              </div>
              {campaignReport.isLoading ? (
                <Skeleton className="mt-1 h-8 w-12" />
              ) : report?.clickThroughRate === null || report?.clickThroughRate === undefined ? (
                <p
                  className="mt-1 text-2xl font-semibold text-muted-foreground"
                  title="No delivery reported yet — the app SDK reports these"
                >
                  —
                </p>
              ) : (
                <p className="mt-1 text-2xl font-semibold">{report.clickThroughRate}%</p>
              )}
            </div>
            )}
          </div>
          {!campaignReport.isLoading && engagementStillEmpty && (
            <p className="mt-4 text-xs text-muted-foreground">
              {isAddressed
                ? `Nothing reported yet. ${providerName === 'Twilio' ? 'Twilio' : 'Your provider'} reports deliveries to this API, which it can only reach on a public URL.`
                : isEmail
                ? 'Nothing reported yet. Deliveries, opens and clicks come from your provider\'s webhook — check it is set up under Email settings.'
                : <>Nothing reported yet. Delivery, impressions and clicks are
              reported by the Chumbaq SDK in your app — if that isn&apos;t
              wired up, this stays empty even for a campaign that sent
              perfectly.</>}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Delivery ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Delivery</CardTitle>
          <CardDescription>
            {isWhatsApp
              ? 'Accepted is what your provider took from us; Delivered above is what WhatsApp confirmed reached the phone.'
              : isSms
              ? 'Accepted is what Twilio took from us; Delivered above is what the carrier confirmed reached the phone.'
              : isEmail
              ? 'Accepted is what your email provider took from us; Delivered above is what the receiving mail server confirmed.'
              : <>Accepted is what Firebase took from us; Delivered above is what a
            handset confirmed. A campaign can score full marks here and still
            reach nobody.</>}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Server className="h-3.5 w-3.5" /> {isSms ? 'Accepted by Twilio' : isEmail || isWhatsApp ? 'Accepted by provider' : 'Accepted by Firebase'}
              </div>
              <p className="mt-1 text-2xl font-semibold">
                {campaign.successCount} <span className="text-base font-normal text-muted-foreground">/ {campaign.totalTokens}</span>
              </p>
              {(campaign.status === 'queued' || campaign.status === 'sending') && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Still delivering — {campaign.processedTokens}/{campaign.totalTokens} processed so far.
                </p>
              )}
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Failed
              </div>
              <p className="mt-1 text-2xl font-semibold">{campaign.failureCount}</p>
            </div>
          </div>

          {failureGroups.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {failureGroups.map(([code, { count, message }]) => (
                  <Tooltip key={code}>
                    <TooltipTrigger asChild>
                      <Badge variant="destructive" className="font-mono">
                        {code} × {count}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      {message ?? FCM_ERROR_LABELS[code] ?? `Reported by ${providerName}`}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{isAddressed ? 'Number' : isEmail ? 'Address' : 'Token'}</TableHead>
                      <TableHead>{isSms ? 'Twilio error' : isEmail || isWhatsApp ? 'Provider error' : 'FCM error'}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaign.failureDetails!.map((failure, i) => {
                      const { code, message } = describeFailure(failure.error);
                      const gloss = message ?? FCM_ERROR_LABELS[code];
                      return (
                        <TableRow key={`${failure.token}-${i}`}>
                          <TableCell className="font-mono text-xs text-muted-foreground" title={failure.token}>
                            …{failure.token.slice(-10)}
                          </TableCell>
                          <TableCell className="text-xs" title={failure.error}>
                            <span className="font-mono">{code}</span>
                            {gloss && <span className="ml-2 text-muted-foreground">— {gloss}</span>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {campaign.failureCount > campaign.failureDetails!.length && (
                <p className="text-xs text-muted-foreground">
                  Showing {campaign.failureDetails!.length} of {campaign.failureCount} failures — the rest were not sampled.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Experiment results ───────────────────────────────────── */}
      {/* Only rendered for a campaign that was actually split into variants —
          an ordinary campaign's page is untouched by any of this. */}
      {experiment && experiment.isExperiment && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" /> Experiment results
            </CardTitle>
            <CardDescription>
              This campaign was split into variants sent to disjoint slices of
              the audience, so their engagement can be compared head-to-head.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* The verdict is the honest summary and is always present — it is
                the one thing on this card that must never be more confident
                than the data. Only decorate it as a win when the server named
                a leader; otherwise it stays neutral, even if one arm's CTR
                looks higher by eye. */}
            <div
              className={cn(
                'flex items-start gap-2 rounded-lg border p-4 text-sm font-medium',
                experiment.leader
                  ? 'border-green-600/30 bg-green-50 text-green-900 dark:bg-green-950/20 dark:text-green-300'
                  : 'bg-muted/40',
              )}
            >
              {experiment.leader ? (
                <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              ) : (
                <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              {experiment.verdict}
            </div>

            <div className="flex items-start gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
              <Users className="mt-0.5 h-4 w-4 shrink-0" />
              {experiment.controlSize > 0 ? (
                <span>
                  <span className="font-medium text-foreground">{experiment.controlSize}</span>{' '}
                  {experiment.controlSize === 1 ? 'person was' : 'people were'} held back as a
                  control group — sent nothing on purpose, so this campaign&apos;s effect can be
                  measured against them. Control has no click-through rate by definition, not a
                  failed one.
                </span>
              ) : (
                <span>No control group was held back for this experiment.</span>
              )}
            </div>

            {experiment.arms.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                The variant arms haven&apos;t been created yet.
              </div>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead className="text-right">Recipients</TableHead>
                      <TableHead className="text-right">Accepted</TableHead>
                      <TableHead className="text-right">Delivered</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">CTR</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {experiment.arms.map((arm) => {
                      const isLeader = experiment.leader === arm.variantKey;
                      return (
                        <TableRow
                          key={arm.campaignId}
                          className={isLeader ? 'bg-green-50 dark:bg-green-950/20' : undefined}
                        >
                          <TableCell>
                            <Link
                              to={`/projects/${projectId}/push-notifications/${arm.campaignId}`}
                              className="inline-flex items-center gap-1.5 font-medium hover:underline"
                            >
                              {arm.variantKey}
                              {isLeader && (
                                <Badge
                                  variant="outline"
                                  className="border-green-600/50 text-green-700 dark:text-green-400"
                                >
                                  <Trophy className="mr-1 h-3 w-3" /> Leading
                                </Badge>
                              )}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right">{arm.recipients}</TableCell>
                          <TableCell className="text-right">{arm.accepted}</TableCell>
                          <TableCell className="text-right">{arm.engagement.delivered}</TableCell>
                          <TableCell className="text-right">{arm.engagement.clicks}</TableCell>
                          <TableCell className="text-right">
                            {arm.engagement.clickThroughRate === null ? (
                              <span
                                className="text-muted-foreground"
                                title="No delivery reported yet — the app SDK reports these"
                              >
                                —
                              </span>
                            ) : (
                              `${arm.engagement.clickThroughRate}%`
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Configuration ────────────────────────────────────────── */}
      {/* How this campaign was set up. Most campaigns use none of these
          knobs, so each subsection is gated independently — a wall of
          "not set" rows would bury the ones that matter on the campaigns
          that do use them, and the whole card is skipped when none apply. */}
      {hasConfiguration && (
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>
              How this campaign was set up — for audit and reuse, not performance.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {campaign.recurrence && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Recurrence</p>
                <p className="text-sm">{formatRecurrence(campaign.recurrence)}</p>
              </div>
            )}

            {sendTimingNote && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Send timing</p>
                <p className="text-sm text-muted-foreground">{sendTimingNote}</p>
              </div>
            )}

            {hasActions && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Action buttons</p>
                {/* Android builds these locally from the payload; iOS can only
                    show buttons from a category the app registered at launch,
                    so that category name belongs right here, not off on its
                    own elsewhere on the page. */}
                <p className="text-xs text-muted-foreground">
                  Android renders these from the payload. iOS shows them only
                  if the app registered a category named{' '}
                  {campaign.iosCategory ? (
                    <span className="font-mono">{campaign.iosCategory}</span>
                  ) : (
                    'here — none was set, so iOS shows none of these'
                  )}
                  .
                </p>
                {campaign.actions && campaign.actions.length > 0 && (
                  <div className="divide-y rounded-lg border">
                    {campaign.actions.map((action) => (
                      <div key={action.id} className="flex items-center justify-between gap-4 p-3 text-sm">
                        <div>
                          <p className="font-medium">{action.title}</p>
                          <p className="font-mono text-xs text-muted-foreground">{action.id}</p>
                        </div>
                        {/* A button with no link of its own opens the
                            campaign's — that inheritance is worth stating
                            rather than leaving the cell blank. */}
                        <p className="text-right font-mono text-xs text-muted-foreground">
                          {action.deepLinkUrl ?? `${campaign.deepLinkUrl ?? "app's own default"} (default)`}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {hasTranslations && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Translations</p>
                {/* A language missing from this list isn't skipped — it just
                    falls through to the campaign's own title/body above. */}
                <p className="text-xs text-muted-foreground">
                  A language not listed here still gets this campaign&apos;s own title and body.
                </p>
                <div className="divide-y rounded-lg border">
                  {translationEntries.map(([lang, copy]) => (
                    <div key={lang} className="p-3 text-sm">
                      <p className="font-mono text-xs text-muted-foreground">{lang}</p>
                      {copy.title && <p className="font-medium">{copy.title}</p>}
                      {copy.body && <p className="text-muted-foreground">{copy.body}</p>}
                      {!copy.title && !copy.body && (
                        <p className="italic text-muted-foreground">No override for this language</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasDeliveryOptions && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Delivery options</p>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                  {deliveryOptions?.priority && (
                    <>
                      <dt className="text-muted-foreground">Priority</dt>
                      <dd>{deliveryOptions.priority}</dd>
                    </>
                  )}
                  {deliveryOptions?.ttlSeconds != null && (
                    <>
                      <dt className="text-muted-foreground">TTL</dt>
                      <dd>{deliveryOptions.ttlSeconds}s</dd>
                    </>
                  )}
                  {deliveryOptions?.collapseKey && (
                    <>
                      <dt className="text-muted-foreground">Collapse key</dt>
                      <dd className="font-mono">{deliveryOptions.collapseKey}</dd>
                    </>
                  )}
                  {deliveryOptions?.android?.channelId && (
                    <>
                      <dt className="text-muted-foreground">Android channel</dt>
                      <dd className="font-mono">{deliveryOptions.android.channelId}</dd>
                    </>
                  )}
                  {deliveryOptions?.android?.sound && (
                    <>
                      <dt className="text-muted-foreground">Android sound</dt>
                      <dd>{deliveryOptions.android.sound}</dd>
                    </>
                  )}
                  {deliveryOptions?.ios?.sound && (
                    <>
                      <dt className="text-muted-foreground">iOS sound</dt>
                      <dd>{deliveryOptions.ios.sound}</dd>
                    </>
                  )}
                  {deliveryOptions?.ios?.badge != null && (
                    <>
                      <dt className="text-muted-foreground">iOS badge</dt>
                      <dd>{deliveryOptions.ios.badge}</dd>
                    </>
                  )}
                  {deliveryOptions?.ios?.threadId && (
                    <>
                      <dt className="text-muted-foreground">iOS thread</dt>
                      <dd className="font-mono">{deliveryOptions.ios.threadId}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Audience ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Audience</CardTitle>
        </CardHeader>
        <CardContent>
          {campaign.targetType === 'segment' ? (
            <div className="flex items-center gap-2 text-sm">
              <Layers className="h-4 w-4 text-muted-foreground" />
              {segmentsLoading ? (
                <Skeleton className="h-4 w-32" />
              ) : segmentName ? (
                <span>
                  Segment <span className="font-medium">{segmentName}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  A segment that no longer exists (id {campaign.segmentId})
                </span>
              )}
            </div>
          ) : campaign.targetType === 'devices' ? (
            <div className="flex items-center gap-2 text-sm">
              <Smartphone className="h-4 w-4 text-muted-foreground" />
              <span>
                {campaign.targetDeviceIds?.length ?? campaign.totalTokens} specific device
                {(campaign.targetDeviceIds?.length ?? campaign.totalTokens) === 1 ? '' : 's'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <span>Everyone in this project</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCancel} onOpenChange={setShowCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this campaign?</DialogTitle>
            <DialogDescription>
              "{campaign.title}" is scheduled for{' '}
              {campaign.scheduledAt && format(new Date(campaign.scheduledAt), 'MMM d, yyyy HH:mm')}.
              Cancelling now means it will never be sent. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancel(false)}>
              Keep it scheduled
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelScheduled.isPending}>
              {cancelScheduled.isPending ? 'Cancelling…' : 'Cancel campaign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
