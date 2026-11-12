import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  normalisePhone,
  WhatsAppProviderName,
} from '../../push-notifications/message-channel';
import {
  AttemptResult,
  PerRecipientProvider,
  ProviderAccountError,
  readJson,
} from '../../push-notifications/services/per-recipient-provider';
import { WhatsAppMessage } from '../whatsapp-rendering';
import {
  countPlaceholders,
  placeholderNames,
  WebhookRequest,
  WhatsAppEvent,
  WhatsAppProvider,
  WhatsAppTemplate,
} from './whatsapp-provider';

export interface MetaCredentials {
  /** The sending number's id (not the number itself), from WhatsApp Manager / the app's API Setup. */
  phoneNumberId: string;
  /** The WhatsApp Business Account id, for listing templates. */
  businessAccountId: string;
  /** A system user access token with whatsapp_business_messaging and _management. */
  accessToken: string;
  /** The Meta app's secret, which signs webhooks. Optional, but without it events are unsigned. */
  appSecret?: string;
}

/** Pinned so a Graph API change is a deliberate edit, not a surprise. */
export const GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Error codes about the account, token, number or template — every
 * remaining recipient would fail the same way, so the page stops and the
 * campaign retries once it is fixed.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
const ACCOUNT_ERRORS = new Set([
  0, 3, 10, 190, 200, 368, // token, permissions, policy restriction
  131005, 131031, 131037, 131042, 131045, 131048, 131063, 133010, 130497, // account, number, payment
  132000, 132001, 132005, 132007, 132012, 132015, 132016, // the template or its parameters
]);

const RETRYABLE_ERRORS = new Set([
  4, 80007, 130429, // rate and throughput limits
  131056, // too many messages to one person in a short time
  131000, 131016, 131057, // unknown, unavailable, maintenance
]);

/**
 * The Meta WhatsApp Cloud API directly, one recipient per request.
 *
 * A number sends 80 messages a second by default; ten in flight stays well
 * under it even for a number that has not been upgraded.
 */
