import { createHmac, hkdfSync, randomBytes } from 'crypto';
import {
  CONFIRM_KEY_PURPOSE,
  UNSUBSCRIBE_KEY_PURPOSE,
  UnsubscribeLinks,
} from '../../apps/api/src/modules/email/unsubscribe-link';
import { runSecrets, stackEnv } from './stack';

/**
 * Signatures as the providers (and the API's own email links) make them, so a spec can
 * post an inbound webhook the API accepts, or open a link it would have mailed. Each one
 * is the provider's documented scheme, written out here rather than borrowed from the
 * API's verifier, so a change on either side shows as a refused request.
 */

/**
 * The address the API believes it has (API_BASE_URL, the lane's), plus `path`. Twilio
 * signs the URL it called, and the API checks against this, so sign this one and post
 * the same path to `apiUrl(path)`.
 */
export function publicApiUrl(path: string): string {
  const base = stackEnv().API_BASE_URL;
  if (!base) throw new Error('API_BASE_URL must be set in .env for the e2e stack');
  return `${base.replace(/\/+$/, '')}${path}`;
}

// ------------------------------------------------------------ Resend/Svix ---

export interface SvixHeaders {
  'svix-id': string;
  'svix-timestamp': string;
  'svix-signature': string;
}

/**
 * Resend's webhook headers (Svix): `v1,` and the base64 HMAC-SHA256, keyed with the
 * base64 bytes after `whsec_`, of `<id>.<timestamp>.<raw body>`. Timestamp in seconds;
 * the API refuses one more than 5 minutes from its clock.
 */
export function signSvix(
  secret: string,
  rawBody: string,
  { id = `msg_e2e${randomBytes(8).toString('hex')}`, timestamp = Math.floor(Date.now() / 1000) }: { id?: string; timestamp?: number } = {},
): SvixHeaders {
  if (!secret.startsWith('whsec_')) throw new Error('A Svix secret starts with whsec_');
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
}

// ----------------------------------------------------------------- Twilio ---

/**
 * `X-Twilio-Signature`: base64 HMAC-SHA1, keyed with the Auth Token, of the full URL
 * Twilio requested (query string included) followed by each POST parameter, sorted by
 * name, as name then value. A repeated parameter contributes each value, sorted.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string | string[]> = {}): string {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((name) => {
        const value = params[name];
        const values = Array.isArray(value) ? [...value].sort() : [value];
        return values.map((item) => name + item).join('');
      })
      .join('');
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

// -------------------------------------------------------- Meta / Interakt ---

/** Meta's `X-Hub-Signature-256`: `sha256=` and the hex HMAC-SHA256 of the raw body, keyed with the app secret. */
export function hubSignature(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

/** Interakt's `Interakt-Signature`: the same form as Meta's, keyed with the webhook secret. */
export function interaktSignature(webhookSecret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex')}`;
}

// --------------------------------------------------------------- Razorpay ---

/** `X-Razorpay-Signature`: hex HMAC-SHA256 of the raw body under the run's webhook secret. */
export function razorpaySignature(rawBody: string, secret = runSecrets().razorpayWebhookSecret): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

// ------------------------------------------------------------ email links ---

/**
 * A key the API derives from CREDENTIALS_ENCRYPTION_KEY for one purpose
 * (`CredentialsCryptoService.deriveKey`): HKDF-SHA256, empty salt, the purpose as info.
 */
export function deriveCredentialsKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(runSecrets().credentialsKey, 'hex'), Buffer.alloc(0), purpose, 32));
}

/**
 * The unsubscribe link the API puts in an email to `address` from `projectId`, on the
 * API's public address. Open its path and query on `apiUrl` from a test.
 */
export function signUnsubscribeLink(projectId: string, address: string): string {
  return new UnsubscribeLinks(deriveCredentialsKey(UNSUBSCRIBE_KEY_PURPOSE), publicApiUrl('')).url(projectId, address);
}

/**
 * The double opt-in link the API mails `address`, for the send made at `sentAt`. The
 * API honours it for a week, and confirms only if `sentAt` is the person's latest
 * confirmation send (`device_identities.email_confirm_sent_at`, to the millisecond).
 */
export function signConfirmLink(projectId: string, address: string, sentAt: Date): string {
  return new UnsubscribeLinks(deriveCredentialsKey(CONFIRM_KEY_PURPOSE), publicApiUrl(''), '/api/email/confirm').url(
    projectId,
    `${address}\n${sentAt.getTime()}`,
  );
}

/** The path and query of a full URL, for posting it to `apiUrl` (the local address). */
export function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
