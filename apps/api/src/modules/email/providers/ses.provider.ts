import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EmailMessage } from '../email-rendering';
import {
  AttemptResult,
  BaseEmailProvider,
  EmailAccountError,
  readJson,
} from './email-provider';
import { signRequest } from './sigv4';
import { BoundedCache } from '../email-webhooks';
import { webhookCacheKey } from '../../webhooks/per-project-lru';

/**
 * Longest an STS `GetCallerIdentity` lookup may take. The SES webhook makes
 * every copy of a message wait on the first copy's lookup, so a lookup with
 * no limit would hold them all; a timeout is answered 503 and SNS retries.
 */
export const SES_STS_TIMEOUT_MS = 5_000;

/**
 * Account ids remembered, one per set of credentials. Bounded because
 * projects are unlimited per account; one pushed out costs its project one
 * more lookup, nothing else.
 */
export const SES_ACCOUNT_ID_CACHE_ENTRIES = 10_000;
/** An account id never changes, so this only lets unused keys go. */
const SES_ACCOUNT_ID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SesCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * The configuration set whose event destination publishes to the SNS topic
   * Chumbaq is subscribed to. Without one SES sends fine but reports no
   * deliveries, opens, clicks or bounces.
   */
  configurationSetName?: string;
}

/**
 * Errors that mean the account cannot send at all. Every recipient after the
 * first would fail identically, so the page stops instead.
 */
const ACCOUNT_ERRORS = new Set([
  'AccountSuspendedException',
  'SendingPausedException',
  'MailFromDomainNotVerifiedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'AccessDeniedException',
  'NotFoundException',
]);

/**
 * Amazon SES v2 `SendEmail`, one recipient per call.
 *
 * Eight in flight sits well under the 14 messages a second a new production
 * SES account is allowed; an account with a higher quota is simply not
 * saturated, which is the safe direction to be wrong in.
 */
@Injectable()
export class SesProvider extends BaseEmailProvider {
  readonly provider = 'ses' as const;
  protected readonly logger = new Logger(SesProvider.name);
  protected readonly concurrency = 8;

  protected parseCredentials(credentials: unknown): SesCredentials {
    const value = credentials as Partial<SesCredentials> | null;
    if (
      !value ||
      typeof value.region !== 'string' ||
      !/^[a-z]{2}(-[a-z]+)+-\d$/.test(value.region) ||
      typeof value.accessKeyId !== 'string' ||
      !value.accessKeyId ||
      typeof value.secretAccessKey !== 'string' ||
      !value.secretAccessKey
    ) {
      throw new BadRequestException(
        'SES needs a region (such as ap-south-1), an access key id and a secret access key.',
      );
    }
    return value as SesCredentials;
  }

  async validateCredentials(credentials: unknown): Promise<void> {
    const parsed = this.parseCredentials(credentials);
    const response = await this.call(parsed, 'GET', '/v2/email/account');
    if (response.ok) {
      const body = await readJson(response);
      if (body.SendingEnabled === false) {
        throw new BadRequestException(
          'This SES account has sending disabled. Re-enable it in the SES console first.',
        );
      }
      return;
    }
    const body = await readJson(response);
    throw new BadRequestException(
      `SES rejected these credentials: ${this.errorType(response, body)} ${String(body.message ?? body.Message ?? '')}`.trim(),
    );
  }

  protected async attempt(
    credentials: unknown,
    to: string,
    message: EmailMessage,
  ): Promise<AttemptResult> {
    const ses = credentials as SesCredentials;

    const payload = {
      FromEmailAddress: message.from,
      Destination: { ToAddresses: [to] },
      ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
          Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
        },
      },
      EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })),
      ...(ses.configurationSetName
        ? { ConfigurationSetName: ses.configurationSetName }
        : {}),
    };

    const response = await this.call(
      ses,
      'POST',
      '/v2/email/outbound-emails',
      JSON.stringify(payload),
    );
    if (response.ok) return { outcome: { kind: 'success' } };

    const body = await readJson(response);
    const type = this.errorType(response, body);
    const error = `${response.status} ${type}: ${String(body.message ?? body.Message ?? '')}`;

    if (response.status === 403 || ACCOUNT_ERRORS.has(type)) {
      throw new EmailAccountError(`SES cannot send from this account: ${error}`);
    }
    if (response.status === 429 || response.status >= 500 || type === 'TooManyRequestsException') {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    // MessageRejected, BadRequest: about this message or this address.
    return { outcome: { kind: 'permanent', error, errorCode: type } };
  }

  /**
   * The AWS account these credentials belong to, from STS
   * `GetCallerIdentity` — which every principal may call, so it needs no
   * extra IAM permission. Cached per access key and secret (a digest of
   * both, so another tenant typing a known key id with a wrong secret gets
   * STS's refusal, not the cached account): the answer cannot change.
   *
   * Used to bind SES event topics to the customer: a validly signed SNS
   * message only proves *some* AWS account sent it, and an SNS topic ARN
   * names the account that owns it.
   */
  async accountId(credentials: unknown): Promise<string> {
    const ses = this.parseCredentials(credentials);
    const key = webhookCacheKey(ses.accessKeyId, ses.secretAccessKey);
    const cached = this.accountIds.get(key);
    if (cached) return cached;

    const host = `sts.${ses.region}.amazonaws.com`;
    const body = 'Action=GetCallerIdentity&Version=2011-06-15';
    const headers = signRequest(
      {
        method: 'POST',
        host,
        path: '/',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
      ses,
      ses.region,
      'sts',
    );
    const { host: _host, ...sendable } = headers;
    // The signal also ends reading the body, so a trickled answer is cut off too.
    const response = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: sendable,
      body,
      signal: AbortSignal.timeout(this.stsTimeoutMs),
    });
    const text = await response.text();
    const account = /<Account>(\d{12})<\/Account>/.exec(text)?.[1];
    if (!response.ok || !account) {
      throw new Error(`STS GetCallerIdentity failed (${response.status})`);
    }
    this.accountIds.set(key, account);
    return account;
  }

  /** Overridable so tests need not wait the real limit. */
  protected readonly stsTimeoutMs: number = SES_STS_TIMEOUT_MS;

  private readonly accountIds = new BoundedCache<string>(
    SES_ACCOUNT_ID_CACHE_ENTRIES,
    SES_ACCOUNT_ID_CACHE_TTL_MS,
  );

  private call(
    ses: SesCredentials,
    method: string,
    path: string,
    body?: string,
  ): Promise<Response> {
    const host = `email.${ses.region}.amazonaws.com`;
    const headers = signRequest(
      {
        method,
        host,
        path,
        body,
        headers: body ? { 'content-type': 'application/json' } : {},
      },
      ses,
      ses.region,
      'ses',
    );
    // `host` is set by fetch itself and is a forbidden header there.
    const { host: _host, ...sendable } = headers;
    return this.request(`https://${host}${path}`, { method, headers: sendable, body });
  }

  private errorType(response: Response, body: Record<string, unknown>): string {
    const raw =
      response.headers.get('x-amzn-errortype') ??
      (typeof body.__type === 'string' ? body.__type : undefined) ??
      String(response.status);
    // `x-amzn-ErrorType` can carry a `:` suffix and a namespace prefix.
    return raw.split(':')[0].split('#').pop() ?? raw;
  }
}
