import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as http2 from 'http2';
import {
  ChannelProvider,
  CampaignMessage,
  ChannelRecipient,
  ChannelSendResult,
  ChannelSendOptions,
  ACTIONS_DATA_KEY,
  CAROUSEL_DATA_KEY,
  TIMER_DATA_KEY,
  CAMPAIGN_ID_DATA_KEY,
  DEEP_LINK_DATA_KEY,
  IMAGE_DATA_KEY,
} from './channel-provider';
import { SendOutcome, summariseOutcomes, runPool } from './channel-send';

/**
 * Which Apple push environment a token belongs to.
 *
 * A device token minted by a development build only exists in the sandbox and
 * a production token only exists in production, so the wrong environment is
 * not a slow path — it is `BadDeviceToken` for every recipient. It is
 * therefore per-project configuration rather than a constant.
 */
export type ApnsEnvironment = 'production' | 'sandbox';

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'api.push.apple.com',
  // Apple's archived documentation calls this host
  // `api.development.push.apple.com` — the same environment under an older
  // name. If development pushes ever start failing with a DNS or connection
  // error rather than an APNs rejection, that rename is the first thing to
  // check.
  sandbox: 'api.sandbox.push.apple.com',
};

export const APNS_DEFAULT_ENVIRONMENT: ApnsEnvironment = 'production';

export interface ApnsCredentials {
  /** The 10-character key identifier shown next to the .p8 in Apple's console. */
  keyId: string;
  /** The 10-character team identifier the key was issued under. */
  teamId: string;
  /** Contents of the .p8 file: a PEM-encoded EC P-256 private key. */
  privateKey: string;
  /** The app's bundle id, sent as `apns-topic`. APNs rejects a send without it. */
  bundleId: string;
  /** Defaults to `production`. */
  environment?: ApnsEnvironment;
}

/**
 * Apple's `reason` strings that mean "this device token is dead".
 *
 * Unlike Mi Push, these are documented, so the list is fact rather than
 * guesswork: `BadDeviceToken` is a token this topic never issued,
 * `DeviceTokenNotForTopic` is a token belonging to a different app, and
 * `Unregistered` is the app having been removed from the device. None of the
 * three can be fixed by sending again to the same token.
 */
export const APNS_DEAD_TOKEN_REASONS: readonly string[] = [
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
];

/**
 * Reasons that mean our provider token is wrong, not the device's.
 *
 * Deliberately just these two. Anything broader would let a per-device
 * rejection abort a whole campaign, and these are the only reasons Apple
 * documents as being about the JWT we signed.
 */
const PROVIDER_TOKEN_REASONS: readonly string[] = [
  'ExpiredProviderToken',
  'InvalidProviderToken',
];

/**
 * The vocabulary the campaign worker deactivates on. Apple's reason strings
 * mean nothing to it, so a confirmed dead token is reported under the same
 * name FCM uses rather than as a third thing for the worker to match.
 */
const DEAD_TOKEN_ERROR_CODE = 'UNREGISTERED';

/**
 * APNs takes one device token per request, so a page is a page of requests.
 * They are multiplexed over a single HTTP/2 connection rather than a socket
 * each, which is the reason this provider does not speak plain HTTPS.
 */
export const APNS_MAX_CONCURRENT_SENDS = 16;

/** A hung stream would otherwise stall a campaign page indefinitely. */
export const APNS_REQUEST_TIMEOUT_MS = 10_000;

/** Attempts per token, including the first. */
export const APNS_MAX_SEND_ATTEMPTS = 3;

/** Base for exponential backoff between attempts at the same token. */
export const APNS_RETRY_BASE_DELAY_MS = 250;

/**
 * How long a signed provider token is used before it is replaced.
 *
 * Both directions are enforced by Apple and both are cheap to get wrong. A
 * token older than an hour is rejected with `ExpiredProviderToken`; a token
 * minted per request earns `TooManyProviderTokenUpdates`. Fifty minutes leaves
 * a page that starts just under the wire enough room to finish.
 */
export const APNS_TOKEN_REFRESH_MS = 50 * 60 * 1000;

