import { WhatsAppProviderName } from '../../push-notifications/message-channel';
import { DeliveryProvider } from '../../push-notifications/services/channel-provider';
import { WhatsAppMessage } from '../whatsapp-rendering';

/** An approved (or pending) template, in one shape whatever the provider. */
export interface WhatsAppTemplate {
  /** What a send references: name, template id or Content SID. */
  id: string;
  name: string;
  language: string;
  category: string | null;
  /** Upper-case, as Meta spells it: APPROVED, PENDING, REJECTED, PAUSED, ... */
  status: string;
  bodyText: string;
  /** How many placeholders the body has. */
  bodyParamCount: number;
  /** Placeholder names, in body order, for a template with named placeholders. */
  paramNames: string[] | null;
  header: {
    format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
    text: string | null;
    /** 0 or 1: a text header has at most one placeholder. */
    paramCount: number;
  } | null;
  buttons: Array<{
    type: string;
    text: string;
    /** A URL button whose URL ends in a placeholder the send must fill. */
    dynamic: boolean;
  }>;
}

/** One delivery report or inbound message, normalised across providers. */
export type WhatsAppEvent =
  | {
      kind: 'status';
      status: 'delivered' | 'read' | 'failed';
      address: string;
      campaignId: string | null;
      identityId: string | null;
      /** The provider's error code, for a failure. */
      errorCode?: string | null;
      detail?: string | null;
      occurredAt: Date;
    }
  | {
      kind: 'inbound';
      address: string;
      /** The text of the message, or a quick-reply button's text or payload. */
      text: string;
      occurredAt: Date;
    };

/** A request as a webhook receives it, for providers to authenticate. */
export interface WebhookRequest {
  /** The URL the provider called, rebuilt from the public base URL. */
  url: string;
  rawBody: string;
  body: unknown;
  query: Record<string, unknown>;
  header(name: string): string | undefined;
}

export interface WhatsAppProvider extends DeliveryProvider<WhatsAppMessage, WhatsAppProviderName> {
  /**
   * False for a provider with no API to list templates (Interakt): the
   * composer then takes the template's name, language and values by hand,
   * and nothing can be checked against the approved template before sending.
   */
  readonly canListTemplates: boolean;

  /** Templates the account has, approved or not; the composer filters. */
  listTemplates(credentials: unknown): Promise<WhatsAppTemplate[]>;

  /**
   * Whether a webhook request really came from the provider for this
   * account. Providers that do not sign their webhooks return
   * `'unsigned'`, and their events are then corroborated before they can
   * suppress anyone.
   */
  authenticateWebhook(
    credentials: unknown,
    request: WebhookRequest,
  ): boolean | 'unsigned';

  parseWebhook(request: WebhookRequest): WhatsAppEvent[];

  /**
   * Error codes meaning this person will not receive WhatsApp marketing from
   * this business — opted out, or not on WhatsApp at all — and so should be
   * suppressed rather than tried again next campaign.
   */
  readonly suppressingErrors: ReadonlyMap<string, 'unsubscribed' | 'bounced'>;

  /**
   * False when a send cannot carry Chumbaq's campaign and person through to
   * the delivery report (Gupshup). Reports are then attributed to the
   * person's most recent WhatsApp campaign.
   */
  readonly reportsCarryCampaign: boolean;
}

/** `{{first_name}}`-style names in order of first appearance, or null for numbered ones. */
export function placeholderNames(text: string | null | undefined): string[] | null {
  const names: string[] = [];
  for (const match of (text ?? '').matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names.length > 0 ? names : null;
}

/** `{{1}}`, `{{2}}` ... counted the way providers count them: the highest index. */
export function countPlaceholders(text: string | null | undefined): number {
  let highest = 0;
  for (const match of (text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}