@Injectable()
export class MetaWhatsAppProvider
  extends PerRecipientProvider<WhatsAppMessage, WhatsAppProviderName>
  implements WhatsAppProvider
{
  readonly provider = 'meta' as const;
  readonly canListTemplates = true;
  readonly reportsCarryCampaign = true;
  protected readonly logger = new Logger(MetaWhatsAppProvider.name);
  protected readonly concurrency = 10;

  readonly suppressingErrors: ReadonlyMap<string, 'unsubscribed' | 'bounced'> = new Map([
    ['131050', 'unsubscribed'], // the person stopped marketing messages from this business
    ['130403', 'unsubscribed'], // the person blocked the business
    ['131026', 'bounced'], // not on WhatsApp, or cannot receive
  ]);

  protected parseCredentials(credentials: unknown): MetaCredentials {
    const value = credentials as Partial<MetaCredentials> | null;
    const phoneNumberId = String(value?.phoneNumberId ?? '').trim();
    const businessAccountId = String(value?.businessAccountId ?? '').trim();
    const accessToken = typeof value?.accessToken === 'string' ? value.accessToken.trim() : '';
    if (!/^\d{6,}$/.test(phoneNumberId)) {
      throw new BadRequestException(
        'The phone number ID is a long number shown under API Setup in your Meta app — not the phone number itself.',
      );
    }
    if (!/^\d{6,}$/.test(businessAccountId)) {
      throw new BadRequestException('The WhatsApp Business Account ID is a long number shown under API Setup.');
    }
    if (!accessToken || /\s/.test(accessToken)) {
      throw new BadRequestException('Paste a system user access token for the WhatsApp Business Account.');
    }
    const appSecret =
      typeof value?.appSecret === 'string' && value.appSecret.trim() ? value.appSecret.trim() : undefined;
    return { phoneNumberId, businessAccountId, accessToken, ...(appSecret ? { appSecret } : {}) };
  }

  /**
   * Reads the number and one template: the first proves the token can send
   * from this number, the second that it can see the account's templates.
   */
  async validateCredentials(credentials: unknown): Promise<void> {
    const parsed = this.parseCredentials(credentials);
    const headers = { authorization: `Bearer ${parsed.accessToken}` };

    const number = await this.request(
      `${GRAPH}/${parsed.phoneNumberId}?fields=id,display_phone_number,verified_name`,
      { headers },
    );
    if (!number.ok) {
      throw new BadRequestException(`Meta refused the phone number ID or token: ${describeGraph(await readJson(number))}`);
    }
    const templates = await this.request(
      `${GRAPH}/${parsed.businessAccountId}/message_templates?limit=1`,
      { headers },
    );
    if (!templates.ok) {
      throw new BadRequestException(
        `Meta refused the WhatsApp Business Account ID: ${describeGraph(await readJson(templates))}`,
      );
    }
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: WhatsAppMessage,
  ): Promise<AttemptResult> {
    const { phoneNumberId, accessToken } = credentials as MetaCredentials;

    const response = await this.request(`${GRAPH}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        // With the +: without it Meta assumes the business number's country.
        to,
        type: 'template',
        // Returned on this message's status webhooks (up to 512 characters).
        biz_opaque_callback_data: JSON.stringify({ c: message.campaignId, i: message.identityId }),
        template: {
          name: message.template.id,
          language: { code: message.template.language },
          components: components(message),
        },
      }),
    });
    if (response.ok) return { outcome: { kind: 'success' } };

    const body = await readJson(response);
    const graph = (body.error ?? {}) as { code?: number };
    const code = typeof graph.code === 'number' ? graph.code : undefined;
    const error = describeGraph(body);

    if (response.status === 401 || (code !== undefined && ACCOUNT_ERRORS.has(code))) {
      throw new ProviderAccountError(`Meta refused to send: ${error}`);
    }
    if (response.status === 429 || response.status >= 500 || (code !== undefined && RETRYABLE_ERRORS.has(code))) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    return {
      outcome: { kind: 'permanent', error, errorCode: code !== undefined ? String(code) : undefined },
    };
  }

  /** https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management */
  async listTemplates(credentials: unknown): Promise<WhatsAppTemplate[]> {
    const { businessAccountId, accessToken } = this.parseCredentials(credentials);
    const headers = { authorization: `Bearer ${accessToken}` };
    const templates: WhatsAppTemplate[] = [];
    let url: string | null =
      `${GRAPH}/${businessAccountId}/message_templates` +
      '?fields=id,name,language,status,category,components,parameter_format&limit=100';

    for (let page = 0; url && page < 20; page++) {
      const response: Response = await this.request(url, { headers });
      const body = await readJson(response);
      if (!response.ok) {
        throw new BadRequestException(`Meta would not list templates: ${describeGraph(body)}`);
      }
      for (const item of (body.data as Array<Record<string, unknown>>) ?? []) {
        templates.push(toTemplate(item));
      }
      const paging = body.paging as { next?: string } | undefined;
      url = paging?.next ?? null;
    }
    return templates;
  }

  /**
   * `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, keyed
   * with the app secret. Without an app secret stored, events are unsigned
   * and corroborated instead.
   */
  authenticateWebhook(credentials: unknown, request: WebhookRequest): boolean | 'unsigned' {
    const secret = (credentials as Partial<MetaCredentials> | null)?.appSecret;
    if (typeof secret !== 'string' || !secret) return 'unsigned';
    const given = request.header('x-hub-signature-256') ?? '';
    const expected = `sha256=${createHmac('sha256', secret).update(request.rawBody, 'utf8').digest('hex')}`;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Statuses, replies, and `user_preferences` marketing stop/resume, all
   * under `entry[].changes[].value`.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status
   */
  parseWebhook(request: WebhookRequest): WhatsAppEvent[] {
    const body = (request.body ?? {}) as { entry?: Array<{ changes?: Array<{ value?: MetaValue }> }> };
    const events: WhatsAppEvent[] = [];
    const toE164 = (value: unknown) =>
      normalisePhone(typeof value === 'string' && value ? `+${value.replace(/^\+/, '')}` : '');
    const at = (seconds: unknown) => {
      const date = new Date(Number(seconds) * 1000);
      return Number.isNaN(date.getTime()) ? new Date() : date;
    };

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        for (const status of value.statuses ?? []) {
          const address = toE164(status.recipient_id);
          const mapped =
            status.status === 'delivered' ? 'delivered'
            : status.status === 'read' ? 'read'
            : status.status === 'failed' ? 'failed'
            : null;
          if (!address || !mapped) continue;
          const { campaignId, identityId } = parseOpaque(status.biz_opaque_callback_data);
          const error = status.errors?.[0];
          events.push({
            kind: 'status',
            status: mapped,
            address,
            campaignId,
            identityId,
            errorCode: error?.code != null ? String(error.code) : null,
            detail: error ? String(error.error_data?.details ?? error.title ?? error.message ?? '') : null,
            occurredAt: at(status.timestamp),
          });
        }

        for (const message of value.messages ?? []) {
          const address = toE164(message.from);
          const text =
            message.text?.body ??
            message.button?.text ??
            message.button?.payload ??
            message.interactive?.button_reply?.title ??
            '';
          if (address && text.trim()) {
            events.push({ kind: 'inbound', address, text, occurredAt: at(message.timestamp) });
          }
        }

        // The person used WhatsApp's own "stop marketing" control.
        for (const preference of value.user_preferences ?? []) {
          if (preference.category !== 'marketing_messages') continue;
          const address = toE164(preference.wa_id);
          if (!address) continue;
          const text = preference.value === 'stop' ? 'STOP' : preference.value === 'resume' ? 'START' : '';
          if (text) events.push({ kind: 'inbound', address, text, occurredAt: at(preference.timestamp) });
        }
      }
    }
    return events;
  }
}

interface MetaValue {
  statuses?: Array<{
    status?: string;
    recipient_id?: string;
    timestamp?: string;
    biz_opaque_callback_data?: string;
    errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
  }>;
  messages?: Array<{
    from?: string;
    timestamp?: string;
    text?: { body?: string };
    button?: { text?: string; payload?: string };
    interactive?: { button_reply?: { title?: string } };
  }>;
  user_preferences?: Array<{ wa_id?: string; category?: string; value?: string; timestamp?: string }>;
}

function components(message: WhatsAppMessage): unknown[] {
  const list: unknown[] = [];
  if (message.headerMediaUrl && message.headerMediaType) {
    list.push({
      type: 'header',
      parameters: [{ type: message.headerMediaType, [message.headerMediaType]: { link: message.headerMediaUrl } }],
    });
  } else if (message.headerText) {
    list.push({ type: 'header', parameters: [{ type: 'text', text: message.headerText }] });
  }
  if (message.bodyParams.length > 0) {
    const names = message.template.paramNames;
    list.push({
      type: 'body',
      parameters: message.bodyParams.map((text, index) =>
        names?.[index]
          ? { type: 'text', parameter_name: names[index], text }
          : { type: 'text', text },
      ),
    });
  }
  message.buttonParams.forEach((text, index) => {
    list.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text }] });
  });
  return list;
}