/** Apple's hard payload ceiling. */
export const APNS_MAX_PAYLOAD_BYTES = 4096;

/** `apns-collapse-id` is measured in bytes, not characters. */
export const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/** Credentials after validation, with the environment resolved to a host. */
interface ResolvedCredentials {
  keyId: string;
  teamId: string;
  bundleId: string;
  host: string;
  /**
   * The parsed key, not the PEM. Constructing it is what proves the .p8 is
   * usable, and doing it once per page keeps that cost off every signature.
   */
  signingKey: crypto.KeyObject;
}

/** A signed provider token and the point at which it must be replaced. */
interface CachedProviderToken {
  jwt: string;
  refreshAt: number;
}

/** The shape of Apple's error body, as far as this provider reads it. */
interface ApnsErrorBody {
  reason?: string;
}

/** One attempt's result, plus what the retry loop needs to decide what next. */
interface AttemptResult {
  outcome: SendOutcome;
  /** APNs rejected our JWT. Nothing about the device is known from this. */
  providerTokenRejected?: boolean;
}

/**
 * What one recipient resolved to.
 *
 * `credentials` is not a `SendOutcome` on purpose: a bad signing key is not
 * something that happened to this recipient, and recording it as a per-token
 * failure would deactivate an entire audience over one wrong .p8.
 */
type RecipientResult = SendOutcome | { kind: 'credentials'; error: string };

/**
 * One HTTP/2 connection, reused for the whole page.
 *
 * A connection per notification is both slow — a TLS handshake per recipient —
 * and something Apple explicitly discourages. Reconnection is transparent
 * because APNs sends GOAWAY on connections it wants closed, and a page that
 * outlives one connection must not fail every recipient after it.
 */
class ApnsConnection {
  private session: http2.ClientHttp2Session | null = null;

  constructor(private readonly host: string) {}

  open(): http2.ClientHttp2Session {
    const current = this.session;
    if (current && !current.closed && !current.destroyed) return current;

    const session = http2.connect(`https://${this.host}`);
    // An unhandled 'error' on a session takes the process down. Every request
    // already reports its own failure and retries on a fresh connection, so
    // this listener only has to exist.
    session.on('error', () => undefined);
    this.session = session;
    return session;
  }

  close(): void {
    const session = this.session;
    this.session = null;
    if (!session || session.destroyed) return;
    // Graceful: in-flight streams are allowed to finish. `close` on an
    // already-closing session is a no-op, so this is safe to call once per
    // page regardless of how the page ended.
    session.close();
  }
}

/**
 * Delivers on Apple Push Notification service.
 *
 * Everything iOS-shaped that FCM builds inside its `apns` block is built here
 * directly instead, because there is no Firebase project in the path. The two
 * must agree: the same campaign delivered over FCM to one device and over APNs
 * to another has to look identical on both, so the `aps` dictionary assembled
 * below mirrors `FcmProvider.apnsConfig` field for field.
 */
@Injectable()
export class ApnsProvider implements ChannelProvider {
  readonly provider = 'apns' as const;

  private readonly logger = new Logger(ApnsProvider.name);

  private readonly tokenCache = new Map<string, CachedProviderToken>();

  /** Sends one identical message to many device tokens. */
  send(
    credentials: ApnsCredentials,
    tokens: string[],
    message: CampaignMessage,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    return this.sendToRecipients(
      credentials,
      tokens.map((token) => ({ token, message })),
      options,
    );
  }

  async sendToRecipients(
    credentials: ApnsCredentials,
    recipients: ChannelRecipient[],
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    if (recipients.length === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        failures: [],
        resolvedCount: 0,
        retryReason: null,
      };
    }

    // Thrown rather than reported per token: with an unusable key nothing can
    // be sent, and the campaign should fail loudly instead of recording a
    // delivery failure against every recipient it never attempted.
    const resolved = this.resolveCredentials(credentials);

    const connection = new ApnsConnection(resolved.host);
    const outcomes = new Array<SendOutcome>(recipients.length);
    let credentialError: string | null = null;

