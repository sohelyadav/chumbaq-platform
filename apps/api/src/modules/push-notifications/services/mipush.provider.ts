import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
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
  IMAGE_DATA_KEY,
  DEEP_LINK_DATA_KEY,
} from './channel-provider';
import { SendOutcome, summariseOutcomes, runPool } from './channel-send';

/**
 * Where the app's Mi Push data lives.
 *
 * Xiaomi shards by region and a regId only exists in the region its app was
 * registered in, so the wrong base URL is not a slow path — it is a total
 * failure for every real user of that app. It is therefore per-project
 * configuration rather than a constant.
 */
export type MiPushRegion = 'india' | 'global' | 'eea' | 'russia';

export const MI_PUSH_REGION_HOSTS: Record<MiPushRegion, string> = {
  india: 'idmb-api.xmpush.global.xiaomi.com',
  global: 'sgp-api.xmpush.global.xiaomi.com',
  /** EEA and the UK. */
  eea: 'fr-api.xmpush.global.xiaomi.com',
  russia: 'ru-api.xmpush.global.xiaomi.com',
};

export const MI_PUSH_DEFAULT_REGION: MiPushRegion = 'global';

export interface MiPushCredentials {
  /** The app secret from the Xiaomi console. Sent as `Authorization: key=…`. */
  appSecret: string;
  /** The host app's package name; Xiaomi rejects a send without it. */
  packageName: string;
  /** Defaults to `global`. */
  region?: MiPushRegion;
}

/**
 * Codes in Xiaomi's response that mean "this registration id is dead".
 *
 * DELIBERATELY EMPTY — DO NOT FILL THIS IN FROM GUESSWORK.
 *
 * Xiaomi does not publish which of its error codes mean the regId no longer
 * exists, and it is not recoverable from the docs. The campaign worker
 * deactivates every token whose failure carries a dead-token code, so the two
 * ways to be wrong here are both expensive: guess too broadly and live devices
 * are deactivated and counted as uninstalls, guess too narrowly and dead
 * tokens are never cleaned up.
 *
 * Until this is settled the provider reports every permanent Mi Push failure
 * WITHOUT a dead-token code, so nothing is ever deactivated on a guess. The
 * numeric code still reaches `failure.error`, which is where the evidence to
 * fill this in will come from.
 *
 * To settle it: send to a regId from an app that has been uninstalled from a
 * real Xiaomi device and record the `code` and `reason` that come back. That
 * needs a real device; nothing in this repo can answer it.
 */
export const MI_PUSH_DEAD_TOKEN_CODES: readonly number[] = [];

/**
 * The vocabulary the campaign worker deactivates on. Mi Push's own codes are
 * numbers and mean nothing to it, so a confirmed dead-token code is reported
 * under the same name FCM uses rather than as a second thing to match.
 */
const DEAD_TOKEN_ERROR_CODE = 'UNREGISTERED';

/** Mi Push takes one regId per request, so a page is a page of requests. */
export const MI_PUSH_MAX_CONCURRENT_SENDS = 16;

/** A hung socket would otherwise stall a campaign page indefinitely. */
export const MI_PUSH_REQUEST_TIMEOUT_MS = 10_000;

/** Attempts per token, including the first. */
export const MI_PUSH_MAX_SEND_ATTEMPTS = 3;

/** Base for exponential backoff between attempts at the same token. */
export const MI_PUSH_RETRY_BASE_DELAY_MS = 250;

/** Ignore an absurd Retry-After rather than parking a worker on it. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Xiaomi's hard limits. Anything longer is rejected outright. */
export const MI_PUSH_TITLE_MAX_LENGTH = 50;
export const MI_PUSH_DESCRIPTION_MAX_LENGTH = 128;

/** Appended to copy this provider had to cut, so a truncation is visible. */
const TRUNCATION_MARK = '…';

/** `notify_id` is a signed 32-bit integer. */
const MAX_NOTIFY_ID = 2147483647;

/** `extra.notify_effect` — open a URL on tap. */
const NOTIFY_EFFECT_OPEN_URL = '3';

const SEND_PATH = '/v3/message/regid';

/** Credentials after validation, with the region resolved to a host. */
interface ResolvedCredentials {
  appSecret: string;
  packageName: string;
  host: string;
}

/** The shape of Xiaomi's response envelope, as far as this provider reads it. */
interface MiPushResponse {
  result?: string;
  code?: number;
  description?: string;
  reason?: string;
}

/**
 * Delivers on Xiaomi's Mi Push.
 *
 * Exists because Xiaomi's OS throttles background FCM aggressively: on those
 * devices Mi Push is whitelisted and is the delivery that actually arrives.
 * The wire format is nothing like FCM's — form-encoded, one flat `payload`
 * string instead of a data map — but the campaign-visible behaviour is
 * identical, which is what the shared conformance suite pins down.
 */
