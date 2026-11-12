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
import { verifyTwilioSignature } from '../../sms/twilio-webhooks';
import { WhatsAppMessage } from '../whatsapp-rendering';
import {
  WebhookRequest,
  WhatsAppEvent,
  WhatsAppProvider,
  WhatsAppTemplate,
} from './whatsapp-provider';

export interface TwilioWhatsAppCredentials {
  accountSid: string;
  /** The Auth Token: it also signs Twilio's webhooks. */
  authToken: string;
  /** The WhatsApp sender, `+E164`, or a Messaging Service SID (`MG...`). */
  sender: string;
}

const API = 'https://api.twilio.com/2010-04-01';
const CONTENT_API = 'https://content.twilio.com/v1';

/**
 * Codes about the account, the sender or the template rather than the
 * person: every remaining recipient would fail the same way, so the page
 * stops and the campaign is retried once it is fixed.
 * https://www.twilio.com/docs/api/errors
 */
const ACCOUNT_ERRORS = new Set([
  '20003', // authentication failed
  '20404', // resource not found (account, service, content)
  '21212', // invalid From
  '21606', // From not message-capable
  '63007', // no WhatsApp channel for the From address
  '63027', // template does not exist for this language
  '63112', // Meta disabled the WhatsApp Business Account
]);

/** Throughput limits: retried with backoff. */
const RETRYABLE_ERRORS = new Set([
  '63018', // rate limit (sender throughput or the portfolio's daily limit)
  '20429', // too many requests
]);

/**
 * Twilio WhatsApp, through the Messages API with Content templates
 * (`ContentSid` + `ContentVariables`), one recipient per request.
 */
