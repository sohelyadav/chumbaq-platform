import {
  PROJECT_ACTIVITY_GROUPS,
  type ProjectActivityAction,
  type ProjectActivityEntry,
  type ProjectActivityGroup,
} from '@chumbaq/shared';

/**
 * The Activity page's words: one plain sentence per log entry, and the page's filters as
 * they travel in the URL. Pure, so `activity-sentence.check.mjs` can hold every action.
 *
 * Sentences are built from the action, the actor and target labels stored at the time,
 * and the allow-listed `details` (`ACTIVITY_DETAIL_KEYS` in the API). A label may be
 * null (erasures, exports, objections, a push to one person carry none), so every
 * sentence reads without one. A push audience is a count of devices; email, SMS and
 * WhatsApp count people.
 */

export const STAFF_SENTENCE = 'Chumbaq support viewed this project (read-only)';

const CHANNEL_NAMES: Record<string, string> = { push: 'push', email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };

/** What `content.deleted` calls each kind. Segments are "Audiences" in the dashboard. */
const CONTENT_KINDS: Record<string, string> = {
  journey: 'journey',
  segment: 'audience',
  in_app_message: 'in-app message',
  banner: 'banner',
  banner_category: 'banner category',
  template: 'template',
  link: 'link',
  cohort: 'cohort',
};

/** What `link.changed` calls the link and variant fields it lists. */
const LINK_FIELD_NAMES: Record<string, string> = {
  longUrl: 'destination',
  isActive: 'active',
  expiresAt: 'expiry',
  title: 'name',
  name: 'name',
  tags: 'tags',
  iosUrl: 'iOS link',
  androidUrl: 'Android link',
  iosFallbackUrl: 'iOS fallback',
  androidFallbackUrl: 'Android fallback',
  ogTitle: 'preview title',
  ogDescription: 'preview description',
  ogImageUrl: 'preview image',
  deepLinkParams: 'deep link parameters',
  weight: 'weight',
};

/** ` (destination, active)`, or nothing when no field names were stored. */
function linkFields(details: Record<string, unknown>): string {
  const fields = Array.isArray(details.fields)
    ? details.fields.filter((x): x is string => typeof x === 'string').map((f) => LINK_FIELD_NAMES[f] ?? f)
    : [];
  return fields.length > 0 ? ` (${fields.join(', ')})` : '';
}

const CONSENT_NAMES: Record<string, string> = {
  emailOptIn: 'email',
  smsOptIn: 'SMS',
  whatsappOptIn: 'WhatsApp',
  pushOptIn: 'push',
};

