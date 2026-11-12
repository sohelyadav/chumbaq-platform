import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EmailMessage } from '../email-rendering';
import {
  AttemptResult,
  BaseEmailProvider,
  EmailAccountError,
  readJson,
} from './email-provider';

export interface ResendCredentials {
  apiKey: string;
  /** `whsec_...` from the Resend webhook, used to verify delivery events. */
  webhookSecret?: string;
}

const API = 'https://api.resend.com';

/**
 * Resend, through its REST API.
 *
 * Resend's default rate limit is 2 requests a second per team, which is why
 * the pool is two wide: going faster only buys 429s.
 */
@Injectable()
export class ResendProvider extends BaseEmailProvider {
  readonly provider = 'resend' as const;
  protected readonly logger = new Logger(ResendProvider.name);
  protected readonly concurrency = 2;

  protected parseCredentials(credentials: unknown): ResendCredentials {
    const value = credentials as Partial<ResendCredentials> | null;
    if (!value || typeof value.apiKey !== 'string' || !value.apiKey.startsWith('re_')) {
      throw new BadRequestException('A Resend API key starts with "re_".');
    }
    if (
      value.webhookSecret !== undefined &&
      (typeof value.webhookSecret !== 'string' || !value.webhookSecret.startsWith('whsec_'))
    ) {
      throw new BadRequestException('A Resend webhook signing secret starts with "whsec_".');
    }
    return value as ResendCredentials;
  }

  /**
   * Proves the key authenticates.
   *
   * A sending-only key — the kind Resend recommends for exactly this use —
   * cannot list domains and answers `restricted_api_key`. That answer still
   * proves the key is real and live, so it is accepted; only an unknown or
   * revoked key is refused.
   */
  async validateCredentials(credentials: unknown): Promise<void> {
    const { apiKey } = this.parseCredentials(credentials);
    const response = await this.request(`${API}/domains`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) return;

    const body = await readJson(response);
    if (body.name === 'restricted_api_key') return;
    throw new BadRequestException(
      `Resend rejected this API key: ${String(body.message ?? response.status)}`,
    );
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: EmailMessage,
  ): Promise<AttemptResult> {
    const { apiKey } = credentials as ResendCredentials;

    const response = await this.request(`${API}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to: [to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        headers: message.headers,
        tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
      }),
    });

    if (response.ok) return { outcome: { kind: 'success' } };

    const body = await readJson(response);
    const name = typeof body.name === 'string' ? body.name : undefined;
    const error = `${response.status} ${String(body.message ?? 'Resend error')}`;

    if (response.status === 401 || response.status === 403) {
      throw new EmailAccountError(`Resend refused the API key: ${error}`);
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    return { outcome: { kind: 'permanent', error, errorCode: name } };
  }
}