@Injectable()
export class MiPushProvider implements ChannelProvider {
  readonly provider = 'mi_push' as const;

  private readonly logger = new Logger(MiPushProvider.name);

  /**
   * Reusing sockets matters here for the same reason it does on FCM: without
   * keep-alive a page of 500 regIds is 500 TLS handshakes against one host.
   */
  private readonly agent = new https.Agent({
    keepAlive: true,
    maxSockets: MI_PUSH_MAX_CONCURRENT_SENDS,
  });

  /** Sends one identical message to many regIds. */
  send(
    credentials: MiPushCredentials,
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
    credentials: MiPushCredentials,
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

    // Thrown rather than reported per token: with unusable credentials nothing
    // can be sent, and the campaign should fail loudly instead of recording a
    // delivery failure against every recipient it never attempted.
    const resolved = this.resolveCredentials(credentials);

    const outcomes = new Array<SendOutcome>(recipients.length);
    await runPool(recipients.length, MI_PUSH_MAX_CONCURRENT_SENDS, async (i) => {
      outcomes[i] = await this.sendWithRetry(
        resolved,
        recipients[i].token,
        recipients[i].message,
        options,
      );
    });

    return summariseOutcomes(
      recipients.map((r) => r.token),
      outcomes,
      this.logger,
      'Mi Push',
    );
  }

  /**
   * Checks the stored credentials are usable without contacting Xiaomi.
   *
   * There is no cheap Mi Push endpoint that says "this app secret is valid"
   * without also sending something, so this is a shape check: it catches the
   * paste that is missing half the form, which is the failure this exists to
   * prevent. A wrong-but-well-formed secret is only discoverable by sending.
   */
  async validateCredentials(credentials: MiPushCredentials): Promise<void> {
    this.resolveCredentials(credentials);
  }

  /**
   * Rejects anything that cannot address a Mi Push send, and resolves the
   * region to the host it must go to.
   *
   * Takes `unknown` because it is the boundary: this runs against whatever was
   * decrypted from storage or pasted into the dashboard, not against something
   * the type system has already vouched for.
   */
  private resolveCredentials(credentials: unknown): ResolvedCredentials {
    const candidate = (credentials ?? {}) as Partial<MiPushCredentials>;

    const appSecret =
      typeof candidate.appSecret === 'string' ? candidate.appSecret.trim() : '';
    const packageName =
      typeof candidate.packageName === 'string'
        ? candidate.packageName.trim()
        : '';

    const missing: string[] = [];
    if (!appSecret) missing.push('appSecret');
    if (!packageName) missing.push('packageName');
    if (missing.length > 0) {
      throw new BadRequestException(
        `Mi Push credentials are missing ${missing.join(' and ')}.`,
      );
    }

    const region = candidate.region ?? MI_PUSH_DEFAULT_REGION;
    const host = MI_PUSH_REGION_HOSTS[region];
    if (!host) {
      // Named regions rather than a free-form host: an unrecognised one would
      // otherwise become `undefined` in the request and fail every send with a
      // DNS error nobody can trace back to a typo in the console.
      throw new BadRequestException(
        `Unknown Mi Push region "${String(region)}". Expected one of: ${Object.keys(
          MI_PUSH_REGION_HOSTS,
        ).join(', ')}.`,
      );
    }

    return { appSecret, packageName, host };
  }

  private async sendWithRetry(
    credentials: ResolvedCredentials,
    token: string,
    message: CampaignMessage,
    options: ChannelSendOptions,
  ): Promise<SendOutcome> {
    // Encoded once and reused across attempts, so a retry cannot deliver a
    // different notify_id and show up as a second notification on a device
    // that did in fact receive the first.
    const body = this.encodeBody(credentials, token, message);

    // Mi Push has no validate-only mode. Delivering a real notification under
    // a flag whose entire purpose is not to deliver is the worse failure, so a
    // dry run stops here: the body above was built and encoded, which is the
    // only part that can be checked without sending. Unlike FCM this says
    // nothing about whether the regId is still valid.
    if (options.dryRun) return { kind: 'success' };

    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= MI_PUSH_MAX_SEND_ATTEMPTS; attempt++) {
      const result = await this.attemptSend(credentials, body);
      if (result.outcome.kind !== 'retryable') return result.outcome;

      lastError = result.outcome.error;
      if (attempt === MI_PUSH_MAX_SEND_ATTEMPTS) break;

      await this.sleep(this.retryDelayMs(attempt, result.retryAfterMs));
    }