@Injectable()
export class TwilioWhatsAppProvider
  extends PerRecipientProvider<WhatsAppMessage, WhatsAppProviderName>
  implements WhatsAppProvider
{
  readonly provider = 'twilio_whatsapp' as const;
  readonly reportsCarryCampaign = true;
  readonly canListTemplates = true;
  protected readonly logger = new Logger(TwilioWhatsAppProvider.name);
  /** Well under a WhatsApp sender's default 80 messages a second. */
  protected readonly concurrency = 10;

  readonly suppressingErrors: ReadonlyMap<string, 'unsubscribed' | 'bounced'> = new Map([
    ['21610', 'unsubscribed'], // replied STOP
    ['63024', 'bounced'], // not on WhatsApp, or never accepted its terms
    ['63003', 'bounced'], // invalid or inactive WhatsApp address
    ['21211', 'bounced'], // not a valid phone number
  ]);

  protected parseCredentials(credentials: unknown): TwilioWhatsAppCredentials {
    const value = credentials as Partial<TwilioWhatsAppCredentials> | null;
    if (!value || typeof value.accountSid !== 'string' || !/^AC[0-9a-fA-F]{32}$/.test(value.accountSid)) {
      throw new BadRequestException('A Twilio Account SID starts with "AC" followed by 32 characters.');
    }
    if (typeof value.authToken !== 'string' || !/^[0-9a-fA-F]{32}$/.test(value.authToken)) {
      throw new BadRequestException('The Twilio Auth Token is 32 characters, under Account Info in the Console.');
    }
    const sender = typeof value.sender === 'string' ? value.sender.trim().replace(/^whatsapp:/, '') : '';
    if (!normalisePhone(sender) && !/^MG[0-9a-fA-F]{32}$/.test(sender)) {
      throw new BadRequestException(
        'The sender is your WhatsApp-enabled Twilio number in international form (+14155550123), or a Messaging Service SID (MG...).',
      );
    }
    return { accountSid: value.accountSid, authToken: value.authToken, sender: normalisePhone(sender) ?? sender };
  }

  async validateCredentials(credentials: unknown): Promise<void> {
    const { accountSid, authToken } = this.parseCredentials(credentials);
    const response = await this.request(`${API}/Accounts/${accountSid}.json`, {
      headers: { authorization: basicAuth(accountSid, authToken), accept: 'application/json' },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new BadRequestException(`Twilio rejected these credentials: ${describe(response, body)}`);
    }
    if (body.status && body.status !== 'active') {
      throw new BadRequestException(`This Twilio account is ${String(body.status)}, so it cannot send.`);
    }
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: WhatsAppMessage,
  ): Promise<AttemptResult> {
    const { accountSid, authToken, sender } = credentials as TwilioWhatsAppCredentials;

    const form = new URLSearchParams({
      To: `whatsapp:${to}`,
      ContentSid: message.template.id,
    });
    if (sender.startsWith('MG')) form.set('MessagingServiceSid', sender);
    else form.set('From', `whatsapp:${sender}`);
    const variables = contentVariables(message);
    if (Object.keys(variables).length > 0) form.set('ContentVariables', JSON.stringify(variables));
    if (message.statusCallback) form.set('StatusCallback', message.statusCallback);

    const response = await this.request(`${API}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: basicAuth(accountSid, authToken),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    if (response.ok) return { outcome: { kind: 'success' } };

    const body = await readJson(response);
    const code = body.code === undefined || body.code === null ? undefined : String(body.code);
    const error = describe(response, body);

    if (response.status === 401 || response.status === 403 || (code && ACCOUNT_ERRORS.has(code))) {
      throw new ProviderAccountError(`Twilio refused to send from this account: ${error}`);
    }
    if (response.status === 429 || response.status >= 500 || (code && RETRYABLE_ERRORS.has(code))) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    return { outcome: { kind: 'permanent', error, errorCode: code } };
  }

  /**
   * Content templates with their WhatsApp approval, from
   * `GET /v1/ContentAndApprovals`, following `meta.next_page_url`.
   * https://www.twilio.com/docs/content/content-api-resources
   */
  async listTemplates(credentials: unknown): Promise<WhatsAppTemplate[]> {
    const { accountSid, authToken } = this.parseCredentials(credentials);
    const headers = { authorization: basicAuth(accountSid, authToken), accept: 'application/json' };
    const templates: WhatsAppTemplate[] = [];
    let url: string | null = `${CONTENT_API}/ContentAndApprovals?PageSize=500`;

    for (let page = 0; url && page < 10; page++) {
      const response: Response = await this.request(url, { headers });
      const body = await readJson(response);
      if (!response.ok) {
        throw new BadRequestException(`Twilio would not list templates: ${describe(response, body)}`);
      }
      for (const item of (body.contents as Array<Record<string, unknown>>) ?? []) {
        templates.push(toTemplate(item));
      }
      const meta = body.meta as { next_page_url?: string | null } | undefined;
      url = meta?.next_page_url ?? null;
    }
    return templates;
  }

  authenticateWebhook(credentials: unknown, request: WebhookRequest): boolean {
    const authToken = (credentials as Partial<TwilioWhatsAppCredentials> | null)?.authToken;
    if (typeof authToken !== 'string') return false;
    const params = (request.body ?? {}) as Record<string, unknown>;
    if (!verifyTwilioSignature(authToken, request.url, params, request.header('x-twilio-signature'))) {
      return false;
    }
    const accountSid = (credentials as Partial<TwilioWhatsAppCredentials>).accountSid;
    return !params.AccountSid || params.AccountSid === accountSid;
  }

  /**
   * Status callbacks carry `MessageStatus` and our `?c=&i=` query; replies
   * arrive at the same URL as an incoming message with `Body` or a quick
   * reply's `ButtonText`.
   * https://www.twilio.com/docs/messaging/guides/webhook-request
   */
  parseWebhook(request: WebhookRequest): WhatsAppEvent[] {
    const params = (request.body ?? {}) as Record<string, unknown>;
    const now = new Date();
    const status = typeof params.MessageStatus === 'string' ? params.MessageStatus : null;

    if (status && status !== 'received') {
      const address = normalisePhone(String(params.To ?? '').replace(/^whatsapp:/, ''));
      if (!address) return [];
      const mapped =
        status === 'delivered' ? 'delivered'
        : status === 'read' ? 'read'
        : status === 'failed' || status === 'undelivered' ? 'failed'
        : null;
      if (!mapped) return [];
      return [{
        kind: 'status',
        status: mapped,
        address,
        campaignId: uuidOrNull(request.query.c),
        identityId: uuidOrNull(request.query.i),
        errorCode: params.ErrorCode ? String(params.ErrorCode) : null,
        detail: typeof params.ChannelStatusMessage === 'string' ? params.ChannelStatusMessage : null,
        occurredAt: now,
      }];
    }

    const address = normalisePhone(String(params.From ?? '').replace(/^whatsapp:/, ''));
    const text = [params.Body, params.ButtonText, params.ButtonPayload].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    if (!address || !text) return [];
    return [{ kind: 'inbound', address, text, occurredAt: now }];
  }
}

/**
 * The message's values as Content variables. Twilio numbers a template's
 * variables "1", "2", ... across the whole template, which is how the
 * template list reports them too, so the body values fill them in order.
 */
function contentVariables(message: WhatsAppMessage): Record<string, string> {
  const variables: Record<string, string> = {};
  message.bodyParams.forEach((value, index) => {
    variables[String(index + 1)] = value;
  });
  return variables;
}

function toTemplate(item: Record<string, unknown>): WhatsAppTemplate {
  const types = (item.types ?? {}) as Record<string, Record<string, unknown>>;
  const typed = Object.values(types)[0] ?? {};
  const bodyText = typeof typed.body === 'string' ? typed.body : '';
  const variables = (item.variables ?? {}) as Record<string, unknown>;
  const approvals = (item.approval_requests ?? {}) as Record<string, unknown>;
  const approval = (approvals.whatsapp ?? approvals) as Record<string, unknown>;
  const status = String(approval.status ?? 'unsubmitted').toUpperCase();
  return {
    id: String(item.sid ?? ''),
    name: String(item.friendly_name ?? item.sid ?? ''),
    language: String(item.language ?? 'en'),
    category: typeof approval.category === 'string' ? approval.category.toUpperCase() : null,
    status: status === 'RECEIVED' ? 'PENDING' : status,
    bodyText,
    paramNames: null,
    bodyParamCount: Object.keys(variables).length,
    header: null,
    buttons: [],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function describe(response: Response, body: Record<string, unknown>): string {
  const code = body.code ? ` ${String(body.code)}` : '';
  return `${response.status}${code} ${String(body.message ?? '')}`.trim();
}
