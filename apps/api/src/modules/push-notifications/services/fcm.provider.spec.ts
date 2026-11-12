jest.mock('https', () => ({
  request: jest.fn(),
  Agent: class {
    constructor(public options: unknown) {}
  },
}));

import * as https from 'https';
import { EventEmitter } from 'events';
import { BadRequestException } from '@nestjs/common';
import {
  FcmProvider,
  FCM_MAX_CONCURRENT_SENDS,
  FCM_MAX_RESPONSE_BYTES,
  FCM_REQUEST_TIMEOUT_MS,
  ServiceAccountCredentials,
} from './fcm.provider';
import {
  IMAGE_DATA_KEY,
  ACTIONS_DATA_KEY,
  CAROUSEL_DATA_KEY,
} from './channel-provider';
import { describeChannelProviderConformance } from './channel-provider.conformance';

// A 2048-bit key is required because getAccessToken signs the OAuth assertion
// with RSA-SHA256 before any request is made.
import * as crypto from 'crypto';
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** What the fake transport should do for one request. */
type Reply =
  | {
      status: number;
      body: string;
      headers?: Record<string, string>;
      /** Delivers the body in these pieces instead of one 'data' event. */
      chunks?: string[];
    }
  | { timeout: true }
  /** Accepts the request and never answers, nor fires the idle timeout:
   *  a server that trickles bytes slowly enough to keep the socket busy. */
  | { hang: true }
  | { networkError: string };

interface SendContext {
  /** The device token this request targets. */
  token: string;
  /** 1 for the first attempt at this token, 2 for the first retry, and so on. */
  attempt: number;
  /** Whether the request body asked FCM to validate without delivering. */
  validateOnly: boolean;
}

interface Stub {
  /** Every `https.request` options object, in call order. */
  calls: https.RequestOptions[];
  /** Parsed JSON bodies of the FCM send requests, in call order. */
  sendBodies: any[];
  /** How many OAuth token exchanges were performed. */
  tokenExchanges: number;
  /** High-water mark of simultaneously open FCM send requests. */
  maxConcurrent: number;
  /** Whether each request, in call order, was destroyed. */
  destroyed: boolean[];
}

/**
 * Fake `https.request` that routes by hostname: the OAuth host gets
 * `tokenReply`, and every FCM send is answered by `sendReply`, which receives
 * the token and that token's attempt number so a test can fail a request once
 * and then let it through.
 */
function stubHttps(opts: {
  tokenReply?: Reply;
  sendReply?: (ctx: SendContext) => Reply;
}): Stub {
  const stub: Stub = {
    calls: [],
    sendBodies: [],
    tokenExchanges: 0,
    maxConcurrent: 0,
    destroyed: [],
  };
  const attemptsByToken = new Map<string, number>();
  let inFlight = 0;

  (https.request as unknown as jest.Mock).mockImplementation(
    ((options: https.RequestOptions, cb: any) => {
      stub.calls.push(options);
      const index = stub.destroyed.push(false) - 1;
      const isTokenExchange = options.hostname !== 'fcm.googleapis.com';
      if (isTokenExchange) stub.tokenExchanges++;

      const req = new EventEmitter() as any;
      let written = '';
      let timeoutHandler: (() => void) | undefined;
      let destroyed = false;

      req.write = jest.fn((chunk: string) => {
        written += chunk;
      });
      req.setTimeout = jest.fn((_ms: number, handler: () => void) => {
        timeoutHandler = handler;
        return req;
      });
      req.destroy = jest.fn((err?: Error) => {
        if (destroyed) return;
        destroyed = true;
        stub.destroyed[index] = true;
        process.nextTick(() => req.emit('error', err ?? new Error('destroyed')));
      });

      req.end = jest.fn(() => {
        let reply: Reply;

        if (isTokenExchange) {
          reply = opts.tokenReply ?? {
            status: 200,
            body: JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
          };
        } else {
          const parsed = JSON.parse(written);
          stub.sendBodies.push(parsed);
          const token = parsed.message.token;
          const attempt = (attemptsByToken.get(token) ?? 0) + 1;
          attemptsByToken.set(token, attempt);

          inFlight++;
          stub.maxConcurrent = Math.max(stub.maxConcurrent, inFlight);

          reply = opts.sendReply
            ? opts.sendReply({
                token,
                attempt,
                validateOnly: parsed.validate_only === true,
              })
            : { status: 200, body: '{}' };
        }

        process.nextTick(() => {
          if (!isTokenExchange) inFlight--;

          if ('timeout' in reply) {
            timeoutHandler?.();
            return;
          }
          if ('hang' in reply) return;
          if ('networkError' in reply) {
            req.emit('error', new Error(reply.networkError));
            return;
          }

          const res = new EventEmitter() as any;
          res.statusCode = reply.status;
          res.headers = reply.headers ?? {};
          cb(res);
          // Like a real socket, nothing more arrives once the request is
          // destroyed, so a reader that stops at a cap really stops.
          for (const chunk of reply.chunks ?? [reply.body]) {
            if (destroyed) return;
            res.emit('data', chunk);
          }
          if (!destroyed) res.emit('end');
        });
      });

      return req;
    }) as never,
  );

  return stub;
}