    try {
      await runPool(recipients.length, APNS_MAX_CONCURRENT_SENDS, async (i) => {
        // Once the key is known to be rejected there is nothing to learn from
        // the remaining recipients, and every extra request is another
        // rejection Apple counts against us. They are left unresolved because
        // the send below throws anyway.
        if (credentialError) {
          outcomes[i] = { kind: 'retryable', error: credentialError };
          return;
        }

        const result = await this.sendWithRetry(
          resolved,
          connection,
          recipients[i].token,
          recipients[i].message,
          options,
        );

        if (result.kind === 'credentials') {
          credentialError ??= result.error;
          outcomes[i] = { kind: 'retryable', error: result.error };
          return;
        }
        outcomes[i] = result;
      });
    } finally {
      connection.close();
    }

    if (credentialError) {
      throw new BadRequestException(
        `APNs rejected the provider token: ${credentialError}. ` +
          'Check the key id, team id and .p8 stored for this project.',
      );
    }

    return summariseOutcomes(
      recipients.map((r) => r.token),
      outcomes,
      this.logger,
      'APNs',
    );
  }

  /**
   * Checks the stored credentials are usable without contacting Apple.
   *
   * There is no APNs endpoint that validates a key without also sending a
   * notification, so this proves as much as can be proved offline: the fields
   * are present and the .p8 actually parses into a key that can sign ES256.
   * That catches the two mistakes people make — a half-filled form, and a
   * pasted certificate or public key where the private key belongs — which is
   * what this exists to prevent. A well-formed key for the wrong team is only
   * discoverable by sending.
   */
  async validateCredentials(credentials: ApnsCredentials): Promise<void> {
    const resolved = this.resolveCredentials(credentials);
    // Signing rather than merely parsing: a key of the wrong curve parses
    // happily and only fails at the first real send.
    this.signProviderToken(resolved);
  }

  /**
   * Rejects anything that cannot address an APNs send, and resolves the
   * environment to the host it must go to.
   *
   * Takes `unknown` because it is the boundary: this runs against whatever was
   * decrypted from storage or pasted into the dashboard, not against something
   * the type system has already vouched for.
   */
  private resolveCredentials(credentials: unknown): ResolvedCredentials {
    const candidate = (credentials ?? {}) as Partial<ApnsCredentials>;

    const text = (value: unknown): string =>
      typeof value === 'string' ? value.trim() : '';

    const keyId = text(candidate.keyId);
    const teamId = text(candidate.teamId);
    const bundleId = text(candidate.bundleId);
    const privateKey = text(candidate.privateKey);

    const missing: string[] = [];
    if (!keyId) missing.push('keyId');
    if (!teamId) missing.push('teamId');
    if (!privateKey) missing.push('privateKey');
    if (!bundleId) missing.push('bundleId');
    if (missing.length > 0) {
      throw new BadRequestException(
        `APNs credentials are missing ${missing.join(', ')}.`,
      );
    }

    const environment = candidate.environment ?? APNS_DEFAULT_ENVIRONMENT;
    const host = APNS_HOSTS[environment];
    if (!host) {
      // Named environments rather than a free-form host: an unrecognised one
      // would otherwise become `undefined` in the connection and fail every
      // send with a DNS error nobody can trace back to a typo.
      throw new BadRequestException(
        `Unknown APNs environment "${String(environment)}". Expected one of: ${Object.keys(
          APNS_HOSTS,
        ).join(', ')}.`,
      );
    }

    return {
      keyId,
      teamId,
      bundleId,
      host,
      signingKey: this.parseSigningKey(privateKey),
    };
  }

  /**
   * Turns the .p8 contents into a key object, or explains why it cannot.
   *
   * The curve is checked rather than assumed: ES256 is defined only over
   * P-256, and a P-384 key signs without complaint here while every APNs
   * request it produces comes back `InvalidProviderToken` — a failure that
   * looks like a wrong team id and wastes an afternoon.
   */
  private parseSigningKey(privateKey: string): crypto.KeyObject {
    // Environment variables and JSON blobs both carry PEM newlines escaped;
    // without this the key is one line and openssl refuses it.
    const pem = privateKey.includes('\\n')
      ? privateKey.replace(/\\n/g, '\n')
      : privateKey;

    let key: crypto.KeyObject;
    try {
      key = crypto.createPrivateKey(pem);
    } catch (error) {
      throw new BadRequestException(
        `APNs privateKey is not a readable private key: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (key.asymmetricKeyType !== 'ec') {
      throw new BadRequestException(
        `APNs privateKey must be an EC private key, got "${String(
          key.asymmetricKeyType,
        )}". The .p8 downloaded from Apple is one; a .p12 or a certificate is not.`,
      );
    }

    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve && curve !== 'prime256v1') {
      throw new BadRequestException(
        `APNs privateKey must use the P-256 curve, got "${curve}". ES256 is defined only over P-256.`,
      );
    }

    return key;
  }

  private async sendWithRetry(
    credentials: ResolvedCredentials,
    connection: ApnsConnection,
    token: string,
    message: CampaignMessage,
    options: ChannelSendOptions,
  ): Promise<RecipientResult> {
    const payload = this.buildPayload(message);
    const size = Buffer.byteLength(payload);
    if (size > APNS_MAX_PAYLOAD_BYTES) {
      // Not truncated the way Mi Push copy is. That limit is per field, so
      // cutting the description fixes it; this one is a budget shared by the
      // alert and every custom key, usually spent mostly on the latter. Cutting
      // the marketer's copy would often not fit the payload anyway, and would
      // ship different words on iOS than on every other channel.
      return {
        kind: 'permanent',
        error: `APNs payload is ${size} bytes, over the ${APNS_MAX_PAYLOAD_BYTES}-byte limit`,
      };
    }

    // APNs has no validate-only mode. Delivering a real notification under a
    // flag whose entire purpose is not to deliver is the worse failure, so a
    // dry run stops here: the payload above was built and measured, which is
    // the only part that can be checked without sending.
    if (options.dryRun) return { kind: 'success' };

    const headers = this.buildHeaders(credentials, message);
    // One id per recipient, reused across attempts, so a retry is traceable to
    // a single notification in Apple's logs rather than looking like several.
    const notificationId = crypto.randomUUID();

    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= APNS_MAX_SEND_ATTEMPTS; attempt++) {
      const result = await this.attemptWithProviderToken(
        credentials,
        connection,
        token,
        headers,
        notificationId,
        payload,
      );
      if (result.kind === 'credentials') return result;
      if (result.outcome.kind !== 'retryable') return result.outcome;

      lastError = result.outcome.error;
      if (attempt === APNS_MAX_SEND_ATTEMPTS) break;

      await this.sleep(this.retryDelayMs(attempt));
    }

    return { kind: 'retryable', error: lastError };
  }

  /**
   * One send, with a single provider-token regeneration if APNs rejects ours.
   *
   * The regeneration exists for the only benign cause: a cached token that
   * aged past its hour mid-page. A second rejection with a freshly signed
   * token means the key, key id or team id is wrong, and no amount of retrying
   * changes that — so it is reported as a credential failure, which fails the
   * campaign rather than the audience.
   */
  private async attemptWithProviderToken(
    credentials: ResolvedCredentials,
    connection: ApnsConnection,
    token: string,
    headers: http2.OutgoingHttpHeaders,
    notificationId: string,
    payload: string,
  ): Promise<
    { kind: 'attempt'; outcome: SendOutcome } | { kind: 'credentials'; error: string }
  > {
    const jwt = this.providerToken(credentials);
    const first = await this.attemptSend(
      connection,
      token,
      headers,
      notificationId,
      jwt,
      payload,
    );
    if (!first.providerTokenRejected) {
      return { kind: 'attempt', outcome: first.outcome };
    }

    this.refreshProviderToken(credentials, jwt);
    const second = await this.attemptSend(
      connection,
      token,
      headers,
      notificationId,
      this.providerToken(credentials),
      payload,
    );
    if (!second.providerTokenRejected) {
      return { kind: 'attempt', outcome: second.outcome };
    }

    return {
      kind: 'credentials',
      error:
        second.outcome.kind === 'success'
          ? 'provider token rejected'
          : second.outcome.error,
    };
  }

  /**
   * Exponential backoff with jitter. Apple documents no Retry-After on its 429,
   * so unlike FCM and Mi Push there is no server-named delay to honour.
   * Overridable so tests are not paced by real sleeps.
   */
  protected retryDelayMs(attempt: number): number {
    const base = APNS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * APNS_RETRY_BASE_DELAY_MS);
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve();
  }

  /**
   * The request headers that do not change between attempts at one recipient.
   *
   * Everything here mirrors what `FcmProvider.apnsConfig` puts in its `headers`
   * block, because a campaign delivered on both channels must behave the same.
   */
  private buildHeaders(
    credentials: ResolvedCredentials,
    message: CampaignMessage,
  ): http2.OutgoingHttpHeaders {
    const opts = message.options ?? {};
    const headers: http2.OutgoingHttpHeaders = {
      'apns-topic': credentials.bundleId,
      // Apple requires the type to match the payload: a `content-available`
      // push declared as `alert` is rejected, and an alert declared as
      // `background` is delivered to nobody.
      'apns-push-type': message.silent ? 'background' : 'alert',
    };

    if (message.silent) {
      // Apple rejects a background push sent at priority 10 outright.
      headers['apns-priority'] = '5';
    } else if (opts.priority === 'high') {
      headers['apns-priority'] = '10';
    }
    // Otherwise left unset, which is Apple's default of 10 — the same thing
    // the FCM path produces for a campaign with no priority of its own.

    if (opts.ttlSeconds !== undefined) {
      // Absolute unix seconds, not a duration. 0 means deliver now or discard.
      headers['apns-expiration'] = String(
        Math.floor(Date.now() / 1000) + opts.ttlSeconds,
      );
    }

    if (opts.collapseKey) {
      headers['apns-collapse-id'] = this.fitBytes(
        opts.collapseKey,
        APNS_COLLAPSE_ID_MAX_BYTES,
        'collapse key',
      );
    }

    return headers;
  }

  /**
   * The notification body.
   *
   * `aps` is Apple's dictionary and everything else sits beside it at the top
   * level, which is where the client SDKs read it from — the same keys FCM
   * sends in its `data` map, so a device cannot tell which channel carried the
   * campaign.
   */
  private buildPayload(message: CampaignMessage): string {
    const ios = message.options?.ios ?? {};
    const aps: Record<string, unknown> = {};

    if (message.silent) {
      // What actually makes iOS hand the push to the app instead of the shade.
      // A silent push carries no alert at all: including one makes the OS
      // display something no matter what else is set.
      aps['content-available'] = 1;
    } else {
      aps.alert = {
        title: message.title,
        ...(message.body ? { body: message.body } : {}),
      };
      // A payload cannot define an iOS category, only name one. Naming it is
      // what matches a notification to the host app's *content* extension, so
      // a carousel or timer campaign has to set this or it renders as an
      // ordinary notification — the server has no way to guess a string
      // compiled into someone else's Info.plist.
      if (message.iosCategory) aps.category = message.iosCategory;
      if (ios.sound) aps.sound = ios.sound;
      if (ios.badge !== undefined) aps.badge = ios.badge;
      if (ios.threadId) aps['thread-id'] = ios.threadId;
    }

    // APNs has no image field. The URL travels as data and the app's
    // Notification Service Extension attaches it — ChumbaqNotificationService
    // in the iOS SDK does the work; the host app supplies the extension target,
    // which a library cannot ship.
    //
    // `mutable-content` is what allows that extension to run at all: without
    // it iOS delivers the notification without ever waking one — so it gates
    // every job that extension does, not just the image. It also builds the
    // buttons: a payload cannot define an iOS category, only name one, so
    // `ChumbaqPushActions` registers a category from `chumbaq_actions` and
    // sets `categoryIdentifier` from inside the extension. An actions-only
    // campaign that never woke it showed no buttons at all.
    //
    // Carousel and timer are deliberately NOT here. Those are drawn by the
    // *content* extension, which is gated by `aps.category` matching its
    // `UNNotificationExtensionCategory` — `mutable-content` does nothing for
    // it. See the note on `iosCategory` for what the server cannot supply.
    //
    // Still not set for a plain notification: waking an extension with
    // nothing to do costs battery for no benefit.
    const hasImage = !message.silent && !!message.imageUrl;
    const needsServiceExtension =
      hasImage || (!message.silent && !!message.actions?.length);
    if (needsServiceExtension) aps['mutable-content'] = 1;

    const payload: Record<string, unknown> = {
      ...message.data,
      ...(hasImage ? { [IMAGE_DATA_KEY]: message.imageUrl } : {}),
      ...(message.deepLinkUrl
        ? { [DEEP_LINK_DATA_KEY]: message.deepLinkUrl }
        : {}),
      ...(message.campaignId
        ? { [CAMPAIGN_ID_DATA_KEY]: message.campaignId }
        : {}),
      // iOS builds buttons from a registered category rather than from these,
      // but they still travel: a tap is reported back against the action id,
      // and the per-action deep link is only in here.
      ...(message.actions?.length
        ? { [ACTIONS_DATA_KEY]: JSON.stringify(message.actions) }
        : {}),
      ...(message.carousel?.length
        ? { [CAROUSEL_DATA_KEY]: JSON.stringify(message.carousel) }
        : {}),
      ...(message.timer
        ? { [TIMER_DATA_KEY]: JSON.stringify(message.timer) }
        : {}),
      // Merged last so a caller-supplied key of the same name cannot displace
      // the one dictionary iOS itself reads. Losing it would turn every
      // notification in the campaign into an undeliverable payload.
      aps,
    };

    return JSON.stringify(payload);
  }

  private attemptSend(
    connection: ApnsConnection,
    token: string,
    headers: http2.OutgoingHttpHeaders,
    notificationId: string,
    jwt: string,
    payload: string,
  ): Promise<AttemptResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: AttemptResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let stream: http2.ClientHttp2Stream;
      try {
        stream = connection.open().request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          // Lower-case `bearer`, which is what Apple's examples use and what
          // its parser accepts.
          authorization: `bearer ${jwt}`,
          'apns-id': notificationId,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        });
      } catch (error) {
        // A session that went away between the check and the request. The next
        // attempt opens a fresh connection.
        settle({
          outcome: {
            kind: 'retryable',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }

      let status = 0;
      let body = '';

      stream.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status'] ?? 0);
      });
      stream.on('data', (chunk) => (body += chunk));
      stream.on('end', () => settle(this.classify(status, body)));

      // A stream error says nothing about whether the notification was
      // rejected, only that we never heard back — so it is always worth
      // another attempt.
      stream.on('error', (err: Error) => {
        settle({ outcome: { kind: 'retryable', error: err.message } });
      });

      // Per request rather than per session: a connection that stops answering
      // would otherwise park every lane of the page on it forever, and a
      // campaign that never finishes is worse than one that retries.
      stream.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        stream.destroy(
          new Error(`APNs request timed out after ${APNS_REQUEST_TIMEOUT_MS}ms`),
        );
      });

      stream.end(payload);
    });
  }

  /**
   * Turns one HTTP/2 response into an outcome.
   *
   * Unlike Mi Push, the status is the signal: APNs answers 200 only for a
   * notification it accepted, and puts a documented `reason` in the body of
   * everything else.
   */
  private classify(status: number, body: string): AttemptResult {
    if (status === 200) return { outcome: { kind: 'success' } };

    const reason = this.parseReason(body);
    const error = `APNs error ${status}${reason ? ` ${reason}` : ''}: ${body}`;

    if (reason && PROVIDER_TOKEN_REASONS.includes(reason)) {
      // Deliberately not a permanent per-token failure: the device is fine and
      // our key is not, so this must never reach `failures`.
      return { outcome: { kind: 'retryable', error }, providerTokenRejected: true };
    }

    if (this.isRetryableStatus(status)) {
      return { outcome: { kind: 'retryable', error } };
    }

    return {
      outcome: {
        kind: 'permanent',
        error,
        // Only for the three reasons Apple documents as meaning the token is
        // gone. An unrecognised reason carries no code, because the worker
        // deactivates on one and a live device counted as an uninstall is not
        // recoverable from.
        errorCode:
          reason && APNS_DEAD_TOKEN_REASONS.includes(reason)
            ? DEAD_TOKEN_ERROR_CODE
            : undefined,
      },
    };
  }

  /** 429 is Apple asking us to slow down; 5xx is Apple being unavailable. */
  private isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private parseReason(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body) as ApnsErrorBody;
      return typeof parsed.reason === 'string' ? parsed.reason : undefined;
    } catch {
      return undefined;
    }
  }

  private cacheKey(credentials: ResolvedCredentials): string {
    return `${credentials.keyId}|${credentials.teamId}`;
  }

  /**
   * The signed provider token, minted at most once every fifty minutes per key.
   *
   * Caching is not an optimisation here, it is correctness in both directions:
   * signing per request is what earns `429 TooManyProviderTokenUpdates`, and
   * never resigning is what earns `403 ExpiredProviderToken`. Signing is
   * synchronous, so unlike FCM's OAuth exchange there is no window for
   * concurrent lanes to race — the first one to find the cache cold fills it
   * before any other can look.
   */
  private providerToken(credentials: ResolvedCredentials): string {
    const key = this.cacheKey(credentials);
    const cached = this.tokenCache.get(key);
    if (cached && cached.refreshAt > Date.now()) return cached.jwt;

    const jwt = this.signProviderToken(credentials);
    this.tokenCache.set(key, { jwt, refreshAt: Date.now() + APNS_TOKEN_REFRESH_MS });
    return jwt;
  }

  /**
   * Discards `stale`, and only `stale`.
   *
   * A page runs sixteen requests at once, so a rejected token comes back
   * rejected sixteen times within milliseconds. Resigning once per rejection
   * is precisely what `TooManyProviderTokenUpdates` exists to punish, and the
   * lanes that already picked up the replacement have nothing to refresh.
   */
  private refreshProviderToken(
    credentials: ResolvedCredentials,
    stale: string,
  ): void {
    const key = this.cacheKey(credentials);
    if (this.tokenCache.get(key)?.jwt !== stale) return;
    this.tokenCache.delete(key);
  }

  /**
   * An ES256 JWT with no `exp`: Apple derives the lifetime from `iat` itself
   * and rejects a token carrying an expiry.
   */
  private signProviderToken(credentials: ResolvedCredentials): string {
    const header = this.base64UrlJson({ alg: 'ES256', kid: credentials.keyId });
    const claims = this.base64UrlJson({
      iss: credentials.teamId,
      iat: Math.floor(Date.now() / 1000),
    });
    const signingInput = `${header}.${claims}`;

    // `ieee-p1363` is load-bearing. Node signs ECDSA as DER by default, and a
    // DER signature in a JWS is silently invalid — JWS requires the raw r‖s
    // pair. The symptom is `InvalidProviderToken` on every single request,
    // which reads exactly like a wrong key.
    const signature = crypto
      .sign('sha256', Buffer.from(signingInput), {
        key: credentials.signingKey,
        dsaEncoding: 'ieee-p1363',
      })
      .toString('base64url');

    return `${signingInput}.${signature}`;
  }

  private base64UrlJson(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  /**
   * Cuts a header value that exceeds an Apple byte limit, and says so.
   *
   * The alternative is a 400 for every recipient in the campaign, so the
   * choice is between a shortened collapse id and no notification at all. The
   * cut is deterministic, so messages sharing a key still collapse together.
   */
  private fitBytes(value: string, limit: number, field: string): string {
    if (Buffer.byteLength(value) <= limit) return value;

    let out = '';
    let bytes = 0;
    for (const char of value) {
      // Stepped by code point so a multi-byte character is never cut in half
      // into a replacement character.
      const width = Buffer.byteLength(char);
      if (bytes + width > limit) break;
      out += char;
      bytes += width;
    }

    this.logger.warn(
      `APNs ${field} exceeded ${limit} bytes and was truncated (${Buffer.byteLength(
        value,
      )} given)`,
    );
    return out;
  }
}
