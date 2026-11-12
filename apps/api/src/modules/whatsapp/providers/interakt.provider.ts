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
  WebhookRequest,
  WhatsAppEvent,
  WhatsAppProvider,
  WhatsAppTemplate,
} from './whatsapp-provider';

export interface InteraktCredentials {
  /** The Secret Key from Settings → Developer Setting, sent as-is after `Basic`. */
  apiKey: string;
  /** The webhook Secret Key set beside the webhook URL; signs every webhook. */
  webhookSecret?: string;
}

const API = 'https://api.interakt.ai/v1/public';

/**
 * Interakt's send API, one recipient per request.
 *
 * Interakt allows 300 requests a minute on Growth and 600 on Advanced,
 * shared across its API, so three in flight with backoff on 429 stays
 * inside the smaller plan.
 * https://www.interakt.shop/resource-center/how-to-send-whatsapp-templates-using-apis-webhooks/
 */
@Injectable()
export class InteraktProvider
  extends PerRecipientProvider<WhatsAppMessage, WhatsAppProviderName>
  implements WhatsAppProvider
{
  readonly provider = 'interakt' as const;
  readonly reportsCarryCampaign = true;
  readonly canListTemplates = false;
  protected readonly logger = new Logger(InteraktProvider.name);
  protected readonly concurrency = 3;

  /**
   * Interakt passes Meta's own error code through as `channel_error_code`
   * (and reports a non-WhatsApp number as 1013).
   */
  readonly suppressingErrors: ReadonlyMap<string, 'unsubscribed' | 'bounced'> = new Map([
    ['1013', 'bounced'], // recipient is not a valid WhatsApp user
    ['131026', 'bounced'], // Meta: message undeliverable / not on WhatsApp
    ['131050', 'unsubscribed'], // Meta: user stopped marketing messages
  ]);

  protected parseCredentials(credentials: unknown): InteraktCredentials {
    const value = credentials as Partial<InteraktCredentials> | null;
    const apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
    if (!apiKey || /\s/.test(apiKey)) {
      throw new BadRequestException(
        'Paste the Secret Key from Interakt → Settings → Developer Setting.',
      );
    }
    const webhookSecret =
      typeof value?.webhookSecret === 'string' && value.webhookSecret.trim()
        ? value.webhookSecret.trim()
        : undefined;
    return { apiKey, ...(webhookSecret ? { webhookSecret } : {}) };
  }

  /**
   * Interakt documents no "who am I" endpoint, so the cheapest authenticated
   * read stands in: one page of one user.
   */
  async validateCredentials(credentials: unknown): Promise<void> {
    const { apiKey } = this.parseCredentials(credentials);
    const response = await this.request(`${API}/apis/users/?offset=0&limit=1`, {
      method: 'POST',
      headers: { authorization: `Basic ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filters: [] }),
    });
    if (response.ok) return;
    const body = await readJson(response);
    throw new BadRequestException(
      response.status === 401 || response.status === 403
        ? 'Interakt rejected this Secret Key. Copy it again from Settings → Developer Setting (public APIs need the Growth plan or above).'
        : `Interakt could not be reached with this key: ${response.status} ${String(body.message ?? '')}`.trim(),
    );
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: WhatsAppMessage,
  ): Promise<AttemptResult> {
    const { apiKey } = credentials as InteraktCredentials;
    const { countryCode, phoneNumber } = splitNumber(to);

    const template: Record<string, unknown> = {
      name: message.template.id,
      languageCode: message.template.language,
      bodyValues: message.bodyParams,
    };
    const header = message.headerMediaUrl ?? message.headerText;
    if (header) template.headerValues = [header];
    if (message.buttonParams.length > 0) {
      template.buttonValues = Object.fromEntries(
        message.buttonParams.map((value, index) => [String(index), [value]]),
      );
    }

    const response = await this.request(`${API}/message/`, {
      method: 'POST',
      headers: { authorization: `Basic ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        countryCode,
        phoneNumber,
        type: 'Template',
        // Returned on every webhook for this message; how a report finds
        // its campaign and person. Interakt allows 512 characters.
        callbackData: callbackData(message),
        template,
      }),
    });

    const body = await readJson(response);
    if (response.ok && body.result !== false) return { outcome: { kind: 'success' } };

    const error = `${response.status} ${String(body.message ?? '')}`.trim();
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAccountError(`Interakt refused this Secret Key: ${error}`);
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    // A template Interakt does not know fails every recipient alike.
    if (/template/i.test(String(body.message ?? ''))) {
      throw new ProviderAccountError(`Interakt rejected the template: ${error}`);
    }
    return { outcome: { kind: 'permanent', error } };
  }

  /** Interakt has no template list API; templates are entered by hand. */
  async listTemplates(): Promise<WhatsAppTemplate[]> {
    return [];
  }

  /**
   * `Interakt-Signature: sha256=<hex HMAC-SHA256 of the raw body>`, keyed
   * with the webhook Secret Key. Without that secret stored there is
   * nothing to check against, so events are treated as unsigned.
   * https://www.interakt.shop/resource-center/interakts-webhooks-for-customer-messages-sent-template-status/
   */
  authenticateWebhook(credentials: unknown, request: WebhookRequest): boolean | 'unsigned' {
    const secret = (credentials as Partial<InteraktCredentials> | null)?.webhookSecret;
    if (typeof secret !== 'string' || !secret) return 'unsigned';
    const given = request.header('interakt-signature') ?? '';
    const expected = `sha256=${createHmac('sha256', secret).update(request.rawBody, 'utf8').digest('hex')}`;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(request: WebhookRequest): WhatsAppEvent[] {
    const payload = (request.body ?? {}) as {
      type?: string;
      timestamp?: string;
      data?: {
        customer?: { channel_phone_number?: string };
        message?: {
          message?: string;
          channel_error_code?: string | number | null;
          channel_failure_reason?: string | null;
          meta_data?: { source_data?: { callback_data?: string } };
        };
      };
    };
    const raw = payload.data?.customer?.channel_phone_number;
    const address = normalisePhone(raw ? `+${String(raw).replace(/^\+/, '')}` : '');
    if (!address) return [];
    // Interakt's timestamps carry no zone; they are UTC.
    const at = payload.timestamp ? new Date(`${payload.timestamp.replace(/Z$/, '')}Z`) : new Date();
    const occurredAt = Number.isNaN(at.getTime()) ? new Date() : at;
    const message = payload.data?.message ?? {};

    if (payload.type === 'message_received') {
      const text = typeof message.message === 'string' ? message.message : '';
      return text.trim() ? [{ kind: 'inbound', address, text, occurredAt }] : [];
    }

    const status =
      payload.type === 'message_api_delivered' ? 'delivered'
      : payload.type === 'message_api_read' ? 'read'
      : payload.type === 'message_api_failed' ? 'failed'
      : null;
    if (!status) return [];

    const { campaignId, identityId } = parseCallbackData(
      message.meta_data?.source_data?.callback_data,
    );
    return [{
      kind: 'status',
      status,
      address,
      campaignId,
      identityId,
      errorCode: message.channel_error_code != null ? String(message.channel_error_code) : null,
      detail: message.channel_failure_reason ?? null,
      occurredAt,
    }];
  }
}

