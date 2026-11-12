import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
  WebhookRequest,
  WhatsAppEvent,
  WhatsAppProvider,
  WhatsAppTemplate,
} from './whatsapp-provider';

export interface GupshupCredentials {
  /** The account's API key, from the Gupshup dashboard. */
  apiKey: string;
  /** The app's name (`src.name`). */
  appName: string;
  /** The app's id, for the template list. */
  appId: string;
  /** The app's WhatsApp number, `+E164`. */
  sourceNumber: string;
}

const API = 'https://api.gupshup.io';

/**
 * Gupshup's self-serve WhatsApp API (`/wa/api/v1/template/msg`), one
 * recipient per request.
 * https://docs.gupshup.io/docs/template-messages
 *
 * Gupshup accepts a send and reports its fate later: a send answers
 * `submitted`, and a bad number, an opted-out user or a template mismatch
 * arrive as `failed` message events. So most per-recipient failures land in
 * the webhook, not here.
 */
@Injectable()
export class GupshupProvider
  extends PerRecipientProvider<WhatsAppMessage, WhatsAppProviderName>
  implements WhatsAppProvider
{
  readonly provider = 'gupshup' as const;
  readonly reportsCarryCampaign = false;
  readonly canListTemplates = true;
  protected readonly logger = new Logger(GupshupProvider.name);
  protected readonly concurrency = 8;

  /** https://docs.gupshup.io/docs/error-and-status-messages */
  readonly suppressingErrors: ReadonlyMap<string, 'unsubscribed' | 'bounced'> = new Map([
    ['1002', 'bounced'], // number not on WhatsApp
    ['1012', 'unsubscribed'], // user opted out
    ['131026', 'bounced'], // Meta, passed through: undeliverable
    ['131050', 'unsubscribed'], // Meta, passed through: stopped marketing messages
  ]);

  protected parseCredentials(credentials: unknown): GupshupCredentials {
    const value = credentials as Partial<GupshupCredentials> | null;
    const apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
    const appName = typeof value?.appName === 'string' ? value.appName.trim() : '';
    const appId = typeof value?.appId === 'string' ? value.appId.trim() : '';
    const sourceNumber = normalisePhone(value?.sourceNumber);
    if (!apiKey) throw new BadRequestException('Paste your Gupshup API key.');
    if (!/^[A-Za-z0-9]{6,}$/.test(appName)) {
      throw new BadRequestException('The Gupshup app name is the one shown on your app (letters and digits, at least 6).');
    }
    if (!/^[0-9a-fA-F-]{8,}$/.test(appId)) {
      throw new BadRequestException('The Gupshup app id is shown on the app overview page.');
    }
    if (!sourceNumber) {
      throw new BadRequestException("The source number is your app's WhatsApp number with its country code: +919876543210.");
    }
    return { apiKey, appName, appId, sourceNumber };
  }

  /** The template list doubles as the check: it needs a good key and the right app id. */
  async validateCredentials(credentials: unknown): Promise<void> {
    const parsed = this.parseCredentials(credentials);
    const response = await this.request(
      `${API}/wa/app/${encodeURIComponent(parsed.appId)}/template?pageSize=1`,
      { headers: { apikey: parsed.apiKey } },
    );
    if (response.ok) return;
    const body = await readJson(response);
    throw new BadRequestException(
      response.status === 401
        ? 'Gupshup rejected this API key.'
        : `Gupshup refused these details: ${response.status} ${String(body.message ?? '')}`.trim(),
    );
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: WhatsAppMessage,
  ): Promise<AttemptResult> {
    const { apiKey, appName, sourceNumber } = credentials as GupshupCredentials;

    const form = new URLSearchParams({
      channel: 'whatsapp',
      source: sourceNumber.replace(/^\+/, ''),
      destination: to.replace(/^\+/, ''),
      'src.name': appName,
      template: JSON.stringify({
        id: message.template.id,
        params: message.headerText ? [message.headerText, ...message.bodyParams] : message.bodyParams,
      }),
    });
    const media = mediaMessage(message.headerMediaUrl, message.headerMediaType);
    if (media) form.set('message', JSON.stringify(media));

    const response = await this.request(`${API}/wa/api/v1/template/msg`, {
      method: 'POST',
      headers: { apikey: apiKey, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body = await readJson(response);
    if (response.ok && body.status !== 'error') return { outcome: { kind: 'success' } };

    const error = `${response.status} ${String(body.message ?? '')}`.trim();
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAccountError(`Gupshup rejected this API key: ${error}`);
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    if (/wallet|balance/i.test(error)) {
      throw new ProviderAccountError(`Gupshup cannot send from this account: ${error}`);
    }
    return { outcome: { kind: 'permanent', error } };
  }

  /** https://docs.gupshup.io/reference/get-all-templates-for-an-app */
  async listTemplates(credentials: unknown): Promise<WhatsAppTemplate[]> {
    const { apiKey, appId } = this.parseCredentials(credentials);
    const templates: WhatsAppTemplate[] = [];
    const pageSize = 100;
    for (let pageNo = 0; pageNo < 20; pageNo++) {
      const response = await this.request(
        `${API}/wa/app/${encodeURIComponent(appId)}/template?pageNo=${pageNo}&pageSize=${pageSize}`,
        { headers: { apikey: apiKey } },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new BadRequestException(`Gupshup would not list templates: ${response.status} ${String(body.message ?? '')}`);
      }
      const page = (body.templates as Array<Record<string, unknown>>) ?? [];
      templates.push(...page.map(toTemplate));
      if (page.length < pageSize) break;
    }
    return templates;
  }

  /**
   * Gupshup's self-serve callbacks carry no signature
   * (https://docs.gupshup.io/docs/what-is-a-webhook). The secret token in
   * the URL is the only proof, so its events are corroborated.
   */
  authenticateWebhook(): 'unsigned' {
    return 'unsigned';
  }

  /**
   * `message-event` delivery reports, `message` replies, and `user-event`
   * opt-outs, which become the same STOP / START a typed reply would.
   * https://docs.gupshup.io/docs/message-events
   */
  parseWebhook(request: WebhookRequest): WhatsAppEvent[] {
    const body = (request.body ?? {}) as {
      type?: string;
      timestamp?: number;
      payload?: {
        type?: string;
        destination?: string;
        phone?: string;
        source?: string;
        sender?: { phone?: string };
        payload?: { text?: string; title?: string; code?: string | number; reason?: string };
      };
    };
    const at = typeof body.timestamp === 'number' ? new Date(body.timestamp) : new Date();
    const occurredAt = Number.isNaN(at.getTime()) ? new Date() : at;
    const payload = body.payload ?? {};
    const toE164 = (value: unknown) =>
      normalisePhone(typeof value === 'string' && value ? `+${value.replace(/^\+/, '')}` : '');

    if (body.type === 'user-event') {
      const address = toE164(payload.phone);
      if (!address) return [];
      if (payload.type === 'opted-out') return [{ kind: 'inbound', address, text: 'STOP', occurredAt }];
      return [];
    }

    if (body.type === 'message') {
      const address = toE164(payload.sender?.phone ?? payload.source);
      const text = payload.payload?.text ?? payload.payload?.title ?? '';
      return address && text.trim() ? [{ kind: 'inbound', address, text, occurredAt }] : [];
    }

    if (body.type !== 'message-event') return [];
    const address = toE164(payload.destination);
    const status =
      payload.type === 'delivered' ? 'delivered'
      : payload.type === 'read' ? 'read'
      : payload.type === 'failed' ? 'failed'
      : null;
    if (!address || !status) return [];
    return [{
      kind: 'status',
      status,
      address,
      // Gupshup carries nothing of ours through a send; the events service
      // attributes the report to the person's latest WhatsApp campaign.
      campaignId: null,
      identityId: null,
      errorCode: payload.payload?.code != null ? String(payload.payload.code) : null,
      detail: payload.payload?.reason ?? null,
      occurredAt,
    }];
  }
}

function mediaMessage(
  url: string | null,
  type: 'image' | 'video' | 'document' | null,
): Record<string, unknown> | null {
  if (!url || !type) return null;
  if (type === 'document') {
    const filename = url.split('?')[0].split('/').pop() || 'document';
    return { type, document: { link: url, filename } };
  }
  return { type, [type]: { link: url } };
}

function toTemplate(item: Record<string, unknown>): WhatsAppTemplate {
  const bodyText = typeof item.data === 'string' ? item.data : '';
  let container: Record<string, unknown> = {};
  try {
    container = typeof item.containerMeta === 'string' ? JSON.parse(item.containerMeta) : {};
  } catch {
    container = {};
  }
  const type = String(item.templateType ?? 'TEXT').toUpperCase();
  const headerText = typeof container.header === 'string' ? container.header : null;
  const header =
    ['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(type)
      ? { format: type as 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION', text: null, paramCount: 0 }
      : headerText
        ? { format: 'TEXT' as const, text: headerText, paramCount: countPlaceholders(headerText) }
        : null;
  // `data` is the body as Gupshup shows it, header and footer included when
  // the template has them; the body proper is what has placeholders.
  const body = typeof container.data === 'string' ? container.data : bodyText;
  return {
    id: String(item.id ?? ''),
    name: String(item.elementName ?? item.id ?? ''),
    language: String(item.languageCode ?? 'en'),
    category: typeof item.category === 'string' ? item.category.toUpperCase() : null,
    status: String(item.status ?? '').toUpperCase(),
    bodyText: body,
    paramNames: null,
    bodyParamCount: countPlaceholders(body),
    header,
    // Gupshup's v1 send has no parameter for dynamic URL buttons, so a
    // template that needs one is offered without it: static buttons still
    // render, and a dynamic one sends with its sample value.
    buttons: [],
  };
}
