import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ChannelProvider,
  CampaignMessage,
  ChannelRecipient,
  ChannelSendResult,
  ChannelFailure,
  ChannelSendOptions,
  ACTIONS_DATA_KEY,
  CAROUSEL_DATA_KEY,
  TIMER_DATA_KEY,
  CAMPAIGN_ID_DATA_KEY,
  IMAGE_DATA_KEY,
} from './channel-provider';
import { SendOutcome, summariseOutcomes, runPool } from './channel-send';
import * as https from 'https';
import * as crypto from 'crypto';
import { logValue } from '../../../common/log-value';

import type {
  PushDeliveryOptions,
  PushAction,
} from '../entities/push-notification-log.entity';

export interface ServiceAccountCredentials {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

/**
 * FCM v1 has no batch endpoint — Google retired it in 2024 — so a page of
 * tokens is a page of individual HTTPS requests. Firing all of them at once is
 * what provokes the 429s that used to lose recipients, so in-flight requests
 * are capped and sockets are reused.
 */
export {
  ACTIONS_DATA_KEY,
  CAMPAIGN_ID_DATA_KEY,
} from './channel-provider';

export const FCM_MAX_CONCURRENT_SENDS = 16;

/** A hung socket would otherwise stall a campaign page indefinitely. */
export const FCM_REQUEST_TIMEOUT_MS = 10_000;

/** Attempts per token, including the first. */
export const FCM_MAX_SEND_ATTEMPTS = 3;

/** Base for exponential backoff between attempts at the same token. */
export const FCM_RETRY_BASE_DELAY_MS = 250;

/** Ignore an absurd Retry-After rather than parking a worker on it. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Renew an access token this long before it actually expires, so a token
 * cached at the start of a page cannot lapse part-way through it.
 */
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * Where every token exchange goes, whatever the service account says.
 *
 * token_uri is written by the tenant. Posting to it would let them point this
 * server at any internal HTTPS host and read the reply in the error, so it is
 * only checked against Google's known values and never used as an address.
 */
const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
const GOOGLE_TOKEN_PATH = '/token';
const GOOGLE_TOKEN_ENDPOINT = `https://${GOOGLE_TOKEN_HOST}${GOOGLE_TOKEN_PATH}`;

/**
 * token_uri values found in genuine Google service account keys. Current keys
 * carry the first; older keys carry accounts.google.com, and the v4 endpoint
 * appears in older client libraries' copies. All three are the same service,
 * and Google's own libraries send every key to oauth2.googleapis.com.
 * Compared as exact strings, so no parsing quirk can widen the list.
 */
const ACCEPTED_TOKEN_URIS: ReadonlySet<string> = new Set([
  GOOGLE_TOKEN_ENDPOINT,
  'https://www.googleapis.com/oauth2/v4/token',
  'https://accounts.google.com/o/oauth2/token',
]);

export const TOKEN_URI_REFUSED =
  "The service account's token_uri must be Google's token endpoint.";

/**
 * Google's token and send responses are a few hundred bytes. Anything bigger
 * is not one of them, and buffering it without limit is memory we never get
 * back.
 */
export const FCM_MAX_RESPONSE_BYTES = 64 * 1024;

/** How much of a response the server log keeps when explaining a failure. */
const LOGGED_BODY_CHARS = 500;

/** RFC 6749 error codes are short ASCII words; anything else is not one. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

interface CachedToken {
  value: Promise<string>;
  expiresAt: number;
  /** True until the exchange settles, so concurrent callers share one request
   *  instead of each starting their own. */
  pending: boolean;
}

@Injectable()
export class FcmProvider implements ChannelProvider {
  readonly provider = 'fcm' as const;

  private readonly logger = new Logger(FcmProvider.name);

  /**
   * Reusing sockets matters here: without keep-alive a page of 500 tokens is
   * 500 TLS handshakes against the same host.
   */
  private readonly agent = new https.Agent({
    keepAlive: true,
    maxSockets: FCM_MAX_CONCURRENT_SENDS,
  });

  private readonly tokenCache = new Map<string, CachedToken>();