function toTemplate(item: Record<string, unknown>): WhatsAppTemplate {
  const parts = (item.components as Array<Record<string, unknown>>) ?? [];
  const body = parts.find((part) => part.type === 'BODY');
  const header = parts.find((part) => part.type === 'HEADER');
  const buttons = (parts.find((part) => part.type === 'BUTTONS')?.buttons as Array<Record<string, unknown>>) ?? [];
  const bodyText = typeof body?.text === 'string' ? body.text : '';
  const named = item.parameter_format === 'NAMED' ? placeholderNames(bodyText) : null;
  const headerText = typeof header?.text === 'string' ? header.text : null;
  const format = typeof header?.format === 'string' ? header.format.toUpperCase() : null;

  return {
    id: String(item.name ?? ''),
    name: String(item.name ?? ''),
    language: String(item.language ?? 'en_US'),
    category: typeof item.category === 'string' ? item.category.toUpperCase() : null,
    status: String(item.status ?? '').toUpperCase(),
    bodyText,
    paramNames: named,
    bodyParamCount: named ? named.length : countPlaceholders(bodyText),
    header: format
      ? {
          format: (format === 'GIF' ? 'VIDEO' : format) as 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION',
          text: headerText,
          paramCount: format === 'TEXT' ? Math.min(1, countPlaceholders(headerText) || (placeholderNames(headerText)?.length ?? 0)) : 0,
        }
      : null,
    buttons: buttons.map((button) => ({
      type: String(button.type ?? ''),
      text: String(button.text ?? ''),
      dynamic: button.type === 'URL' && /\{\{.+\}\}/.test(String(button.url ?? '')),
    })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOpaque(value: unknown): { campaignId: string | null; identityId: string | null } {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null;
    return {
      campaignId: typeof parsed?.c === 'string' && UUID.test(parsed.c) ? parsed.c : null,
      identityId: typeof parsed?.i === 'string' && UUID.test(parsed.i) ? parsed.i : null,
    };
  } catch {
    return { campaignId: null, identityId: null };
  }
}

function describeGraph(body: Record<string, unknown>): string {
  const error = (body.error ?? {}) as { code?: number; message?: string; error_data?: { details?: string } };
  const details = error.error_data?.details ? ` — ${error.error_data.details}` : '';
  return `${error.code ?? ''} ${error.message ?? String(body.message ?? 'Unknown error')}${details}`.trim();
}