    return { kind: 'retryable', error: lastError };
  }

  /**
   * Exponential backoff with jitter, unless Xiaomi named its own delay.
   * Overridable so tests are not paced by real sleeps.
   */
  protected retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    const base = MI_PUSH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * MI_PUSH_RETRY_BASE_DELAY_MS);
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve();
  }

  /**
   * Builds the form-encoded request body.
   *
   * `URLSearchParams` rather than hand-rolled escaping: `payload` is JSON with
   * `&`, `=` and `+` in it routinely, and one unescaped character silently
   * splits it into fields Xiaomi ignores.
   */
  private encodeBody(
    credentials: ResolvedCredentials,
    token: string,
    message: CampaignMessage,
  ): string {
    const form = new URLSearchParams();
    form.set('registration_id', token);
    form.set('restricted_package_name', credentials.packageName);

    // A pass-through message posts no notification at all, so title and
    // description have nowhere to render — the same reason the FCM provider
    // omits the notification block for a silent push.
    if (!message.silent) {
      form.set(
        'title',
        this.fit(message.title, MI_PUSH_TITLE_MAX_LENGTH, 'title'),
      );
      if (message.body) {
        form.set(
          'description',
          this.fit(message.body, MI_PUSH_DESCRIPTION_MAX_LENGTH, 'body'),
        );
      }
    }
    form.set('pass_through', message.silent ? '1' : '0');

    const payload = this.buildPayload(message);
    if (payload) form.set('payload', payload);

    const ttlSeconds = message.options?.ttlSeconds;
    // Mi Push counts TTL in milliseconds; passing seconds would expire a
    // one-hour message in under four seconds.
    if (ttlSeconds !== undefined) {
      form.set('time_to_live', String(ttlSeconds * 1000));
    }

    form.set('notify_id', String(this.notifyId(token, message)));

    for (const [key, value] of Object.entries(this.extras(message))) {
      form.set(`extra.${key}`, value);
    }

    // Mi Push shows no image, and cannot be made to.
    //
    // Xiaomi has no image parameter, and these are sent `pass_through=0`, which
    // means MIUI renders the notification itself from title and description —
    // the payload only reaches the app when the notification is tapped, long
    // after there is anything to decorate. Rendering it ourselves would mean
    // `pass_through=1`, which gives up the OS-level display that is the entire
    // reason for using Mi Push on these devices.
    //
    // The URL is still carried so a tap has it, but nothing on this channel
    // will show a picture.

    return form.toString();
  }

  /**
   * The single `payload` string.
   *
   * Mi Push carries one opaque string where FCM carries a key/value map, so
   * this is the FCM data map JSON-encoded — same keys, same string values,
   * including `chumbaq_actions` staying a JSON string inside the JSON. The
   * client SDKs already parse that map, and a Mi Push delivery that used a
   * different shape would not be recognised as the same campaign: its clicks
   * would be orphaned and its CTR unreportable.
   */
  private buildPayload(message: CampaignMessage): string | undefined {
    const hasContent =
      message.campaignId ||
      message.deepLinkUrl ||
      message.actions?.length ||
      message.data;
    if (!hasContent) return undefined;

    // Merged last so a caller-supplied key of the same name cannot displace
    // them — losing the campaign id detaches the campaign from its own
    // engagement events.
    const data: Record<string, string> = {
      ...message.data,
      ...(message.deepLinkUrl
        ? { [DEEP_LINK_DATA_KEY]: message.deepLinkUrl }
        : {}),
      ...(message.campaignId
        ? { [CAMPAIGN_ID_DATA_KEY]: message.campaignId }
        : {}),
      // Carried for the app to use after a tap, not to render the
      // notification — see the note above buildForm.
      ...(!message.silent && message.imageUrl
        ? { [IMAGE_DATA_KEY]: message.imageUrl }
        : {}),
      // Android builds its buttons locally from the payload, on Mi Push
      // exactly as on FCM, so nothing action-shaped is sent to Xiaomi itself.
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

    return JSON.stringify(data);
  }

  /** The `extra.*` fields, which is where Mi Push keeps everything optional. */
  private extras(message: CampaignMessage): Record<string, string> {
    const opts = message.options ?? {};
    const extras: Record<string, string> = {};

    // Nothing under `extra` describes a pass-through message: there is no
    // notification to give a tap behaviour, a channel or a sound. The deep
    // link still travels in the payload, which is how a silent push routes.
    if (message.silent) return extras;

    if (message.deepLinkUrl) {
      extras.notify_effect = NOTIFY_EFFECT_OPEN_URL;
      extras.web_uri = message.deepLinkUrl;
    }
    // Android 8+ drops a notification posted to no channel.
    if (opts.android?.channelId) extras.channel_id = opts.android.channelId;
    if (opts.android?.sound) extras.sound_uri = opts.android.sound;

    return extras;
  }

  /**
   * Cuts copy that exceeds a Mi Push limit, and says so in the log.
   *
   * The alternative is failing the send, which turns a copy-length mistake
   * into a recipient who receives nothing — and Xiaomi would reject the
   * request anyway, so the choice is between a shortened notification and no
   * notification. It is not silent: the cut is marked with an ellipsis on the
   * device and warned about here, because a marketer whose call to action was
   * removed needs to be able to find out why.
   */
  private fit(value: string, limit: number, field: string): string {
    if (value.length <= limit) return value;

    let out = '';
    for (const char of value) {
      // Counted in UTF-16 units, and stepped by code point so an emoji is
      // never cut in half into a replacement character.
      if (out.length + char.length > limit - TRUNCATION_MARK.length) break;
      out += char;
    }

    this.logger.warn(
      `Mi Push ${field} exceeded ${limit} characters and was truncated (${value.length} given)`,
    );
    return out + TRUNCATION_MARK;
  }

  /**
   * Mi Push's only collapse mechanism: a notification replaces any earlier one
   * on the device with the same `notify_id`.
   *
   * So a collapse key maps straight onto it, and everything else is keyed on
   * its own content — otherwise two unrelated campaigns arriving while the
   * shade is unread would silently overwrite each other.
   */
  private notifyId(token: string, message: CampaignMessage): number {
    const collapseKey = message.options?.collapseKey;
    const seed = collapseKey
      ? `collapse:${collapseKey}`
      : `${token}:${message.campaignId ?? ''}:${message.title}:${message.body ?? ''}`;
    return this.hash31(seed);
  }

  /** FNV-1a, masked to 31 bits because `notify_id` is a signed 32-bit int. */
  private hash31(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % (MAX_NOTIFY_ID + 1);
  }

  private attemptSend(
    credentials: ResolvedCredentials,
    body: string,
  ): Promise<{ outcome: SendOutcome; retryAfterMs?: number }> {
    return new Promise((resolve) => {
      const requestOptions: https.RequestOptions = {
        hostname: credentials.host,
        path: SEND_PATH,
        method: 'POST',
        agent: this.agent,
        headers: {
          // Lower-case `key=`, which is what Xiaomi matches on — `Key=` is
          // rejected as unauthorised.
          Authorization: `key=${credentials.appSecret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      let settled = false;
      const settle = (value: {
        outcome: SendOutcome;
        retryAfterMs?: number;
      }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const req = https.request(requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          settle({
            ...this.classify(status, data),
            retryAfterMs: this.parseRetryAfter(res.headers['retry-after']),
          });
        });
      });

      // A network error says nothing about whether the message was rejected,
      // only that we never heard back — so it is always worth another attempt.
      req.on('error', (err: Error) => {
        settle({ outcome: { kind: 'retryable', error: err.message } });
      });

      req.setTimeout(MI_PUSH_REQUEST_TIMEOUT_MS, () => {
        req.destroy(
          new Error(
            `Mi Push request timed out after ${MI_PUSH_REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Turns one HTTP response into an outcome.
   *
   * A 200 is not a delivery: Xiaomi answers most rejections with 200 and an
   * error in the envelope, so `code` is the signal and the status only decides
   * whether it is worth trying again.
   */
  private classify(status: number, body: string): { outcome: SendOutcome } {
    if (status < 200 || status >= 300) {
      const error = `Mi Push HTTP ${status}: ${body}`;
      // 401/403 is a wrong app secret or a package the secret does not cover.
      // Retrying never fixes either, and doing so burns the whole page.
      return this.isRetryableStatus(status)
        ? { outcome: { kind: 'retryable', error } }
        : { outcome: { kind: 'permanent', error } };
    }

    let parsed: MiPushResponse;
    try {
      parsed = JSON.parse(body) as MiPushResponse;
    } catch {
      // A 200 we cannot read leaves the outcome genuinely unknown — an
      // intercepting proxy answering with HTML looks exactly like this. Worth
      // another attempt rather than recorded as a failure that never happened.
      return {
        outcome: {
          kind: 'retryable',
          error: `Mi Push returned an unreadable response: ${body}`,
        },
      };
    }

    if (parsed.code === 0) return { outcome: { kind: 'success' } };

    const code = typeof parsed.code === 'number' ? parsed.code : undefined;
    const detail = parsed.reason || parsed.description || body;
    return {
      outcome: {
        kind: 'permanent',
        error: `Mi Push error ${code ?? 'unknown'}: ${detail}`,
        // Undefined unless the code is a confirmed dead token, which today
        // means always undefined. See MI_PUSH_DEAD_TOKEN_CODES: deactivating a
        // live device on a guessed code counts a real user as an uninstall.
        errorCode:
          code !== undefined && MI_PUSH_DEAD_TOKEN_CODES.includes(code)
            ? DEAD_TOKEN_ERROR_CODE
            : undefined,
      },
    };
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private parseRetryAfter(
    header: string | string[] | undefined,
  ): number | undefined {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }
}