  /** Sends one identical message to many tokens. */
  send(
    credentials: ServiceAccountCredentials,
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

  /**
   * Sends a per-recipient message.
   *
   * Personalised copy means the message differs per token, so the unit of work
   * is a (token, message) pair rather than one message and a token list. The
   * uniform case above is just every pair sharing one message object, which
   * costs nothing — FCM v1 has no batch endpoint, so these were always
   * separate requests.
   */
  async sendToRecipients(
    credentials: ServiceAccountCredentials,
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

    // Surfaced rather than swallowed: without credentials nothing can be sent,
    // and the campaign should fail loudly instead of reporting every token
    // as a delivery failure.
    await this.getAccessToken(credentials);

    const outcomes = new Array<SendOutcome>(recipients.length);
    await runPool(recipients.length, FCM_MAX_CONCURRENT_SENDS, async (i) => {
      outcomes[i] = await this.sendWithRetry(
        credentials,
        recipients[i].token,
        recipients[i].message,
        options,
      );
    });

    return this.summarise(
      recipients.map((r) => r.token),
      outcomes,
    );
  }

  /** Proves a service account can mint a messaging token. Throws if it cannot. */
  async validateCredentials(
    credentials: ServiceAccountCredentials,
  ): Promise<void> {
    assertGoogleTokenUri(credentials);
    assertClientEmail(credentials);
    this.tokenCache.delete(this.cacheKey(credentials));
    await this.getAccessToken(credentials);
  }

  /**
   * Aggregates per-token outcomes, stopping at the first token that is still
   * failing retryably.
   *
   * Tokens beyond that point are dropped from the result even when they
   * succeeded. Reporting them would tempt the caller into advancing its cursor
   * past the unresolved token, which is precisely the loss this guards
   * against; the cost is that a retry re-sends them, which is a duplicate
   * notification rather than a missing one.
   */
  private summarise(tokens: string[], outcomes: SendOutcome[]): ChannelSendResult {
    return summariseOutcomes(tokens, outcomes, this.logger, 'FCM');
  }

  /** Runs `task` over indices 0..count-1, at most `limit` at a time. */

  private async sendWithRetry(
    credentials: ServiceAccountCredentials,
    token: string,
    message: CampaignMessage,
    options: ChannelSendOptions,
  ): Promise<SendOutcome> {
    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= FCM_MAX_SEND_ATTEMPTS; attempt++) {
      // Re-read per attempt so a 401 that invalidated the cache below picks up
      // a fresh token on the next pass rather than replaying the stale one.
      const accessToken = await this.getAccessToken(credentials);
      const result = await this.attemptSend(
        credentials.project_id,
        accessToken,
        token,
        message,
        options,
      );

      if (result.outcome.kind !== 'retryable') return result.outcome;

      lastError = result.outcome.error;
      if (result.staleToken) this.tokenCache.delete(this.cacheKey(credentials));
      if (attempt === FCM_MAX_SEND_ATTEMPTS) break;

      await this.sleep(this.retryDelayMs(attempt, result.retryAfterMs));
    }

    return { kind: 'retryable', error: lastError };
  }

