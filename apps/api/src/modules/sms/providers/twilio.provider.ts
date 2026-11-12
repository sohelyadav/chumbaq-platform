import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SmsProviderName } from '../../push-notifications/message-channel';
import { DeliveryProvider } from '../../push-notifications/services/channel-provider';
import {
  AttemptResult,
  PerRecipientProvider,
  ProviderAccountError,
  readJson,
} from '../../push-notifications/services/per-recipient-provider';
import { SmsMessage } from '../sms-rendering';

export type SmsProvider = DeliveryProvider<SmsMessage, SmsProviderName>;

export interface TwilioCredentials {
  /** `AC` and 32 hex characters, from the Twilio Console. */
  accountSid: string;
  /**
   * The account's Auth Token. An API key would send just as well, but only
   * the Auth Token signs Twilio's webhooks, and without it delivery reports
   * and STOP replies could not be told from forgeries.
   */
  authToken: string;
}

const API = 'https://api.twilio.com/2010-04-01';

/**
 * Twilio error codes that mean the recipient will never be reachable, and
 * so are suppressed rather than retried on the next campaign.
 *
 * 21610 is the one that matters most: the person replied STOP, Twilio has
 * blocked the number for this sender, and every further attempt is billed
 * and refused.
 */
export const TWILIO_UNSUBSCRIBED = '21610';
export const TWILIO_UNREACHABLE = new Set([
  '21211', // not a valid phone number
  '21614', // not a mobile number (a landline)
]);

/**
 * Codes about the sender or the account rather than the recipient. Each one
 * would fail every remaining recipient identically, so the page stops.
 */
const SENDER_ERRORS = new Set([
  '20003', // authentication failed
  '20404', // account or messaging service not found
  '21212', // invalid From number
  '21603', // From number required
  '21606', // From number not SMS-capable or not owned by this account
  '21659', // From number not a Twilio number
  '21701', // messaging service not found
  '21703', // messaging service has no numbers
  '21704', // messaging service has no phone numbers in its pool
  '21705', // invalid messaging service
  '30002', // account suspended
]);

/**
 * Twilio Programmable Messaging, one recipient per request.
 *
 * Twilio queues what it accepts and paces it out at the sender's own rate
 * (about one a second for a long code), so the concurrency here only bounds
 * how fast messages are handed over, not how fast they reach phones.
 */
@Injectable()
export class TwilioProvider
  extends PerRecipientProvider<SmsMessage, SmsProviderName>
  implements SmsProvider
{
  readonly provider = 'twilio' as const;
  protected readonly logger = new Logger(TwilioProvider.name);
  protected readonly concurrency = 5;

  protected parseCredentials(credentials: unknown): TwilioCredentials {
    const value = credentials as Partial<TwilioCredentials> | null;
    if (!value || typeof value.accountSid !== 'string' || !/^AC[0-9a-fA-F]{32}$/.test(value.accountSid)) {
      throw new BadRequestException(
        'A Twilio Account SID starts with "AC" followed by 32 characters. Find it on the Twilio Console home page.',
      );
    }
    if (typeof value.authToken !== 'string' || !/^[0-9a-fA-F]{32}$/.test(value.authToken)) {
      throw new BadRequestException(
        'The Twilio Auth Token is 32 characters, shown under Account Info on the Console home page.',
      );
    }
    return value as TwilioCredentials;
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
    message: SmsMessage,
  ): Promise<AttemptResult> {
    const { accountSid, authToken } = credentials as TwilioCredentials;

    const form = new URLSearchParams({ To: to, Body: message.body });
    if (/^MG[0-9a-fA-F]{32}$/.test(message.from)) form.set('MessagingServiceSid', message.from);
    else form.set('From', message.from);
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

    if (
      response.status === 401 ||
      response.status === 403 ||
      (code !== undefined && SENDER_ERRORS.has(code))
    ) {
      throw new ProviderAccountError(`Twilio refused to send from this account: ${error}`);
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        outcome: { kind: 'retryable', error },
        retryAfterMs: this.parseRetryAfter(response.headers.get('retry-after')),
      };
    }
    return { outcome: { kind: 'permanent', error, errorCode: code } };
  }
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function describe(response: Response, body: Record<string, unknown>): string {
  const code = body.code ? ` ${String(body.code)}` : '';
  return `${response.status}${code} ${String(body.message ?? '')}`.trim();
}