/** FCM v1's error envelope for a token that is no longer registered. */
const UNREGISTERED_BODY = JSON.stringify({
  error: {
    code: 404,
    message: 'Requested entity was not found.',
    status: 'NOT_FOUND',
    details: [
      {
        '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
        errorCode: 'UNREGISTERED',
      },
    ],
  },
});

/** Retries are real awaits, so tests use a provider whose backoff is zero. */
class TestFcmProvider extends FcmProvider {
  protected retryDelayMs(): number {
    return 0;
  }
}

describe('FcmProvider', () => {
  let provider: FcmProvider;

  const baseCredentials = {
    project_id: 'proj',
    private_key: privateKey as string,
    client_email: 'sa@example.iam.gserviceaccount.com',
  };

  const creds = baseCredentials as ServiceAccountCredentials;

  beforeEach(() => {
    (https.request as unknown as jest.Mock).mockReset();
    provider = new TestFcmProvider();
  });

  describe('send', () => {
    it('returns an empty result without any request when there are no tokens', async () => {
      const stub = stubHttps({});

      await expect(provider.send(creds, [], { title: 't' })).resolves.toEqual({
        successCount: 0,
        failureCount: 0,
        failures: [],
        resolvedCount: 0,
        retryReason: null,
      });

      expect(stub.calls).toHaveLength(0);
    });

    it('reports every token as resolved when all succeed', async () => {
      stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      const result = await provider.send(creds, ['a', 'b', 'c'], { title: 't' });

      expect(result).toMatchObject({
        successCount: 3,
        failureCount: 0,
        failures: [],
        resolvedCount: 3,
        retryReason: null,
      });
    });

    it('never opens more concurrent requests than the configured cap', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });
      const tokens = Array.from({ length: 200 }, (_, i) => `token-${i}`);

      await provider.send(creds, tokens, { title: 't' });

      // The old implementation fired all 200 at once via Promise.all, which is
      // what provoked the FCM rate limiting that then lost recipients.
      expect(stub.maxConcurrent).toBeLessThanOrEqual(FCM_MAX_CONCURRENT_SENDS);
      expect(stub.maxConcurrent).toBeGreaterThan(1);
    });
  });

  describe('retrying transient failures', () => {
    it('retries a 429 and counts the eventual success', async () => {
      stubHttps({
        sendReply: ({ attempt }) =>
          attempt === 1
            ? { status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }
            : { status: 200, body: '{}' },
      });

      const result = await provider.send(creds, ['a'], { title: 't' });

      expect(result).toMatchObject({
        successCount: 1,
        failureCount: 0,
        resolvedCount: 1,
        retryReason: null,
      });
    });

    it('retries a 503 and a socket error', async () => {
      stubHttps({
        sendReply: ({ token, attempt }) => {
          if (attempt > 1) return { status: 200, body: '{}' };
          return token === 'a'
            ? { status: 503, body: 'unavailable' }
            : { networkError: 'ECONNRESET' };
        },
      });

      const result = await provider.send(creds, ['a', 'b'], { title: 't' });

      expect(result.successCount).toBe(2);
      expect(result.resolvedCount).toBe(2);
    });

    it('treats a request timeout as retryable', async () => {
      stubHttps({
        sendReply: ({ attempt }) =>
          attempt === 1 ? { timeout: true } : { status: 200, body: '{}' },
      });

      const result = await provider.send(creds, ['a'], { title: 't' });

      expect(result.successCount).toBe(1);
      expect(result.retryReason).toBeNull();
    });

    it('stops the resolved run at a token that is still failing retryably', async () => {
      stubHttps({
        sendReply: ({ token }) =>
          token === 'b'
            ? { status: 429, body: 'slow down' }
            : { status: 200, body: '{}' },
      });

      const result = await provider.send(creds, ['a', 'b', 'c'], { title: 't' });

      // 'a' is final, 'b' is not, so the caller may only checkpoint 'a'. 'c'
      // may well have succeeded, but claiming it would let the campaign's
      // cursor jump over 'b' and drop that recipient permanently.
      expect(result.resolvedCount).toBe(1);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);
      expect(result.retryReason).toMatch(/429/);
    });

    it('gives up after the attempt cap rather than retrying forever', async () => {
      const stub = stubHttps({
        sendReply: () => ({ status: 429, body: 'slow down' }),
      });

      const result = await provider.send(creds, ['a'], { title: 't' });

      expect(result.resolvedCount).toBe(0);
      expect(result.retryReason).toMatch(/429/);
      // One token, three attempts, plus the single token exchange.
      expect(stub.calls).toHaveLength(4);
    });
  });

  describe('permanent failures', () => {
    it('resolves an unregistered token immediately without retrying', async () => {
      const stub = stubHttps({
        sendReply: () => ({ status: 404, body: UNREGISTERED_BODY }),
      });

      const result = await provider.send(creds, ['stale'], { title: 't' });

      expect(result.resolvedCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.retryReason).toBeNull();
      expect(result.failures[0]).toMatchObject({
        token: 'stale',
        errorCode: 'UNREGISTERED',
        retryable: false,
      });
      // Token exchange + exactly one send: a dead token must not be retried.
      expect(stub.calls).toHaveLength(2);
    });

    it('treats a malformed message (400) as permanent', async () => {
      stubHttps({
        sendReply: () => ({
          status: 400,
          body: '{"error":{"status":"INVALID_ARGUMENT"}}',
        }),
      });

      const result = await provider.send(creds, ['a'], { title: 't' });

      expect(result.resolvedCount).toBe(1);
      expect(result.failures[0]).toMatchObject({
        retryable: false,
        errorCode: 'INVALID_ARGUMENT',
      });
    });

    it('keeps failing tokens resolved so the campaign can move past them', async () => {
      stubHttps({
        sendReply: ({ token }) =>
          token === 'dead'
            ? { status: 404, body: UNREGISTERED_BODY }
            : { status: 200, body: '{}' },
      });

      const result = await provider.send(creds, ['ok1', 'dead', 'ok2'], {
        title: 't',
      });

      expect(result.resolvedCount).toBe(3);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
    });
  });

  describe('deep links and platform options', () => {
    const send = async (msg: any) => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });
      await provider.send(creds, ['a'], msg);
      return stub.sendBodies[0].message;
    };

    it('emits the deep link under the key the SDKs read', async () => {
      const m = await send({ title: 't', deepLinkUrl: '/offers/42' });

      // The Android handler already routes taps from `deep_link_url`, so this
      // key is a contract, not a naming preference.
      expect(m.data).toMatchObject({ deep_link_url: '/offers/42' });
    });

    it('maps priority, ttl and collapse key onto the android block', async () => {
      const m = await send({
        title: 't',
        options: { priority: 'high', ttlSeconds: 3600, collapseKey: 'sale' },
      });

      expect(m.android).toMatchObject({
        priority: 'HIGH',
        // FCM wants a duration string here, not a number.
        ttl: '3600s',
        collapse_key: 'sale',
      });
    });

    it('carries the android notification channel, without which Android 8+ drops it', async () => {
      const m = await send({
        title: 't',
        options: { android: { channelId: 'promotions', sound: 'ping' } },
      });

      expect(m.android.notification).toEqual({
        channel_id: 'promotions',
        sound: 'ping',
      });
    });

    it('maps iOS sound, badge and thread id into the aps payload', async () => {
      const m = await send({
        title: 't',
        options: { ios: { sound: 'ping.caf', badge: 3, threadId: 'orders' } },
      });

      expect(m.apns.payload.aps).toEqual({
        sound: 'ping.caf',
        badge: 3,
        'thread-id': 'orders',
      });
    });

    it('sets apns-expiration as an absolute time, not a duration', async () => {
      const before = Math.floor(Date.now() / 1000);
      const m = await send({ title: 't', options: { ttlSeconds: 600 } });

      // Apple wants a UNIX timestamp; sending 600 would expire the push in 1970.
      const exp = Number(m.apns.headers['apns-expiration']);
      expect(exp).toBeGreaterThanOrEqual(before + 600);
      expect(exp).toBeLessThan(before + 610);
    });

    it('adds no platform blocks when no options are given', async () => {
      const m = await send({ title: 't' });

      expect(m.android).toBeUndefined();
      expect(m.apns).toBeUndefined();
    });
  });

  describe('campaign images', () => {
    const send = async (msg: any) => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });
      await provider.send(creds, ['a'], msg);
      return stub.sendBodies[0].message;
    };

    /**
     * `notification.image` is enough for Android and reaches iOS as nothing
     * at all: Apple has no image field, so the picture is attached by the
     * app's Notification Service Extension, which reads `chumbaq_image_url`
     * and is only ever woken when `mutable-content` is set. FCM sent neither,
     * so every rich campaign landed on iOS as plain text — and since
     * APNs-direct is blocked on a missing `.p8`, FCM is the only transport,
     * which made that every rich campaign full stop. The APNs provider had
     * both halves all along; this is the same payload over the other wire.
     */
    it('carries both halves of an iOS image, not just notification.image', async () => {
      const m = await send({ title: 't', imageUrl: 'https://cdn.test/a.png' });

      expect(m.notification.image).toBe('https://cdn.test/a.png');
      expect(m.data).toMatchObject({
        chumbaq_image_url: 'https://cdn.test/a.png',
      });
      expect(m.apns.payload.aps).toMatchObject({ 'mutable-content': 1 });
    });

    it('sends the image data key even when nothing else would make a data map', async () => {
      // The data map used to be built only for a campaign id, deep link,
      // actions or caller data, so an image-only campaign had no map to put
      // the URL in.
      const m = await send({ title: 't', imageUrl: 'https://cdn.test/a.png' });

      expect(Object.keys(m.data)).toEqual(['chumbaq_image_url']);
    });

    it('uses the same key as the APNs and Mi Push providers', async () => {
      // A device cannot tell which channel carried the campaign, so a
      // divergence here means the SDK stops recognising its own payload.
      const m = await send({ title: 't', imageUrl: 'https://cdn.test/a.png' });

      expect(m.data[IMAGE_DATA_KEY]).toBe('https://cdn.test/a.png');
    });

    /**
     * The same two-job extension as APNs direct, over the transport that is
     * actually in use: `mutable-content` gates both attaching the image and
     * registering a category from `chumbaq_actions`, so an actions-only
     * campaign woke nothing and drew no buttons.
     */
    it('wakes the extension for an actions-only campaign', async () => {
      const m = await send({
        title: 't',
        actions: [{ id: 'buy', title: 'Buy now' }],
      });

      expect(m.apns.payload.aps).toMatchObject({ 'mutable-content': 1 });
      expect(m.data[ACTIONS_DATA_KEY]).toBeDefined();
      expect(m.data[IMAGE_DATA_KEY]).toBeUndefined();
    });

    it('wakes the extension once when a campaign has both an image and actions', async () => {
      const m = await send({
        title: 't',
        imageUrl: 'https://cdn.test/a.png',
        actions: [{ id: 'buy', title: 'Buy now' }],
      });

      expect(m.apns.payload.aps['mutable-content']).toBe(1);
      expect(m.data[IMAGE_DATA_KEY]).toBe('https://cdn.test/a.png');
      expect(m.data[ACTIONS_DATA_KEY]).toBeDefined();
    });

    it('does not wake the extension for a carousel, which is the content extension’s', async () => {
      const m = await send({
        title: 't',
        carousel: [
          { imageUrl: 'https://cdn.test/1.png' },
          { imageUrl: 'https://cdn.test/2.png' },
        ],
      });

      // Drawn by the notification *content* extension, matched on
      // `aps.category` against its UNNotificationExtensionCategory.
      // `mutable-content` does nothing for it.
      expect(m.apns?.payload?.aps?.['mutable-content']).toBeUndefined();
      expect(m.data[CAROUSEL_DATA_KEY]).toBeDefined();
    });

    it('does not wake an extension for an actions-only silent push', async () => {
      const m = await send({
        title: 't',
        silent: true,
        actions: [{ id: 'buy', title: 'Buy now' }],
      });

      expect(m.apns.payload.aps['mutable-content']).toBeUndefined();
    });

    it('wakes no extension when there is no image', async () => {
      const m = await send({ title: 't' });

      expect(m.apns).toBeUndefined();
      expect(m.data).toBeUndefined();
    });

    it('wakes no extension for a silent push carrying an image', async () => {
      // A silent push has no notification to decorate, and waking an
      // extension to attach a picture nothing will show costs battery.
      const m = await send({
        title: 't',
        silent: true,
        imageUrl: 'https://cdn.test/a.png',
      });

      expect(m.apns.payload.aps['mutable-content']).toBeUndefined();
      expect(m.data?.chumbaq_image_url).toBeUndefined();
    });

    it('leaves a caller-supplied data map intact alongside the image', async () => {
      const m = await send({
        title: 't',
        imageUrl: 'https://cdn.test/a.png',
        data: { screen: 'offers' },
      });

      expect(m.data).toMatchObject({
        screen: 'offers',
        chumbaq_image_url: 'https://cdn.test/a.png',
      });
    });
  });

  describe('action buttons', () => {
    const send = async (msg: any) => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });
      await provider.send(creds, ['a'], msg);
      return stub.sendBodies[0].message;
    };

    it('carries the action definitions as data for Android to render', async () => {
      const actions = [
        { id: 'buy', title: 'Buy now', deepLinkUrl: '/checkout' },
        { id: 'later', title: 'Remind me' },
      ];
      const m = await send({ title: 't', actions });

      // Android builds its buttons locally, so the definitions must travel in
      // the payload — and FCM data values are strings, hence JSON.
      expect(JSON.parse(m.data.chumbaq_actions)).toEqual(actions);
    });

    it('names an APNs category for iOS instead of sending buttons', async () => {
      const m = await send({ title: 't', iosCategory: 'ORDER_ACTIONS' });

      // iOS can only show actions from a category the app registered at
      // launch; a payload cannot define them.
      expect(m.apns.payload.aps.category).toBe('ORDER_ACTIONS');
    });

    it('omits the category on a silent push, which shows nothing', async () => {
      const m = await send({ title: 't', silent: true, iosCategory: 'X' });
      expect(m.apns.payload.aps.category).toBeUndefined();
    });

    it('adds nothing when a campaign has no actions', async () => {
      const m = await send({ title: 't' });
      expect(m.data).toBeUndefined();
      expect(m.apns).toBeUndefined();
    });

    it('keeps actions alongside the campaign id and deep link', async () => {
      const m = await send({
        title: 't',
        campaignId: 'c1',
        deepLinkUrl: '/x',
        actions: [{ id: 'a', title: 'A' }],
      });

      expect(m.data.chumbaq_campaign_id).toBe('c1');
      expect(m.data.deep_link_url).toBe('/x');
      expect(m.data.chumbaq_actions).toBeDefined();
    });
  });

  describe('web push', () => {
    const send = async (msg: any) => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });
      await provider.send(creds, ['a'], msg);
      return stub.sendBodies[0].message;
    };

    it('sets fcm_options.link, the only way a browser opens a URL on click', async () => {
      const m = await send({ title: 't', deepLinkUrl: 'https://example.com/x' });

      // On the web there is no app to receive a data payload and route it, so
      // a deep link not set here simply does nothing.
      expect(m.webpush.fcm_options).toEqual({ link: 'https://example.com/x' });
    });

    it('carries icon and badge', async () => {
      const m = await send({
        title: 't',
        options: { web: { icon: 'https://x/i.png', badge: 'https://x/b.png' } },
      });

      expect(m.webpush.notification).toEqual({
        icon: 'https://x/i.png',
        badge: 'https://x/b.png',
      });
    });

    it('passes TTL as the webpush header, which is seconds as a string', async () => {
      const m = await send({ title: 't', options: { ttlSeconds: 600 } });
      expect(m.webpush.headers).toEqual({ TTL: '600' });
    });

    it('adds no webpush block when nothing web-specific applies', async () => {
      const m = await send({ title: 't' });
      expect(m.webpush).toBeUndefined();
    });

    it('does not disturb the android or apns blocks', async () => {
      const m = await send({
        title: 't',
        deepLinkUrl: 'https://example.com/x',
        options: { priority: 'high', ios: { badge: 1 } },
      });

      // One message carries all three platform blocks; FCM applies whichever
      // matches the token.
      expect(m.android.priority).toBe('HIGH');
      expect(m.apns.payload.aps.badge).toBe(1);
      expect(m.webpush.fcm_options.link).toBe('https://example.com/x');
    });
  });

  describe('silent push', () => {
    const send = async (msg: any) => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });
      await provider.send(creds, ['a'], msg);
      return stub.sendBodies[0].message;
    };

    it('omits the notification block entirely', async () => {
      const m = await send({ title: 't', body: 'b', silent: true });

      // There is no such thing as a silent notification: if the block is
      // present the OS displays something regardless of anything else.
      expect(m.notification).toBeUndefined();
    });

    it('sets content-available so iOS hands it to the app', async () => {
      const m = await send({ title: 't', silent: true });

      expect(m.apns.payload.aps).toEqual({ 'content-available': 1 });
    });

    it('sends a background push at apns-priority 5, which Apple requires', async () => {
      const m = await send({ title: 't', silent: true });

      // Apple rejects a content-available push sent at priority 10.
      expect(m.apns.headers['apns-priority']).toBe('5');
    });

    it('forces android priority high so delivery is not batched', async () => {
      const m = await send({ title: 't', silent: true, options: { priority: 'normal' } });

      // `normal` lets the device defer until it next wakes, which defeats the
      // point of waking the app.
      expect(m.android.priority).toBe('HIGH');
    });

    it('still carries data, which is the entire point', async () => {
      const m = await send({
        title: 't',
        silent: true,
        data: { sync: 'inbox' },
        campaignId: 'camp-1',
      });

      expect(m.data).toEqual({ sync: 'inbox', chumbaq_campaign_id: 'camp-1' });
    });

    it('drops iOS presentation options that cannot apply to a silent push', async () => {
      const m = await send({
        title: 't',
        silent: true,
        options: { ios: { sound: 'ping', badge: 2 } },
      });

      // A sound on a background push is a contradiction; including it risks
      // APNs rejecting the whole message.
      expect(m.apns.payload.aps).toEqual({ 'content-available': 1 });
    });
  });

  describe('access token caching', () => {
    it('exchanges the token once across several sends', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], { title: 't' });
      await provider.send(creds, ['b'], { title: 't' });
      await provider.send(creds, ['c'], { title: 't' });

      expect(stub.tokenExchanges).toBe(1);
    });

    it('does not share a cached token between different service accounts', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], { title: 't' });
      await provider.send(
        { ...baseCredentials, client_email: 'other@x.iam.gserviceaccount.com' },
        ['b'],
        { title: 't' },
      );

      expect(stub.tokenExchanges).toBe(2);
    });

    it('re-exchanges once the cached token has expired', async () => {
      const stub = stubHttps({
        tokenReply: {
          status: 200,
          body: JSON.stringify({ access_token: 'tok', expires_in: 1 }),
        },
        sendReply: () => ({ status: 200, body: '{}' }),
      });

      await provider.send(creds, ['a'], { title: 't' });
      const afterFirstSend = stub.tokenExchanges;
      await provider.send(creds, ['b'], { title: 't' });

      // expires_in is under the safety margin, so the token is never reused.
      // Asserting "more than before" rather than an exact count: the healthy
      // path is pinned to exactly one exchange by the test above, which is
      // where a caching regression would actually show up.
      expect(stub.tokenExchanges).toBeGreaterThan(afterFirstSend);
    });

    it('drops the cached token when FCM rejects it as unauthorised', async () => {
      const stub = stubHttps({
        sendReply: ({ attempt }) =>
          attempt === 1
            ? { status: 401, body: '{"error":{"status":"UNAUTHENTICATED"}}' }
            : { status: 200, body: '{}' },
      });

      await provider.send(creds, ['a'], { title: 't' });
      await provider.send(creds, ['b'], { title: 't' });

      // A 401 means the cached token went stale mid-campaign; keeping it would
      // fail every remaining token for an hour.
      expect(stub.tokenExchanges).toBeGreaterThan(1);
    });
  });

  describe('dry run', () => {
    it('sets validate_only so FCM checks the message without delivering', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], { title: 't' }, { dryRun: true });

      expect(stub.sendBodies[0]).toMatchObject({ validate_only: true });
    });

    it('omits validate_only for a normal send', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], { title: 't' });

      expect(stub.sendBodies[0].validate_only).toBeUndefined();
    });
  });

  describe('campaign attribution', () => {
    it('carries the campaign id in the data payload and analytics label', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], { title: 't', campaignId: 'camp-42' });

      // Without this the device has no way to say which campaign it is
      // engaging with, and no campaign can ever report a click-through rate.
      expect(stub.sendBodies[0].message.data).toMatchObject({
        chumbaq_campaign_id: 'camp-42',
      });
      expect(stub.sendBodies[0].message.fcm_options).toEqual({
        analytics_label: 'camp-42',
      });
    });

    it('merges the campaign id alongside caller data', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], {
        title: 't',
        data: { deepLink: '/offers/42' },
        campaignId: 'camp-42',
      });

      expect(stub.sendBodies[0].message.data).toEqual({
        deepLink: '/offers/42',
        chumbaq_campaign_id: 'camp-42',
      });
    });

    it('does not let caller data displace the campaign id', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], {
        title: 't',
        data: { chumbaq_campaign_id: 'attacker-supplied' },
        campaignId: 'camp-42',
      });

      // A campaign whose id could be overwritten would have its engagement
      // silently attributed to someone else's campaign.
      expect(stub.sendBodies[0].message.data.chumbaq_campaign_id).toBe('camp-42');
    });

    it('omits both when no campaign id is given', async () => {
      const stub = stubHttps({ sendReply: () => ({ status: 200, body: '{}' }) });

      await provider.send(creds, ['a'], { title: 't' });

      expect(stub.sendBodies[0].message.data).toBeUndefined();
      expect(stub.sendBodies[0].message.fcm_options).toBeUndefined();
    });
  });

  describe('validateCredentials', () => {
    it('resolves when the service account can obtain a token', async () => {
      stubHttps({});

      await expect(provider.validateCredentials(creds)).resolves.toBeUndefined();
    });

    it('rejects when the token exchange fails', async () => {
      stubHttps({
        tokenReply: { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) },
      });

      await expect(provider.validateCredentials(creds)).rejects.toThrow(
        /Token exchange failed/,
      );
    });

    it('rejects a JSON body with no access_token', async () => {
      stubHttps({
        tokenReply: { status: 200, body: JSON.stringify({ error: 'invalid_grant' }) },
      });

      await expect(provider.send(creds, ['d'], { title: 't' })).rejects.toThrow(
        /Token exchange failed/,
      );
    });
  });

  describe('client_email', () => {
    it.each([
      ['a newline', 'sa@example.iam.gserviceaccount.com\n[Nest] ERROR forged'],
      ['no @', 'not-an-address'],
      ['spaces', 'sa @example.com'],
      ['no domain dot', 'sa@localhost'],
      ['an empty string', ''],
      ['a non-string', 7],
      ['more than 320 characters', `${'a'.repeat(320)}@example.com`],
    ])('refuses %s at validation without making any request', async (_label, email) => {
      const stub = stubHttps({});
      await expect(
        provider.validateCredentials({
          ...baseCredentials,
          client_email: email,
        } as unknown as ServiceAccountCredentials),
      ).rejects.toThrow(
        new BadRequestException("The service account's client_email is not an email address."),
      );
      expect(stub.calls).toHaveLength(0);
    });
  });

  describe('logging a failed token exchange', () => {
    // client_email is written by the tenant. Rows stored before validation
    // checked it still reach sending, so the log line must hold it safely.
    const failingExchange = () =>
      stubHttps({ tokenReply: { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) } });

    it('quotes client_email so a newline cannot forge a log line', async () => {
      failingExchange();
      const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
      const email = 'sa@example.com\n[Nest] 1 - ERROR [AuthService] admin signed in';

      await expect(
        provider.send({ ...creds, client_email: email }, ['d'], { title: 't' }),
      ).rejects.toThrow(/Token exchange failed/);

      const line = warn.mock.calls[0][0] as string;
      expect(line).not.toContain('\n');
      expect(line).toContain(`for ${JSON.stringify(email)}:`);
    });

    it('logs at most 320 characters of client_email', async () => {
      failingExchange();
      const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
      const email = `${'a'.repeat(1000)}@example.com`;

      await expect(
        provider.send({ ...creds, client_email: email }, ['d'], { title: 't' }),
      ).rejects.toThrow(/Token exchange failed/);

      expect(warn.mock.calls[0][0]).toContain(`for "${'a'.repeat(320)}":`);
    });

    // The reply body is whatever the token endpoint (or anything between us
    // and it) sent. JSON escaping leaves U+2028/U+2029 alone, and some log
    // viewers break lines on them.
    it.each([
      ['a JSON reply', JSON.stringify({ error: 'x\u2028[Nest] ERROR forged\u2029y\u0085z' })],
      ['an unreadable reply', '<html>\u2028[Nest] ERROR forged\u2029\u0085'],
    ])('escapes Unicode line breaks in %s body', async (_label, body) => {
      stubHttps({ tokenReply: { status: 400, body } });
      const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);

      await expect(provider.send(creds, ['d'], { title: 't' })).rejects.toThrow(
        /Token exchange failed/,
      );

      const line = warn.mock.calls[0][0] as string;
      expect(line).not.toMatch(/[\n\r\u2028\u2029\u0085]/);
      expect(line).toContain('\\u2028[Nest] ERROR forged\\u2029');
    });

    it('logs up to 500 characters of the reply body', async () => {
      stubHttps({ tokenReply: { status: 400, body: 'b'.repeat(2000) } });
      const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);

      await expect(provider.send(creds, ['d'], { title: 't' })).rejects.toThrow(
        /Token exchange failed/,
      );

      expect(warn.mock.calls[0][0]).toMatch(new RegExp(`HTTP 400 "b{500}"$`));
    });
  });

  describe('token_uri', () => {
    // A tenant writes token_uri. Contacting it would let them make this server
    // POST to any internal host and read back what it said, so only Google's
    // own endpoints are accepted, and even those are never contacted by name.
    const rejected: Array<[string, unknown]> = [
      ['an internal address on another port', 'https://127.0.0.1:8443/token'],
      ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data'],
      ['localhost', 'https://localhost/token'],
      ['an internal hostname', 'https://vault.internal/token'],
      ["Google's host on another port", 'https://oauth2.googleapis.com:8443/token'],
      ["Google's host with the port spelled out", 'https://oauth2.googleapis.com:443/token'],
      ['plain http', 'http://oauth2.googleapis.com/token'],
      ['a lookalike suffix', 'https://oauth2.googleapis.com.evil.com/token'],
      ['a lookalike prefix', 'https://evil-oauth2.googleapis.com/token'],
      ['userinfo hiding the real host', 'https://oauth2.googleapis.com@evil.com/token'],
      ['userinfo in front of Google', 'https://evil.com@oauth2.googleapis.com/token'],
      ['another path on Google', 'https://oauth2.googleapis.com/revoke'],
      ['a trailing slash', 'https://oauth2.googleapis.com/token/'],
      ['a query string', 'https://oauth2.googleapis.com/token?x=1'],
      ['a fragment', 'https://oauth2.googleapis.com/token#x'],
      ['surrounding whitespace', ' https://oauth2.googleapis.com/token'],
      ['an empty string', ''],
      ['a non-string', { href: 'https://oauth2.googleapis.com/token' }],
    ];

    it.each(rejected)(
      'refuses %s at validation without making any request',
      async (_label, tokenUri) => {
        const stub = stubHttps({});

        await expect(
          provider.validateCredentials({
            ...baseCredentials,
            token_uri: tokenUri,
          } as unknown as ServiceAccountCredentials),
        ).rejects.toThrow(
          new BadRequestException(
            "The service account's token_uri must be Google's token endpoint.",
          ),
        );
        expect(stub.calls).toHaveLength(0);
      },
    );

    it.each(rejected)(
      'refuses %s at send time without making any request',
      async (_label, tokenUri) => {
        // Rows stored before this check existed reach the provider without
        // passing validation, so sending must refuse them too.
        const stub = stubHttps({});

        await expect(
          provider.send(
            { ...baseCredentials, token_uri: tokenUri } as unknown as ServiceAccountCredentials,
            ['device-token'],
            { title: 't' },
          ),
        ).rejects.toThrow(/token_uri/);
        expect(stub.calls).toHaveLength(0);
      },
    );

    it.each([
      ['absent', undefined],
      ['the current endpoint', 'https://oauth2.googleapis.com/token'],
      ['the older v4 endpoint', 'https://www.googleapis.com/oauth2/v4/token'],
      ['the endpoint in older key files', 'https://accounts.google.com/o/oauth2/token'],
    ])('accepts %s and always posts to oauth2.googleapis.com', async (_label, tokenUri) => {
      const stub = stubHttps({});

      await provider.validateCredentials({
        ...baseCredentials,
        ...(tokenUri === undefined ? {} : { token_uri: tokenUri }),
      } as ServiceAccountCredentials);

      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]).toMatchObject({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
      });
      expect(stub.calls[0].port).toBeUndefined();
    });
  });

  describe('token exchange errors', () => {
    // These messages reach the tenant in a 400. Only Google is contacted now,
    // but a body is still not ours to repeat, and keeping it out means a future
    // endpoint mix-up cannot become a way to read internal responses again.
    const SECRET = 'internal-secret-7f3a';

    async function messageFor(reply: Reply): Promise<string> {
      stubHttps({ tokenReply: reply });
      try {
        await provider.validateCredentials(creds);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('validateCredentials resolved');
    }

    it('gives the status and OAuth error code, and nothing else from the body', async () => {
      const message = await messageFor({
        status: 400,
        body: JSON.stringify({
          error: 'invalid_grant',
          error_description: `Invalid JWT Signature. ${SECRET}`,
        }),
      });

      expect(message).toBe('Token exchange failed (HTTP 400, invalid_grant)');
    });

    it('leaves out an error field that is not an OAuth error code', async () => {
      const message = await messageFor({
        status: 400,
        body: JSON.stringify({ error: `<html>${SECRET}</html>` }),
      });

      expect(message).toBe('Token exchange failed (HTTP 400)');
    });

    it('does not repeat a JSON body with no access_token', async () => {
      const message = await messageFor({
        status: 200,
        body: JSON.stringify({ data: SECRET }),
      });

      expect(message).toBe('Token exchange failed (HTTP 200)');
    });

    it('does not repeat a body that is not JSON', async () => {
      const message = await messageFor({
        status: 200,
        body: `<html><body>${SECRET}</body></html>`,
      });

      expect(message).toBe('Token exchange failed (HTTP 200, unreadable response)');
    });

    it('stops reading and destroys the request past 64 KiB', async () => {
      const piece = 'x'.repeat(16 * 1024);
      const stub = stubHttps({
        tokenReply: {
          status: 200,
          body: '',
          chunks: [piece, piece, piece, piece, `${piece}${SECRET}`, piece],
        },
      });

      await expect(provider.validateCredentials(creds)).rejects.toThrow(
        'Token exchange failed (response too large)',
      );
      expect(stub.destroyed[0]).toBe(true);
    });

    it('accepts a response just under the cap', async () => {
      const body = JSON.stringify({
        access_token: 'tok',
        expires_in: 3600,
        pad: 'x'.repeat(FCM_MAX_RESPONSE_BYTES - 100),
      });
      stubHttps({ tokenReply: { status: 200, body } });

      await expect(provider.validateCredentials(creds)).resolves.toBeUndefined();
    });

    it('gives up on a response that never finishes', async () => {
      jest.useFakeTimers();
      try {
        const stub = stubHttps({ tokenReply: { hang: true } });

        const settled = expect(provider.validateCredentials(creds)).rejects.toThrow(
          'FCM token exchange timed out',
        );
        await jest.advanceTimersByTimeAsync(FCM_REQUEST_TIMEOUT_MS + 1);
        await settled;
        expect(stub.destroyed[0]).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('FCM send responses', () => {
    it('puts the project id in the path as one segment', async () => {
      const stub = stubHttps({});

      await provider.send(
        { ...baseCredentials, project_id: '../../x?y#z' } as ServiceAccountCredentials,
        ['device-token'],
        { title: 't' },
      );

      expect(stub.calls[1].path).toBe(
        '/v1/projects/..%2F..%2Fx%3Fy%23z/messages:send',
      );
    });

    it('stops reading an oversized error and retries rather than buffering it', async () => {
      const piece = 'x'.repeat(16 * 1024);
      const stub = stubHttps({
        sendReply: ({ attempt }) =>
          attempt === 1
            ? { status: 400, body: '', chunks: [piece, piece, piece, piece, piece] }
            : { status: 200, body: '{}' },
      });

      const result = await provider.send(creds, ['a'], { title: 't' });

      expect(result.successCount).toBe(1);
      expect(stub.destroyed[1]).toBe(true);
    });

    it('stores an FCM error envelope whole, so the dashboard can still parse it', async () => {
      // What FCM really sends for a malformed registration token: pretty-
      // printed, with a BadRequest detail, and longer than 500 characters.
      // The dashboard (describeFailure in push-campaign-detail.tsx) parses
      // everything after "FCM error <status>: " as JSON for the code it shows.
      const envelope = JSON.stringify(
        {
          error: {
            code: 400,
            message:
              'The registration token is not a valid FCM registration token',
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'INVALID_ARGUMENT',
              },
              {
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: [
                  {
                    field: 'message.token',
                    description:
                      'The registration token is not a valid FCM registration token',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      );
      expect(envelope.length).toBeGreaterThan(500);
      stubHttps({ sendReply: () => ({ status: 400, body: envelope }) });

      const result = await provider.send(creds, ['a'], { title: 't' });

      const stored = result.failures[0].error;
      const match = stored.match(/^FCM error 400: (.*)$/s);
      expect(match).not.toBeNull();
      const parsed = JSON.parse(match![1]);
      expect(parsed.error.details[0].errorCode).toBe('INVALID_ARGUMENT');
      expect(parsed.error.status).toBe('INVALID_ARGUMENT');
    });
  });
});

// Every channel must satisfy the same contract, and running the one real
// implementation through it is what keeps that contract honest — a suite that
// stopped describing FCM would not be worth holding a new provider to.
describeChannelProviderConformance('FcmProvider', () => new FcmProvider(), {
  credentials: {
    project_id: 'p',
    private_key: privateKey as string,
    client_email: 'x@y.iam.gserviceaccount.com',
  },
  stubAllDelivered: () => {
    stubHttps({ sendReply: () => ({ status: 200, body: '{"name":"ok"}' }) });
  },
});
