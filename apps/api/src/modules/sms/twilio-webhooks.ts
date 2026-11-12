import { createHmac, timingSafeEqual } from 'crypto';
import { normalisePhone } from '../push-notifications/message-channel';
import { TWILIO_UNREACHABLE, TWILIO_UNSUBSCRIBED } from './providers/twilio.provider';

/**
 * Checks `X-Twilio-Signature`.
 *
 * Twilio signs the full URL it requested followed by every POST parameter,
 * sorted by name, as name then value with no separators — HMAC-SHA1 keyed
 * with the account's Auth Token, base64-encoded.
 *
 * `url` must be the URL as Twilio called it, query string included. Behind a
 * proxy the request's own idea of its URL can differ in scheme or host, so
 * the caller rebuilds it from the public base URL Chumbaq handed Twilio.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;

  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => {
        const value = params[key];
        // A repeated parameter arrives as an array; Twilio signs each value,
        // in sorted order, after the same name.
        const values = Array.isArray(value) ? [...value].map(String).sort() : [String(value ?? '')];
        return values.map((item) => key + item).join('');
      })
      .join('');

  const expected = createHmac('sha1', authToken).update(payload, 'utf8').digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type SmsEvent =
  | {
      type: 'delivered';
      address: string;
      campaignId: string | null;
      identityId: string | null;
      occurredAt: Date;
      detail?: string;
    }
  | {
      type: 'bounced';
      address: string;
      /** The number will never take a text: suppress it. */
      permanent: boolean;
      campaignId: string | null;
      identityId: string | null;
      occurredAt: Date;
      detail?: string;
    }
  | {
      type: 'unsubscribed';
      address: string;
      campaignId: string | null;
      identityId: string | null;
      occurredAt: Date;
      detail?: string;
    };

/**
 * Twilio delivery errors that say the number itself is dead, as opposed to
 * a phone that was off or a carrier that filtered one message.
 */
const PERMANENT_DELIVERY_ERRORS = new Set([
  ...TWILIO_UNREACHABLE,
  '30005', // unknown destination handset
  '30006', // landline or unreachable carrier
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads a status callback.
 *
 * Only final states become events: `queued`, `sending` and `sent` are
 * Twilio's progress, and a campaign has already counted the message as sent.
 * The campaign and person come from the callback URL's query string, which
 * Chumbaq wrote and Twilio signed.
 */
export function parseTwilioStatus(
  params: Record<string, unknown>,
  query: Record<string, unknown>,
  now: Date = new Date(),
): SmsEvent | null {
  const address = normalisePhone(params.To);
  if (!address) return null;

  const campaignId = typeof query.c === 'string' && UUID.test(query.c) ? query.c : null;
  const identityId = typeof query.i === 'string' && UUID.test(query.i) ? query.i : null;
  const status = String(params.MessageStatus ?? params.SmsStatus ?? '');
  const errorCode = params.ErrorCode ? String(params.ErrorCode) : '';
  const base = { address, campaignId, identityId, occurredAt: now };

  if (status === 'delivered') return { type: 'delivered', ...base };
  if (status !== 'undelivered' && status !== 'failed') return null;

  const detail = errorCode ? `Twilio error ${errorCode}` : `Twilio status ${status}`;
  if (errorCode === TWILIO_UNSUBSCRIBED) return { type: 'unsubscribed', ...base, detail };
  return {
    type: 'bounced',
    ...base,
    permanent: PERMANENT_DELIVERY_ERRORS.has(errorCode),
    detail,
  };
}

/**
 * The opt-out and opt-in keywords Twilio itself honours on long codes and
 * toll-free numbers. Matching Twilio's list keeps Chumbaq's record and
 * Twilio's block in step: after STOP, Twilio refuses to deliver anyway, and
 * after START it delivers again.
 */
const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);

/** What an incoming text asks for, if it is a keyword at all. */
export function parseInboundKeyword(
  params: Record<string, unknown>,
): { action: 'opt_out' | 'opt_in'; address: string } | null {
  const address = normalisePhone(params.From);
  if (!address) return null;
  // Twilio matches the whole message, case-insensitively, ignoring
  // surrounding whitespace and punctuation: "Stop." is a STOP, "stop sending
  // me these" is not.
  const keyword = String(params.Body ?? '')
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .toUpperCase();
  if (STOP_KEYWORDS.has(keyword)) return { action: 'opt_out', address };
  if (START_KEYWORDS.has(keyword)) return { action: 'opt_in', address };
  return null;
}