/**
 * Interakt wants the country code apart from the national number. E.164
 * does not mark where one ends, so the calling code is matched against the
 * ITU list: every calling code is a prefix of no other.
 */
export function splitNumber(e164: string): { countryCode: string; phoneNumber: string } {
  const digits = e164.replace(/^\+/, '');
  for (const length of [1, 2, 3]) {
    const code = digits.slice(0, length);
    if (CALLING_CODES.has(code)) {
      return { countryCode: `+${code}`, phoneNumber: digits.slice(length) };
    }
  }
  return { countryCode: `+${digits.slice(0, 2)}`, phoneNumber: digits.slice(2) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function callbackData(message: WhatsAppMessage): string {
  return JSON.stringify({ c: message.campaignId, i: message.identityId });
}

export function parseCallbackData(value: unknown): { campaignId: string | null; identityId: string | null } {
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

/** ITU-T E.164 country calling codes (assigned, as of 2024). */
const CALLING_CODES = new Set([
  '1', '7',
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84',
  '86', '90', '91', '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244',
  '245', '246', '247', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260',
  '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374',
  '375', '376', '377', '378', '379', '380', '381', '382', '383', '385', '386', '387', '389',
  '420', '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686',
  '687', '688', '689', '690', '691', '692',
  '850', '852', '853', '855', '856', '880', '886',
  '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975',
  '976', '977', '992', '993', '994', '995', '996', '998',
]);