  /**
   * Exponential backoff with jitter, unless FCM named its own delay.
   * Overridable so tests are not paced by real sleeps.
   */
  protected retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    const base = FCM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * FCM_RETRY_BASE_DELAY_MS);
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve();
  }

  private attemptSend(
    projectId: string,
    accessToken: string,
    token: string,
    message: CampaignMessage,
    options: ChannelSendOptions,
  ): Promise<{
    outcome: SendOutcome;
    retryAfterMs?: number;
    staleToken?: boolean;
  }> {
    return new Promise((resolve) => {
      // An image on iOS is attached by the app's Notification Service
      // Extension, which reads IMAGE_DATA_KEY — `notification.image` alone
      // reaches Android and nothing else. See apnsConfig for the other half.
      const hasImage = !message.silent && !!message.imageUrl;

      // The image, campaign id and deep link are merged after the caller's
      // own `data` so a key of the same name cannot displace them — losing
      // the campaign id would detach the campaign from its own engagement
      // events.
      //
      // Built first and included only if it has keys, rather than guarded by
      // a condition listing which fields imply a data map. That list is one
      // more place to forget a key, and it has been wrong twice: it omitted
      // the image, so an image-only campaign had no map to carry it in, and
      // it still omitted carousel and timer, which only went unnoticed
      // because a real campaign always carries a `campaignId` and so always
      // made a map for other reasons.
      const entries: Record<string, string> = {
        ...(message.data as Record<string, string> | undefined),
        ...(hasImage ? { [IMAGE_DATA_KEY]: message.imageUrl! } : {}),
        ...(message.deepLinkUrl ? { deep_link_url: message.deepLinkUrl } : {}),
        ...(message.campaignId
          ? { [CAMPAIGN_ID_DATA_KEY]: message.campaignId }
          : {}),
        // Android builds its buttons locally, so the definitions have to
        // travel as data. FCM data values must be strings, hence JSON.
        ...(message.actions?.length
          ? { [ACTIONS_DATA_KEY]: JSON.stringify(message.actions) }
          : {}),
        ...(message.carousel?.length
          ? { [CAROUSEL_DATA_KEY]: JSON.stringify(message.carousel) }
          : {}),
        ...(message.timer
          ? { [TIMER_DATA_KEY]: JSON.stringify(message.timer) }
          : {}),
      };
      const data: Record<string, string> | undefined =
        Object.keys(entries).length > 0 ? entries : undefined;

      const payload = JSON.stringify({
        ...(options.dryRun ? { validate_only: true } : {}),
        message: {
          token,
          // A silent push carries no notification block at all. Including one
          // makes the OS display something no matter what else is set, so
          // there is no "silent notification" — only the absence of one.
          ...(message.silent
            ? {}
            : {
                notification: {
                  title: message.title,
                  body: message.body,
                  ...(message.imageUrl ? { image: message.imageUrl } : {}),
                },
              }),
          ...(data ? { data } : {}),
          ...this.androidConfig(message),
          ...this.apnsConfig(message),
          ...this.webpushConfig(message),
          // Groups the send under the campaign in Firebase's own reporting too,
          // which is the only cross-check available on FCM-side delivery.
          ...(message.campaignId
            ? { fcm_options: { analytics_label: message.campaignId } }
            : {}),
        },
      });

      const requestOptions: https.RequestOptions = {
        hostname: 'fcm.googleapis.com',
        // Encoded so a project_id cannot add path segments or a query and
        // steer the request at another endpoint on Google's host.
        path: `/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        method: 'POST',
        agent: this.agent,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const settle = (value: {
        outcome: SendOutcome;
        retryAfterMs?: number;
        staleToken?: boolean;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      };

      const req = https.request(requestOptions, (res) => {
        readCapped(req, res, (data) => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            settle({ outcome: { kind: 'success' } });
            return;
          }

          // Kept whole: the dashboard parses this envelope for its error
          // code, and Google pretty-prints it, so a cut one no longer parses.
          // readCapped already bounds it, and it comes from fcm.googleapis.com
          // about the tenant's own project, so it reveals nothing of ours.
          const error = `FCM error ${status}: ${data}`;
          if (this.isRetryableStatus(status)) {
            settle({
              outcome: { kind: 'retryable', error },
              retryAfterMs: this.parseRetryAfter(res.headers['retry-after']),
              staleToken: status === 401,
            });
          } else {
            settle({
              outcome: {
                kind: 'permanent',
                error,
                errorCode: this.parseErrorCode(data),
              },
            });
          }
        });
      });

      // A network error says nothing about whether the message was rejected,
      // only that we never heard back — so it is always worth another attempt.
      req.on('error', (err: Error) => {
        settle({ outcome: { kind: 'retryable', error: err.message } });
      });

      // setTimeout only notices a silent socket. The deadline also ends one
      // that keeps trickling bytes, which would otherwise hold a lane forever.
      const timedOut = () =>
        req.destroy(
          new Error(`FCM request timed out after ${FCM_REQUEST_TIMEOUT_MS}ms`),
        );
      req.setTimeout(FCM_REQUEST_TIMEOUT_MS, timedOut);
      deadline = setTimeout(timedOut, FCM_REQUEST_TIMEOUT_MS);
      deadline.unref();

      req.write(payload);
      req.end();
    });
  }

  /**
   * Android transport options.
   *
   * A silent push is forced to high priority: `normal` lets the device batch
   * delivery until it next wakes, which defeats the point of waking the app.
   */
  private androidConfig(message: CampaignMessage): Record<string, unknown> {
    const opts = message.options ?? {};
    const priority = message.silent ? 'high' : opts.priority;

    const notification =
      !message.silent && (opts.android?.channelId || opts.android?.sound)
        ? {
            notification: {
              ...(opts.android?.channelId
                ? { channel_id: opts.android.channelId }
                : {}),
              ...(opts.android?.sound ? { sound: opts.android.sound } : {}),
            },
          }
        : {};

    const android = {
      ...(priority ? { priority: priority.toUpperCase() } : {}),
      // FCM wants a duration string, not a number.
      ...(opts.ttlSeconds !== undefined ? { ttl: `${opts.ttlSeconds}s` } : {}),
      ...(opts.collapseKey ? { collapse_key: opts.collapseKey } : {}),
      ...notification,
    };

    return Object.keys(android).length > 0 ? { android } : {};
  }

  /**
   * APNs transport options.
   *
   * `content-available: 1` is what actually makes iOS hand a silent push to
   * the app; apns-priority 5 is required alongside it, because Apple rejects
   * a background push sent at priority 10.
   *
   * `mutable-content` is the same requirement APNs-direct has: without it iOS
   * delivers the notification and never wakes a Notification Service
   * Extension. FCM routes to Apple over APNs like anything else, so this is
   * needed whichever transport carries the campaign — and since APNs-direct
   * is idle on a missing `.p8`, FCM is the transport in practice.
   *
   * It gates everything that extension does, which is two jobs and not one:
   * attaching `chumbaq_image_url`, and registering a category from
   * `chumbaq_actions` so iOS has buttons to draw. Gating it on the image
   * alone meant an actions-only campaign never woke the extension and showed
   * no buttons.
   *
   * Carousel and timer are deliberately not here — those are the *content*
   * extension's, gated by `aps.category`, not by this flag.
   */
  private apnsConfig(message: CampaignMessage): Record<string, unknown> {
    const opts = message.options ?? {};
    const ios = opts.ios ?? {};

    const aps: Record<string, unknown> = {};
    if (message.silent) aps['content-available'] = 1;
    if (!message.silent && (message.imageUrl || message.actions?.length)) {
      aps['mutable-content'] = 1;
    }
    // A payload cannot define an iOS category, only name one. Naming it is
    // what matches a notification to the host app's *content* extension, so
    // a carousel or timer campaign has to set this or it renders as an
    // ordinary notification — the server has no way to guess a string
    // compiled into someone else's Info.plist.
    if (!message.silent && message.iosCategory) {
      aps.category = message.iosCategory;
    }
    if (!message.silent) {
      if (ios.sound) aps.sound = ios.sound;
      if (ios.badge !== undefined) aps.badge = ios.badge;
      if (ios.threadId) aps['thread-id'] = ios.threadId;
    }

    const headers: Record<string, string> = {};
    if (message.silent) headers['apns-priority'] = '5';
    else if (opts.priority === 'high') headers['apns-priority'] = '10';
    if (opts.ttlSeconds !== undefined) {
      headers['apns-expiration'] = String(
        Math.floor(Date.now() / 1000) + opts.ttlSeconds,
      );
    }
    if (opts.collapseKey) headers['apns-collapse-id'] = opts.collapseKey;

    const apns = {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(aps).length > 0 ? { payload: { aps } } : {}),
    };

    return Object.keys(apns).length > 0 ? { apns } : {};
  }

  /**
   * Web push options.
   *
   * Delivered through the same FCM v1 endpoint as mobile, so a browser
   * subscription is just another token — no separate VAPID plumbing.
   *
   * `webpush.fcm_options.link` is the only way a browser notification opens a
   * URL on click: unlike mobile, there is no app to receive a data payload and
   * route it, so a deep link that is not set here simply does nothing on the
   * web.
   */
  private webpushConfig(message: CampaignMessage): Record<string, unknown> {
    const web = message.options?.web ?? {};

    const notification = {
      ...(web.icon ? { icon: web.icon } : {}),
      ...(web.badge ? { badge: web.badge } : {}),
    };

    const headers = message.options?.ttlSeconds
      ? { TTL: String(message.options.ttlSeconds) }
      : {};

    const webpush = {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(notification).length > 0 ? { notification } : {}),
      ...(message.deepLinkUrl
        ? { fcm_options: { link: message.deepLinkUrl } }
        : {}),
    };

    return Object.keys(webpush).length > 0 ? { webpush } : {};
  }

  /**
   * 401 is here because the only way to get one after a successful token
   * exchange is a token that went stale mid-page; the retry re-mints it.
   * 403 is not — that is a misconfigured sender, and retrying never fixes it.
   */
  private isRetryableStatus(status: number): boolean {
    return status === 401 || status === 429 || status >= 500;
  }

  private parseRetryAfter(header: string | string[] | undefined): number | undefined {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }

  private parseErrorCode(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body);
      const details = parsed?.error?.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          if (typeof detail?.errorCode === 'string') return detail.errorCode;
        }
      }
      return typeof parsed?.error?.status === 'string'
        ? parsed.error.status
        : undefined;
    } catch {
      return undefined;
    }
  }

  private cacheKey(credentials: ServiceAccountCredentials): string {
    // No token_uri: every exchange goes to the same endpoint.
    return `${credentials.client_email}|${credentials.project_id}`;
  }

  /**
   * One token exchange per service account per hour, shared across every
   * concurrent send. `pending` keeps a page of 500 tokens from starting 16
   * simultaneous exchanges on a cold cache.
   */
  private getAccessToken(
    credentials: ServiceAccountCredentials,
  ): Promise<string> {
    const key = this.cacheKey(credentials);
    const cached = this.tokenCache.get(key);
    if (cached && (cached.pending || cached.expiresAt > Date.now())) {
      return cached.value;
    }

    const entry: CachedToken = {
      value: undefined as unknown as Promise<string>,
      expiresAt: 0,
      pending: true,
    };

    entry.value = this.requestAccessToken(credentials).then(
      ({ token, expiresInSec }) => {
        entry.pending = false;
        entry.expiresAt = Date.now() + expiresInSec * 1000 - TOKEN_EXPIRY_SKEW_MS;
        return token;
      },
      (error) => {
        // Never cache a failure — the next attempt must be free to retry.
        entry.pending = false;
        this.tokenCache.delete(key);
        throw error;
      },
    );

    this.tokenCache.set(key, entry);
    return entry.value;
  }

  private requestAccessToken(
    credentials: ServiceAccountCredentials,
  ): Promise<{ token: string; expiresInSec: number }> {
    return new Promise((resolve, reject) => {
      // Checked here as well as in validateCredentials, because rows stored
      // before the check existed reach sending without passing it.
      assertGoogleTokenUri(credentials);

      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
      ).toString('base64url');
      const claimSet = Buffer.from(
        JSON.stringify({
          iss: credentials.client_email,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          // The audience is the endpoint the assertion is presented to.
          aud: GOOGLE_TOKEN_ENDPOINT,
          iat: now,
          exp: now + 3600,
        }),
      ).toString('base64url');

      const signatureInput = `${header}.${claimSet}`;

      let privateKey = credentials.private_key;
      if (privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
      }

      const sign = crypto.createSign('RSA-SHA256');
      sign.update(signatureInput);
      const signature = sign.sign(privateKey, 'base64url');

      const jwt = `${signatureInput}.${signature}`;
      const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

      const options: https.RequestOptions = {
        hostname: GOOGLE_TOKEN_HOST,
        path: GOOGLE_TOKEN_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      let deadline: NodeJS.Timeout | undefined;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
      };
      const succeed = (value: { token: string; expiresInSec: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      };

      const req = https.request(options, (res) => {
        readCapped(req, res, (data) => {
          const status = res.statusCode ?? 0;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            this.logTokenFailure(credentials, status, data);
            fail(new Error(`Token exchange failed (HTTP ${status}, unreadable response)`));
            return;
          }

          const body = (parsed ?? {}) as Record<string, unknown>;
          if (typeof body.access_token === 'string' && body.access_token) {
            succeed({
              token: body.access_token,
              expiresInSec: Number(body.expires_in) || 3600,
            });
            return;
          }

          // The tenant sees the status and, when it is one, the OAuth error
          // code (invalid_grant and the like) — enough to act on. The rest of
          // the body stays in our log.
          this.logTokenFailure(credentials, status, data);
          const code =
            typeof body.error === 'string' && OAUTH_ERROR_CODE.test(body.error)
              ? `, ${body.error}`
              : '';
          fail(new Error(`Token exchange failed (HTTP ${status}${code})`));
        }, 'Token exchange failed (response too large)');
      });

      req.on('error', fail);
      // The idle timeout misses a server that trickles bytes; the deadline
      // bounds the whole exchange.
      const timedOut = () => req.destroy(new Error('FCM token exchange timed out'));
      req.setTimeout(FCM_REQUEST_TIMEOUT_MS, timedOut);
      deadline = setTimeout(timedOut, FCM_REQUEST_TIMEOUT_MS);
      deadline.unref();
      req.write(postData);
      req.end();
    });
  }

  /** What the tenant is not shown, kept for whoever debugs it. */
  private logTokenFailure(
    credentials: ServiceAccountCredentials,
    status: number,
    body: string,
  ): void {
    this.logger.warn(
      // client_email is the tenant's; rows stored before validation checked
      // it can hold anything, newlines included.
      // The body is whatever answered, so it is escaped the same way.
      `FCM token exchange failed for ${logValue(credentials.client_email)}: HTTP ${status} ${logValue(
        body,
        LOGGED_BODY_CHARS,
      )}`,
    );
  }
}

/**
 * A service account's client_email is always an address
 * (name@project.iam.gserviceaccount.com). Anything else is a key that was
 * edited or is not one, and it is the JWT issuer and goes in our logs.
 */
const CLIENT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_EMAIL_REFUSED = "The service account's client_email is not an email address.";

function assertClientEmail(credentials: ServiceAccountCredentials): void {
  const email: unknown = credentials.client_email;
  if (typeof email !== 'string' || email.length > 320 || !CLIENT_EMAIL.test(email)) {
    throw new BadRequestException(CLIENT_EMAIL_REFUSED);
  }
}

/**
 * Refuses a token_uri that is not one of Google's. Absent is fine: the
 * endpoint is fixed either way, and the field is only checked so a key aimed
 * somewhere else is refused instead of quietly sent to Google.
 */
function assertGoogleTokenUri(credentials: ServiceAccountCredentials): void {
  const tokenUri: unknown = credentials.token_uri;
  if (tokenUri === undefined || tokenUri === null) return;
  if (typeof tokenUri !== 'string' || !ACCEPTED_TOKEN_URIS.has(tokenUri)) {
    throw new BadRequestException(TOKEN_URI_REFUSED);
  }
}

/**
 * Collects a response body up to FCM_MAX_RESPONSE_BYTES, then calls `onBody`.
 * Past the cap it destroys the request instead, which surfaces as the
 * request's 'error' with `tooLargeMessage`, and `onBody` is never called.
 * Exported only so a test can run it over a real socket.
 */
export function readCapped(
  req: ReturnType<typeof https.request>,
  res: NodeJS.ReadableStream,
  onBody: (body: string) => void,
  tooLargeMessage = 'FCM response too large',
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;

  res.on('data', (chunk: Buffer | string) => {
    if (overflowed) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > FCM_MAX_RESPONSE_BYTES) {
      overflowed = true;
      chunks.length = 0;
      req.destroy(new Error(tooLargeMessage));
      return;
    }
    chunks.push(buffer);
  });
  // The request's own error handler reports the failure; this only stops a
  // destroyed response from throwing on a listener-less 'error'.
  res.on('error', () => undefined);
  res.on('end', () => {
    if (!overflowed) onBody(Buffer.concat(chunks).toString('utf8'));
  });
}
