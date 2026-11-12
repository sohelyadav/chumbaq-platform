import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EmailMessage } from '../email-rendering';
import {
  AttemptResult,
  BaseEmailProvider,
  EmailAccountError,
  readJson,
} from './email-provider';

export interface BrevoCredentials {
  /** A v3 API key, `xkeysib-...`. An SMTP key (`xsmtpsib-...`) cannot call the API. */
  apiKey: string;
}

const API = 'https://api.brevo.com/v3';

/**
 * Brevo tags are plain strings, not name/value pairs, so each Chumbaq tag
 * travels as `name:value` and is split again when the webhook returns it.
 */
export const BREVO_TAG_SEPARATOR = ':';

/**
 * Brevo's transactional email API (`POST /v3/smtp/email`), one recipient per
 * call.
 *
 * Brevo meters transactional sends per account plan rather than per second
 * for most plans; five in flight stays clear of its burst limit while still
 * moving a page of 100 in a few seconds.
 */
@Injectable()
export class BrevoProvider extends BaseEmailProvider {
  readonly provider = 'brevo' as const;
  protected readonly logger = new Logger(BrevoProvider.name);
  protected readonly concurrency = 5;

  protected parseCredentials(credentials: unknown): BrevoCredentials {
    const value = credentials as Partial<BrevoCredentials> | null;
    if (value && typeof value.apiKey === 'string' && value.apiKey.startsWith('xsmtpsib-')) {
      throw new BadRequestException(
        'That is a Brevo SMTP key. Create an API key (it starts with "xkeysib-") under SMTP & API → API Keys.',
      );
    }
    if (!value || typeof value.apiKey !== 'string' || !value.apiKey.startsWith('xkeysib-')) {
      throw new BadRequestException('A Brevo API key starts with "xkeysib-".');
    }
    return value as BrevoCredentials;
  }

  async validateCredentials(credentials: unknown): Promise<void> {
    const { apiKey } = this.parseCredentials(credentials);
    const response = await this.request(`${API}/account`, {
      headers: { 'api-key': apiKey, accept: 'application/json' },
    });
    if (response.ok) return;

    const body = await readJson(response);
    throw new BadRequestException(`Brevo rejected this API key: ${this.describe(response, body)}`);
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: EmailMessage,
  ): Promise<AttemptResult> {
    const { apiKey } = credentials as BrevoCredentials;
    const sender = parseFrom(message.from);

    const response = await this.request(`${API}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender,
        to: [{ email: to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        ...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
        headers: message.headers,
        tags: Object.entries(message.tags).map(
          ([name, value]) => `${name}${BREVO_TAG_SEPARATOR}${value}`,
        ),
      }),
    });

    if (response.ok) return { outcome: { kind: 'success' } };

    const body = await readJson(response);
    const code = typeof body.code === 'string' ? body.code : undefined;
    const error = this.describe(response, body);

    // 401 covers both a revoked key and Brevo's "Authorised IPs" lock, which
    // refuses any server not on the account's allow-list. Either way no
    // recipient will get through, so the page stops rather than failing each.
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new EmailAccountError(`Brevo refused to send from this account: ${error}`);
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    return { outcome: { kind: 'permanent', error, errorCode: code } };
  }

  private describe(response: Response, body: Record<string, unknown>): string {
    return `${response.status} ${String(body.code ?? '')} ${String(body.message ?? '')}`.trim();
  }
}

/**
 * Splits `"Name" <address>` back into Brevo's `{ name, email }`.
 *
 * The renderer formats `From` for providers that take a header string;
 * Brevo takes the parts instead.
 */
export function parseFrom(from: string): { email: string; name?: string } {
  const match = /^\s*"?((?:[^"\\]|\\.)*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const name = match[1].replace(/\\(.)/g, '$1').trim();
  return name ? { email: match[2].trim(), name } : { email: match[2].trim() };
}