function quoted(label: string): string {
  return `"${label}"`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function channelName(details: Record<string, unknown>): string | null {
  const channel = str(details.channel);
  return channel ? (CHANNEL_NAMES[channel] ?? channel) : null;
}

function withArticle(role: string): string {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `the push campaign "Diwali sale"`, `the email campaign`, `a campaign`. */
function campaignPhrase(details: Record<string, unknown>, label: string | null): string {
  const channel = channelName(details);
  const noun = channel ? `${channel} campaign` : 'campaign';
  return label ? `the ${noun} ${quoted(label)}` : `${withArticle(noun)}`;
}

function audience(details: Record<string, unknown>): string | null {
  const size = num(details.audienceSize);
  if (size === null) return null;
  return details.channel === 'push' ? count(size, 'device', 'devices') : count(size, 'person', 'people');
}

function consentChanges(details: Record<string, unknown>): string | null {
  const consents = details.consents;
  if (!consents || typeof consents !== 'object') return null;
  const parts: string[] = [];
  for (const [field, value] of Object.entries(consents as Record<string, unknown>)) {
    if (typeof value !== 'boolean') continue;
    if (field === 'doNotTrack') parts.push(value ? 'do not track on' : 'do not track off');
    else if (field === 'gdprConsent') parts.push(value ? 'gave GDPR consent' : 'withdrew GDPR consent');
    else {
      const name = CONSENT_NAMES[field] ?? field;
      parts.push(value ? `opted in to ${name}` : `opted out of ${name}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** What the actor did, without the actor. `null` for an action this page does not know. */
function predicate(e: ProjectActivityEntry): string | null {
  const d = e.details ?? {};
  const label = e.targetLabel;
  const action = e.action as ProjectActivityAction;
  switch (action) {
    // Team
    case 'member.invited': {
      const who = label ?? str(d.email) ?? 'someone';
      const role = str(d.role);
      return role ? `invited ${who} as ${withArticle(role)}` : `invited ${who}`;
    }
    case 'invite.resent':
      return label ? `resent the invite to ${label}` : 'resent an invite';
    case 'invite.cancelled':
      return label ? `cancelled the invite to ${label}` : 'cancelled an invite';
    case 'invite.accepted':
      return 'accepted an invite and joined the project';
    case 'member.role_changed': {
      const who = label ?? 'a member';
      const from = str(d.from);
      const to = str(d.to);
      return from && to ? `changed the role of ${who} from ${from} to ${to}` : `changed the role of ${who}`;
    }
    case 'member.removed':
      return `removed ${label ?? 'a member'} from the project`;
    case 'member.left':
      return 'left the project';
    case 'billing.transfer_offered':
      return label ? `offered billing for this project to ${label}` : 'offered billing for this project to another owner';
    case 'billing.transfer_accepted':
      return 'accepted billing for this project';
    case 'billing.transfer_declined':
      return 'declined billing for this project';
    case 'billing.transfer_cancelled':
      return label ? `cancelled the billing offer to ${label}` : 'cancelled a billing offer';
    // Project
    case 'project.renamed': {
      const from = str(d.from);
      const to = str(d.to);
      return from && to ? `renamed the project from ${quoted(from)} to ${quoted(to)}` : 'renamed the project';
    }
    case 'project.app_links_changed':
      return "changed the project's app link settings";
    case 'project.deleted':
      return label ? `deleted the project ${quoted(label)}` : 'deleted the project';
    // API keys
    case 'api_key.created':
      return label ? `created the API key ${quoted(label)}` : 'created an API key';
    case 'api_key.revoked':
      return label ? `revoked the API key ${quoted(label)}` : 'revoked an API key';
    // Channels
    case 'channel.settings_changed': {
      const channel = channelName(d);
      return channel ? `changed the ${channel} settings` : 'changed channel settings';
    }
    case 'channel.provider_changed': {
      const channel = channelName(d);
      const noun = channel ? `the ${channel} provider` : 'a channel provider';
      return label ? `switched ${noun} to ${label}` : `changed ${noun}`;
    }
    case 'channel.credentials_uploaded': {
      const channel = channelName(d);
      const noun = channel ? `the ${channel} credentials` : 'channel credentials';
      return label ? `updated ${noun} for ${label}` : `updated ${noun}`;
    }
    case 'email.ses_topic_reset':
      return 'cleared the Amazon SNS topic for email events';
    case 'email.webhook_token_rotated':
      return 'replaced the email event URLs';
    case 'webhook.created': {
      const events = Array.isArray(d.events) ? d.events.filter((x): x is string => typeof x === 'string') : [];
      return events.length > 0 ? `added a webhook for ${list(events)} events` : 'added a webhook';
    }
    case 'webhook.changed':
      return 'changed a webhook';
    case 'webhook.secret_rotated':
      return "replaced a webhook's signing secret";
    case 'webhook.deleted':
      return 'deleted a webhook';
    case 'mixpanel.configured':
      return 'changed the Mixpanel connection';
    // Messaging
    case 'campaign.sent': {
      const size = audience(d);
      return `sent ${campaignPhrase(d, label)}${size ? ` to ${size}` : ''}`;
    }
    case 'campaign.scheduled': {
      const size = audience(d);
      return `scheduled ${campaignPhrase(d, label)}${size ? ` for ${size}` : ''}`;
    }
    case 'campaign.cancelled': {
      const size = audience(d);
      return `cancelled ${campaignPhrase(d, label)}${size ? ` (${size})` : ''}`;
    }
    case 'push.sent_to_person':
      return 'sent a push to one person';
    case 'cohort.push_sent':
      return label ? `sent a push to the Mixpanel cohort ${quoted(label)}` : 'sent a push to a Mixpanel cohort';
    case 'cohort.in_app_triggered':
      return label
        ? `showed an in-app message to the Mixpanel cohort ${quoted(label)}`
        : 'showed an in-app message to a Mixpanel cohort';
    case 'in_app.triggered':
      return label ? `triggered the in-app message ${quoted(label)}` : 'triggered an in-app message';
    case 'journey.status_changed': {
      const journey = label ? `the journey ${quoted(label)}` : 'a journey';
      const from = str(d.from);
      const to = str(d.to);
      return from && to ? `changed ${journey} from ${from} to ${to}` : `changed the status of ${journey}`;
    }
    case 'in_app_message.activated':
      return label ? `activated the in-app message ${quoted(label)}` : 'activated an in-app message';
    case 'in_app_message.paused': {
      // `to` is set when a PATCH moved an active message to a status other than paused.
      const to = str(d.to);
      const now = to ? ` (now ${to})` : '';
      return label ? `paused the in-app message ${quoted(label)}${now}` : `paused an in-app message${now}`;
    }
    case 'link.changed': {
      const link = label ? `the short link ${quoted(label)}` : 'a short link';
      const variant = str(d.variant);
      if (!variant) return `changed ${link}${linkFields(d)}`;
      switch (str(d.change)) {
        case 'added':
          return `added the A/B variant ${quoted(variant)} to ${link}${linkFields(d)}`;
        case 'removed':
          return `removed the A/B variant ${quoted(variant)} from ${link}`;
        default:
          return `changed the A/B variant ${quoted(variant)} of ${link}${linkFields(d)}`;
      }
    }
    case 'content.deleted': {
      const kind = str(d.kind);
      const noun = kind ? (CONTENT_KINDS[kind] ?? 'item') : 'item';
      return label ? `deleted the ${noun} ${quoted(label)}` : `deleted ${withArticle(noun)}`;
    }
    // Privacy
    case 'person.erased':
      return "erased a person's data";
    case 'person.exported':
      return "exported a person's data";
    case 'person.consent_changed': {
      const changes = consentChanges(d);
      return changes ? `changed a person's consent: ${changes}` : "changed a person's consent";
    }
    case 'tracking.objection_recorded':
      return "recorded a person's objection to tracking";
    case 'tracking.objection_lifted':
      return "lifted a person's objection to tracking";
    case 'suppression.added': {
      const channel = channelName(d) ?? 'messages';
      return `stopped ${channel} to ${str(d.address) ?? 'an address'}`;
    }
    case 'suppression.removed': {
      const channel = channelName(d) ?? 'messages';
      return `allowed ${channel} to ${str(d.address) ?? 'an address'} again`;
    }
    // Activity
    case 'activity.exported': {
      const rows = num(d.rows);
      return rows === null ? 'downloaded the activity log' : `downloaded the activity log (${count(rows, 'entry', 'entries')})`;
    }
    case 'staff.viewed_as':
      return null; // handled before the switch
    default:
      return null;
  }
}

/**
 * The sentence for one entry, e.g. `Priya (priya@acme.com) sent the push campaign
 * "Diwali sale" to 12,400 devices`. Staff entries always read the same fixed sentence,
 * never a name. An action this build does not know reads `<actor> did <action>`.
 */
export function activitySentence(e: ProjectActivityEntry): string {
  if (e.actorKind === 'staff' || e.action === 'staff.viewed_as') return STAFF_SENTENCE;
  const what = predicate(e);
  return what ? `${e.actorLabel} ${what}` : `${e.actorLabel} did ${e.action}`;
}

// ─── Filters ───────────────────────────────────────────────────────────────────

export const ACTIVITY_GROUP_LABELS: Record<ProjectActivityGroup, string> = {
  team: 'Team',
  project: 'Project',
  api_keys: 'API keys',
  channels: 'Channels',
  messaging: 'Messaging',
  privacy: 'Privacy',
  activity: 'Activity log',
  staff: 'Chumbaq support',
};

/** The kind filter's choices. Privacy only for a role with `privacy` (owners); for others the API leaves privacy entries out, so the filter would only return an empty page. */
export function kindOptions(mayPrivacy: boolean): { value: ProjectActivityGroup; label: string }[] {
  return PROJECT_ACTIVITY_GROUPS.filter((g) => mayPrivacy || g !== 'privacy').map((g) => ({
    value: g,
    label: ACTIVITY_GROUP_LABELS[g],
  }));
}

export interface ActivityFilters {
  /** A user id from the page's `actors`. */
  actor?: string;
  group?: ProjectActivityGroup;
  /** `YYYY-MM-DD`, a UTC day, inclusive. */
  from?: string;
  /** `YYYY-MM-DD`, a UTC day, inclusive. */
  to?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The filters in the page's URL (`?person=&group=&from=&to=`). Anything malformed, or a
 * group this role may not pick, is dropped rather than sent for the API to refuse.
 */
export function readActivityFilters(params: URLSearchParams, mayPrivacy: boolean): ActivityFilters {
  const filters: ActivityFilters = {};
  const person = params.get('person');
  if (person) filters.actor = person;
  const group = params.get('group');
  if (group && kindOptions(mayPrivacy).some((o) => o.value === group)) filters.group = group as ProjectActivityGroup;
  const from = params.get('from');
  if (from && DAY.test(from)) filters.from = from;
  const to = params.get('to');
  if (to && DAY.test(to)) filters.to = to;
  return filters;
}

/** The API's query parameters for these filters, leaving out the empty ones. */
export function activityQueryParams(filters: ActivityFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.actor) params.actor = filters.actor;
  if (filters.group) params.group = filters.group;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  return params;
}
