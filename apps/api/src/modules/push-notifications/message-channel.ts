import { PushProvider } from '../push-tokens/entities/push-token.entity';

/**
 * The channels a campaign can be delivered on.
 *
 * Each channel needs a recipient source (who has a reachable address and
 * consent), a message shape, and providers — the campaign row, scheduler and
 * worker do not change.
 */
export const MESSAGE_CHANNELS = ['push', 'email', 'sms', 'whatsapp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/**
 * Email delivery services a project can bring its own account for.
 *
 * Chumbaq never sends from its own infrastructure: the customer's provider
 * owns domain reputation, bounces and warm-up, and Chumbaq owns who, when and
 * what.
 */
export const EMAIL_PROVIDERS = ['ses', 'resend', 'brevo'] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

/** SMS services a project can bring its own account for. */
export const SMS_PROVIDERS = ['twilio'] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

/**
 * WhatsApp Business providers a project can bring its own account for.
 *
 * `meta` is the Cloud API directly; the rest are Business Solution Providers
 * in front of it. `twilio_whatsapp` is stored apart from SMS's `twilio` so a
 * project can use different Twilio accounts or senders for each.
 */
export const WHATSAPP_PROVIDERS = ['meta', 'twilio_whatsapp', 'gupshup', 'interakt'] as const;
export type WhatsAppProviderName = (typeof WHATSAPP_PROVIDERS)[number];

/** How a messaging provider is named to people, in errors and the dashboard. */
export const PROVIDER_LABELS: Record<
  EmailProviderName | SmsProviderName | WhatsAppProviderName,
  string
> = {
  ses: 'Amazon SES',
  resend: 'Resend',
  brevo: 'Brevo',
  twilio: 'Twilio',
  meta: 'Meta',
  twilio_whatsapp: 'Twilio',
  gupshup: 'Gupshup',
  interakt: 'Interakt',
};

/** Any provider a credential can be stored for. */
export type ChannelProviderName =
  | PushProvider
  | EmailProviderName
  | SmsProviderName
  | WhatsAppProviderName;

/**
 * A WhatsApp campaign's message: an approved template and the values for
 * its placeholders.
 *
 * Business-initiated WhatsApp messages must be pre-approved templates, so a
 * campaign never carries free text. The template is referenced the way the
 * provider needs: by name for Meta and Interakt, by template id for Gupshup,
 * by Content SID for Twilio — `id` holds that, `name` is for people.
 */
export interface WhatsAppContent {
  template: {
    id: string;
    name: string;
    language: string;
    category?: string | null;
    /**
     * For a template written with named placeholders (`{{first_name}}`,
     * Meta's NAMED format): the names, in the order `bodyParams` follows.
     * Absent for numbered placeholders.
     */
    paramNames?: string[] | null;
  };
  /**
   * Values for the body's placeholders, in order ({{1}}, {{2}}, ...). Each
   * may itself use personalisation, `{{firstName|there}}`, filled per person.
   */
  bodyParams: string[];
  /** A text header's one placeholder value, when the template has one. */
  headerText?: string | null;
  /** Image, video or document for a media header, as a public URL. */
  headerMediaUrl?: string | null;
  /** What kind of media the template's header takes. */
  headerMediaType?: 'image' | 'video' | 'document' | null;
  /** Suffixes for dynamic URL buttons, in button order. */
  buttonParams?: string[];
  /** The approved body text, kept for previews and reports. */
  previewText?: string | null;
}

/** What an email campaign says, as authored. */
export interface EmailContent {
  subject: string;
  html: string;
  /** Plain-text part. Derived from the HTML at send time when absent. */
  text?: string | null;
  /** Inbox preview line, rendered as hidden text at the top of the HTML. */
  preheader?: string | null;
}

/**
 * Normalises an address for storage and comparison, or returns null when it
 * is not plausibly an address.
 *
 * Deliberately loose: the provider is the authority on deliverability and
 * reports a bounce for anything it cannot reach. This only has to reject
 * values that are obviously not addresses (a name typed into the email
 * trait), so they never become recipients.
 */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 320) return null;
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(trimmed)
    ? trimmed
    : null;
}

/**
 * Normalises a phone number to E.164 (`+` and 8–15 digits), or returns null.
 *
 * Only numbers that already carry a country code are accepted — written with
 * `+` or the international `00` prefix. A national number such as
 * `09876 543210` is ambiguous without knowing the country, and guessing one
 * would text a stranger, so it is left unreachable instead. Spaces, dashes,
 * dots and brackets are formatting and are dropped.
 */
export function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let compact = value.trim().replace(/[\s\-.()]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

/** The address a channel's suppressions and recipients are keyed on. */
export function normaliseAddress(channel: MessageChannel, value: unknown): string | null {
  if (channel === 'email') return normaliseEmail(value);
  if (channel === 'sms' || channel === 'whatsapp') return normalisePhone(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
