jest.mock('http2', () => ({
  connect: jest.fn(),
}));

import * as http2 from 'http2';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import {
  ApnsProvider,
  ApnsCredentials,
  ApnsEnvironment,
  APNS_HOSTS,
  APNS_MAX_CONCURRENT_SENDS,
  APNS_MAX_PAYLOAD_BYTES,
  APNS_MAX_SEND_ATTEMPTS,
  APNS_COLLAPSE_ID_MAX_BYTES,
  APNS_DEAD_TOKEN_REASONS,
} from './apns.provider';
import { describeChannelProviderConformance } from './channel-provider.conformance';
import { CampaignMessage } from './channel-provider';

// A real P-256 key pair: the provider signs an ES256 assertion before any
// request is made, and the tests verify that signature rather than trusting
// that a string was produced.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** What the fake transport should do for one request. */
type Reply =
  | { status: number; body: string }
  | { timeout: true }
  | { streamError: string };

interface SendContext {
  /** The device token this request targets, taken from `:path`. */
  token: string;
  /** 1 for the first attempt at this token, 2 for the first retry, and so on. */
  attempt: number;
  headers: http2.OutgoingHttpHeaders;
}

interface Stub {
  /** Every authority passed to `http2.connect`, in call order. */
  connects: string[];
  /** Headers of every stream opened, in call order. */
  requests: http2.OutgoingHttpHeaders[];
  /** Parsed JSON payloads of those streams, in call order. */
  payloads: Record<string, any>[];
  /** How many sessions were gracefully closed. */
  closes: number;
  /** High-water mark of simultaneously open streams. */
  maxConcurrent: number;
}

interface MockSession extends EventEmitter {
  closed: boolean;
  destroyed: boolean;
  close: jest.Mock;
  request: jest.Mock;
}

interface MockStream extends EventEmitter {
  setTimeout: jest.Mock;
  destroy: jest.Mock;
  end: jest.Mock;
}

const OK: Reply = { status: 200, body: '' };

/** Apple's error envelope. */
function errorBody(reason: string): string {
  return JSON.stringify({ reason });
}

/**
 * Fake `http2.connect`. Every stream is an APNs send, so `sendReply` sees the
 * device token, that token's attempt number and the request headers, and can
 * fail a request once before letting it through.
 */
function stubHttp2(opts: { sendReply?: (ctx: SendContext) => Reply }): Stub {
  const stub: Stub = {
    connects: [],
    requests: [],
    payloads: [],
    closes: 0,
    maxConcurrent: 0,
  };
  const attemptsByToken = new Map<string, number>();
  let inFlight = 0;

  (http2.connect as unknown as jest.Mock).mockImplementation(
    (authority: string) => {
      stub.connects.push(authority);

      const session = new EventEmitter() as MockSession;
      session.closed = false;
      session.destroyed = false;
      session.close = jest.fn(() => {
        session.closed = true;
        stub.closes++;
      });

      session.request = jest.fn((headers: http2.OutgoingHttpHeaders) => {
        stub.requests.push(headers);

        const stream = new EventEmitter() as MockStream;
        let timeoutHandler: (() => void) | undefined;
        let destroyed = false;

        stream.setTimeout = jest.fn((_ms: number, handler: () => void) => {
          timeoutHandler = handler;
          return stream;
        });
        stream.destroy = jest.fn((err?: Error) => {
          if (destroyed) return stream;
          destroyed = true;
          process.nextTick(() =>
            stream.emit('error', err ?? new Error('destroyed')),
          );
          return stream;
        });

        stream.end = jest.fn((payload: string) => {
          stub.payloads.push(JSON.parse(payload));

          const token = String(headers[':path'] ?? '').replace('/3/device/', '');
          const attempt = (attemptsByToken.get(token) ?? 0) + 1;
          attemptsByToken.set(token, attempt);

          inFlight++;
          stub.maxConcurrent = Math.max(stub.maxConcurrent, inFlight);

          const reply = opts.sendReply
            ? opts.sendReply({ token, attempt, headers })
            : OK;

          process.nextTick(() => {
            inFlight--;

            if ('timeout' in reply) {
              timeoutHandler?.();
              return;
            }
            if ('streamError' in reply) {
              stream.emit('error', new Error(reply.streamError));
              return;
            }

            stream.emit('response', { ':status': reply.status });
            if (reply.body) stream.emit('data', reply.body);
            stream.emit('end');
          });

          return stream;
        });

        return stream;
      });

      return session;
    },
  );

  return stub;
}

/** The `authorization` values sent, in order. */
function bearers(stub: Stub): string[] {
  return stub.requests.map((h) => String(h.authorization));
}

/** Splits a bearer header into the JWT's decoded header and claims. */
function decodeJwt(authorization: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  expect(authorization.startsWith('bearer ')).toBe(true);
  const jwt = authorization.slice('bearer '.length);
  const [header, claims, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

/** Retries are real awaits, so tests use a provider whose backoff is zero. */
class TestApnsProvider extends ApnsProvider {
  protected retryDelayMs(): number {
    return 0;
  }
}

describe('ApnsProvider', () => {
  let provider: ApnsProvider;
  let warn: jest.SpyInstance;

  const creds: ApnsCredentials = {
    keyId: 'ABCD123456',
    teamId: 'TEAM123456',
    privateKey: privateKey as string,
    bundleId: 'com.example.app',
  };

  const message: CampaignMessage = {
    title: 'Hello',
    body: 'World',
    campaignId: 'camp-1',
  };

  beforeEach(() => {
    (http2.connect as unknown as jest.Mock).mockReset();
    // Silenced rather than left to clutter the run; the truncation test below
    // asserts against it, which is the only place it carries information.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    provider = new TestApnsProvider();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('addressing', () => {
    it('returns an empty result without connecting when there are no tokens', async () => {
      const stub = stubHttp2({});

      await expect(provider.send(creds, [], message)).resolves.toEqual({
        successCount: 0,
        failureCount: 0,
        failures: [],
        resolvedCount: 0,
        retryReason: null,
      });

      expect(stub.connects).toEqual([]);
    });

    it('sends production traffic to the production host', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['device-1'], message);

      expect(stub.connects).toEqual([`https://${APNS_HOSTS.production}`]);
    });

    it('sends sandbox traffic to the sandbox host', async () => {
      const stub = stubHttp2({});

      // A development-build token exists only in the sandbox, so the wrong
      // host is BadDeviceToken for every recipient rather than a slow path.
      await provider.send({ ...creds, environment: 'sandbox' }, ['device-1'], message);

      expect(stub.connects).toEqual([`https://${APNS_HOSTS.sandbox}`]);
      expect(APNS_HOSTS.sandbox).toBe('api.sandbox.push.apple.com');
    });

    it('defaults to production when no environment is stored', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['device-1'], message);

      expect(stub.connects[0]).toContain('api.push.apple.com');
    });

    it('posts to /3/device/<deviceToken>', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['abc123'], message);

      expect(stub.requests[0]).toMatchObject({
        ':method': 'POST',
        ':path': '/3/device/abc123',
      });
    });

    it('names the app in apns-topic, which APNs requires', async () => {
      const stub = stubHttp2({});

      await provider.send({ ...creds, bundleId: 'com.acme.thing' }, ['d'], message);

      expect(stub.requests[0]['apns-topic']).toBe('com.acme.thing');
    });
  });

  describe('provider token', () => {
    it('authorizes with a bearer ES256 JWT carrying the key and team ids', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['device-1'], message);

      const { header, claims, signingInput, signature } = decodeJwt(
        bearers(stub)[0],
      );
      expect(header).toEqual({ alg: 'ES256', kid: 'ABCD123456' });
      expect(claims.iss).toBe('TEAM123456');
      expect(typeof claims.iat).toBe('number');
      // Apple derives the hour of validity from `iat` and rejects a token that
      // carries its own expiry.
      expect(claims).not.toHaveProperty('exp');

      // Verified rather than merely parsed: JWS needs the raw r‖s pair, and
      // node signs ECDSA as DER unless told otherwise. A DER signature parses
      // as a JWT and is rejected by APNs on every request.
      const verified = crypto.verify(
        'sha256',
        Buffer.from(signingInput),
        { key: publicKey as string, dsaEncoding: 'ieee-p1363' },
        signature,
      );
      expect(verified).toBe(true);
    });

    it('reuses one token across a page instead of signing per request', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['a', 'b', 'c', 'd', 'e'], message);

      // Signing per request is what earns 429 TooManyProviderTokenUpdates.
      expect(stub.requests).toHaveLength(5);
      expect(new Set(bearers(stub)).size).toBe(1);
    });

    it('reuses the token across separate pages of the same campaign', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['a'], message);
      await provider.send(creds, ['b'], message);

      expect(new Set(bearers(stub)).size).toBe(1);
    });

    it('signs a fresh token per key, not one shared across projects', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['a'], message);
      await provider.send({ ...creds, keyId: 'ZZZZ999999' }, ['b'], message);

      expect(new Set(bearers(stub)).size).toBe(2);
      expect(decodeJwt(bearers(stub)[1]).header.kid).toBe('ZZZZ999999');
    });

    it('regenerates once and retries when APNs says the token expired', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) =>
          attempt === 1
            ? { status: 403, body: errorBody('ExpiredProviderToken') }
            : OK,
      });

      const result = await provider.send(creds, ['device-1'], message);

      expect(result).toMatchObject({ successCount: 1, resolvedCount: 1 });
      const sent = bearers(stub);
      expect(sent).toHaveLength(2);
      expect(sent[0]).not.toBe(sent[1]);
    });

    it('fails the whole send when a regenerated token is rejected too', async () => {
      const stub = stubHttp2({
        sendReply: () => ({ status: 403, body: errorBody('InvalidProviderToken') }),
      });

      // Reported per recipient this would deactivate an entire audience over
      // one wrong .p8, so it has to surface as a campaign failure instead.
      await expect(
        provider.send(creds, ['a', 'b', 'c'], message),
      ).rejects.toThrow(/provider token/i);

      // Two attempts each — the original and the one regeneration — and no
      // third, because a fresh token being rejected is not a transient fault.
      expect(stub.requests).toHaveLength(6);
    });

    it('stops sending the rest of the page once the key is known to be rejected', async () => {
      const stub = stubHttp2({
        sendReply: () => ({ status: 403, body: errorBody('InvalidProviderToken') }),
      });

      await expect(
        provider.send(creds, Array.from({ length: 40 }, (_, i) => `d-${i}`), message),
      ).rejects.toThrow(/provider token/i);

      // Every extra request is another rejection Apple counts against us.
      expect(stub.requests.length).toBeLessThanOrEqual(
        2 * APNS_MAX_CONCURRENT_SENDS,
      );
    });

    it('regenerates the rejected token once, not once per in-flight request', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) =>
          attempt === 1
            ? { status: 403, body: errorBody('ExpiredProviderToken') }
            : OK,
      });

      await provider.send(creds, ['a', 'b', 'c', 'd', 'e', 'f'], message);

      // Twelve requests, two distinct tokens: the lanes that already picked up
      // the replacement leave the cache alone.
      expect(stub.requests).toHaveLength(12);
      expect(new Set(bearers(stub)).size).toBe(2);
    });
  });

  describe('headers', () => {
    it('declares an alert push for a normal notification', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], message);

      expect(stub.requests[0]['apns-push-type']).toBe('alert');
      // Left unset, which is Apple's default of 10 — the same thing the FCM
      // path produces for a campaign with no priority of its own.
      expect(stub.requests[0]['apns-priority']).toBeUndefined();
    });

    it('sends apns-priority 10 for a high-priority notification', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        options: { priority: 'high' },
      });

      expect(stub.requests[0]['apns-priority']).toBe('10');
    });

    it('declares a background push at priority 5 for a silent notification', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], { ...message, silent: true });

      // Apple rejects a background push sent at priority 10 outright.
      expect(stub.requests[0]).toMatchObject({
        'apns-push-type': 'background',
        'apns-priority': '5',
      });
    });

    it('keeps priority 5 on a silent push even when the campaign asked for high', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        silent: true,
        options: { priority: 'high' },
      });

      expect(stub.requests[0]['apns-priority']).toBe('5');
    });

    it('turns a ttl into an absolute apns-expiration', async () => {
      const stub = stubHttp2({});
      const before = Math.floor(Date.now() / 1000);

      await provider.send(creds, ['d'], {
        ...message,
        options: { ttlSeconds: 600 },
      });

      // Unix seconds, not a duration: sending 600 would expire the message in
      // 1970 and it would be discarded on arrival.
      const expiration = Number(stub.requests[0]['apns-expiration']);
      expect(expiration).toBeGreaterThanOrEqual(before + 600);
      expect(expiration).toBeLessThanOrEqual(before + 601);
    });

    it('omits apns-expiration when the campaign set no ttl', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], message);

      expect(stub.requests[0]['apns-expiration']).toBeUndefined();
    });

    it('carries a collapse key as apns-collapse-id', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        options: { collapseKey: 'daily-digest' },
      });

      expect(stub.requests[0]['apns-collapse-id']).toBe('daily-digest');
    });

    it('truncates a collapse id past Apple 64-byte limit rather than failing the send', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        options: { collapseKey: 'x'.repeat(100) },
      });

      const collapseId = String(stub.requests[0]['apns-collapse-id']);
      expect(Buffer.byteLength(collapseId)).toBe(APNS_COLLAPSE_ID_MAX_BYTES);
      // Deterministic, so messages sharing the key still collapse together.
      expect(collapseId).toBe('x'.repeat(APNS_COLLAPSE_ID_MAX_BYTES));
      // A silently shortened collapse id is a marketer's grouping quietly
      // changing, so the cut is warned about rather than just made.
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/collapse key/));
    });

    it('gives every notification an apns-id and keeps it across retries', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) =>
          attempt === 1 ? { status: 503, body: '' } : OK,
      });

      await provider.send(creds, ['d'], message);

      expect(stub.requests).toHaveLength(2);
      // One retried notification, not two notifications, in Apple's logs.
      expect(stub.requests[0]['apns-id']).toBe(stub.requests[1]['apns-id']);
      expect(String(stub.requests[0]['apns-id'])).toHaveLength(36);
    });
  });

  describe('payload', () => {
    it('builds an aps alert carrying the campaign copy', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], message);

      expect(stub.payloads[0].aps).toEqual({
        alert: { title: 'Hello', body: 'World' },
      });
    });

    it('puts the campaign id and deep link beside aps, where the SDK reads them', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        deepLinkUrl: 'https://dyp.link/abc',
        data: { custom: 'value' },
      });

      // The same keys FCM sends in its data map: a device must not be able to
      // tell which channel carried the campaign.
      expect(stub.payloads[0]).toMatchObject({
        custom: 'value',
        deep_link_url: 'https://dyp.link/abc',
        chumbaq_campaign_id: 'camp-1',
      });
    });

    it('carries an image and lets the service extension run', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        imageUrl: 'https://cdn.test/a.png',
      });

      // mutable-content is what allows the extension to run at all. Without it
      // iOS delivers the notification and never wakes one, so the URL below
      // would arrive with nothing able to act on it.
      expect(stub.payloads[0].aps).toMatchObject({ 'mutable-content': 1 });
      expect(stub.payloads[0]).toMatchObject({
        chumbaq_image_url: 'https://cdn.test/a.png',
      });
    });

    /**
     * `mutable-content` gates the service extension, and that extension does
     * two jobs: it attaches the image, and it registers a category built
     * from `chumbaq_actions` so iOS has buttons to draw — a payload can name
     * a category but cannot define one, so this is the only route to a
     * payload-defined button. Gating the flag on the image alone meant an
     * actions-only campaign never woke the extension and showed no buttons.
     */
    it('wakes the extension for an actions-only campaign', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        actions: [{ id: 'buy', title: 'Buy now' }],
      });

      expect(stub.payloads[0].aps).toMatchObject({ 'mutable-content': 1 });
      expect(stub.payloads[0].chumbaq_actions).toBeDefined();
      // No image, so nothing to attach — the flag is there for the buttons.
      expect(stub.payloads[0].chumbaq_image_url).toBeUndefined();
    });

    it('wakes the extension once when a campaign has both an image and actions', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        imageUrl: 'https://cdn.test/a.png',
        actions: [{ id: 'buy', title: 'Buy now' }],
      });

      expect(stub.payloads[0].aps['mutable-content']).toBe(1);
      expect(stub.payloads[0].chumbaq_image_url).toBe('https://cdn.test/a.png');
      expect(stub.payloads[0].chumbaq_actions).toBeDefined();
    });

    it('does not wake the extension for a carousel, which is the content extension’s', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        carousel: [
          { imageUrl: 'https://cdn.test/1.png' },
          { imageUrl: 'https://cdn.test/2.png' },
        ],
      });

      // A carousel is drawn by the notification *content* extension, which is
      // matched by `aps.category` against its UNNotificationExtensionCategory.
      // `mutable-content` does nothing for it, so waking the service
      // extension here would be the battery cost with none of the benefit.
      expect(stub.payloads[0].aps['mutable-content']).toBeUndefined();
      expect(stub.payloads[0].chumbaq_carousel).toBeDefined();
    });

    it('does not wake an extension for an actions-only silent push', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        silent: true,
        actions: [{ id: 'buy', title: 'Buy now' }],
      });

      // A silent push is handed to the app, which has no notification to
      // decorate with buttons.
      expect(stub.payloads[0].aps['mutable-content']).toBeUndefined();
    });

    it('does not wake an extension for a notification with no image', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], message);

      // Waking an extension to do nothing costs battery and adds a delivery
      // hop for no benefit.
      expect(stub.payloads[0].aps['mutable-content']).toBeUndefined();
      expect(stub.payloads[0].chumbaq_image_url).toBeUndefined();
    });

    it('sends no image on a silent push', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        silent: true,
        imageUrl: 'https://cdn.test/a.png',
      });

      // A silent push shows nothing, so there is nothing to attach an image to.
      expect(stub.payloads[0].chumbaq_image_url).toBeUndefined();
      expect(stub.payloads[0].aps['mutable-content']).toBeUndefined();
    });

    it('does not let a campaign data key displace the aps dictionary', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        data: { aps: 'hijacked', chumbaq_campaign_id: 'wrong' },
      });

      // Losing either would break the campaign: the first makes the payload
      // undeliverable, the second orphans every click it produces.
      expect(stub.payloads[0].aps).toMatchObject({
        alert: { title: 'Hello' },
      });
      expect(stub.payloads[0].chumbaq_campaign_id).toBe('camp-1');
    });

    it('carries actions as JSON so a tap can be attributed to a button', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        iosCategory: 'OFFER',
        actions: [{ id: 'buy', title: 'Buy', deepLinkUrl: 'https://x/buy' }],
      });

      expect(stub.payloads[0].aps.category).toBe('OFFER');
      expect(JSON.parse(stub.payloads[0].chumbaq_actions)).toEqual([
        { id: 'buy', title: 'Buy', deepLinkUrl: 'https://x/buy' },
      ]);
    });

    it('mirrors the iOS delivery options FCM puts in its own aps block', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        options: { ios: { sound: 'ping.caf', badge: 3, threadId: 'thread-7' } },
      });

      // Field for field with FcmProvider.apnsConfig, so the same campaign
      // renders identically whichever channel carried it.
      expect(stub.payloads[0].aps).toEqual({
        alert: { title: 'Hello', body: 'World' },
        sound: 'ping.caf',
        badge: 3,
        'thread-id': 'thread-7',
      });
    });

    it('sends content-available and no alert for a silent push', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], {
        ...message,
        silent: true,
        deepLinkUrl: 'https://dyp.link/abc',
        options: { ios: { sound: 'ping.caf', badge: 3 } },
      });

      // Including an alert makes the OS display something no matter what else
      // is set, so there is no such thing as a silent notification.
      expect(stub.payloads[0].aps).toEqual({ 'content-available': 1 });
      // The deep link still travels, which is how a silent push routes.
      expect(stub.payloads[0].deep_link_url).toBe('https://dyp.link/abc');
    });

    it('omits the body when the campaign has none', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['d'], { title: 'Hello' });

      expect(stub.payloads[0].aps.alert).toEqual({ title: 'Hello' });
    });

    it('refuses a payload over the 4KB limit without blaming the device', async () => {
      const stub = stubHttp2({});

      const result = await provider.send(creds, ['d'], {
        ...message,
        data: { blob: 'x'.repeat(APNS_MAX_PAYLOAD_BYTES) },
      });

      expect(stub.requests).toHaveLength(0);
      expect(result).toMatchObject({ failureCount: 1, resolvedCount: 1 });
      expect(result.failures[0].error).toMatch(/4096-byte limit/);
      // A campaign too big to send says nothing about the token.
      expect(result.failures[0].errorCode).toBeUndefined();
    });

    it('builds and measures the payload on a dry run without sending it', async () => {
      const stub = stubHttp2({});

      const result = await provider.send(creds, ['d'], message, { dryRun: true });

      expect(result).toMatchObject({ successCount: 1, resolvedCount: 1 });
      expect(stub.connects).toEqual([]);
    });
  });

  describe('dead tokens', () => {
    it.each(APNS_DEAD_TOKEN_REASONS)(
      'reports %s with a code the campaign worker deactivates on',
      async (reason) => {
        stubHttp2({
          sendReply: () => ({
            status: reason === 'Unregistered' ? 410 : 400,
            body: errorBody(reason),
          }),
        });

        const result = await provider.send(creds, ['dead-token'], message);

        expect(result).toMatchObject({ failureCount: 1, resolvedCount: 1 });
        // The worker matches UNREGISTERED and NOT_FOUND. Reporting Apple's own
        // string here would leave dead tokens live forever.
        expect(result.failures[0]).toMatchObject({
          token: 'dead-token',
          errorCode: 'UNREGISTERED',
          retryable: false,
        });
        expect(result.failures[0].error).toContain(reason);
      },
    );

    it('leaves an unrecognised rejection without a dead-token code', async () => {
      stubHttp2({
        sendReply: () => ({ status: 400, body: errorBody('PayloadTooLarge') }),
      });

      const result = await provider.send(creds, ['live-token'], message);

      // Deactivating on a reason nobody has decoded counts a live device as an
      // uninstall, and that is not recoverable from.
      expect(result.failures[0]).toMatchObject({
        token: 'live-token',
        errorCode: undefined,
        retryable: false,
      });
      expect(result.failures[0].error).toContain('PayloadTooLarge');
    });

    it('does not deactivate on a rejection with no readable reason', async () => {
      stubHttp2({ sendReply: () => ({ status: 400, body: '<html>nope</html>' }) });

      const result = await provider.send(creds, ['live-token'], message);

      expect(result.failures[0].errorCode).toBeUndefined();
    });
  });

  describe('retries', () => {
    it('retries a 503 and reports the eventual success', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) =>
          attempt === 1
            ? { status: 503, body: errorBody('ServiceUnavailable') }
            : OK,
      });

      const result = await provider.send(creds, ['d'], message);

      expect(stub.requests).toHaveLength(2);
      expect(result).toEqual({
        successCount: 1,
        failureCount: 0,
        failures: [],
        resolvedCount: 1,
        retryReason: null,
      });
    });

    it('retries a 429 rather than giving up on the recipient', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) =>
          attempt === 1 ? { status: 429, body: errorBody('TooManyRequests') } : OK,
      });

      const result = await provider.send(creds, ['d'], message);

      expect(stub.requests).toHaveLength(2);
      expect(result.successCount).toBe(1);
    });

    it('retries a connection error, which says nothing about the message', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) =>
          attempt === 1 ? { streamError: 'ECONNRESET' } : OK,
      });

      const result = await provider.send(creds, ['d'], message);

      expect(stub.requests).toHaveLength(2);
      expect(result.successCount).toBe(1);
    });

    it('treats a hung stream as retryable so a campaign cannot park on it', async () => {
      const stub = stubHttp2({
        sendReply: ({ attempt }) => (attempt === 1 ? { timeout: true } : OK),
      });

      const result = await provider.send(creds, ['d'], message);

      expect(stub.requests).toHaveLength(2);
      expect(result.successCount).toBe(1);
      expect(stub.requests.length).toBeLessThanOrEqual(APNS_MAX_SEND_ATTEMPTS);
    });

    it('gives up after the attempt limit and leaves the recipient unresolved', async () => {
      const stub = stubHttp2({
        sendReply: () => ({ status: 500, body: errorBody('InternalServerError') }),
      });

      const result = await provider.send(creds, ['d'], message);

      expect(stub.requests).toHaveLength(APNS_MAX_SEND_ATTEMPTS);
      expect(result).toMatchObject({
        successCount: 0,
        failureCount: 0,
        resolvedCount: 0,
      });
      expect(result.retryReason).toMatch(/500/);
    });
  });

  describe('resolved prefix', () => {
    it('stops the resolved run at the first recipient still worth retrying', async () => {
      stubHttp2({
        sendReply: ({ token }) =>
          token === 'b' ? { status: 503, body: errorBody('ServiceUnavailable') } : OK,
      });

      const result = await provider.send(creds, ['a', 'b', 'c'], message);

      // `c` succeeded, and is deliberately not reported: the worker advances
      // its cursor by resolvedCount and cannot express a gap, so counting it
      // would skip `b` permanently.
      expect(result).toMatchObject({
        successCount: 1,
        failureCount: 0,
        resolvedCount: 1,
      });
      expect(result.retryReason).toBeTruthy();
    });

    it('resolves the whole page when a permanent failure comes first', async () => {
      stubHttp2({
        sendReply: ({ token }) =>
          token === 'a' ? { status: 410, body: errorBody('Unregistered') } : OK,
      });

      const result = await provider.send(creds, ['a', 'b', 'c'], message);

      // A permanent failure is a final outcome, so it does not hold the prefix
      // back the way a retryable one does.
      expect(result).toMatchObject({
        successCount: 2,
        failureCount: 1,
        resolvedCount: 3,
        retryReason: null,
      });
      expect(result.failures[0].token).toBe('a');
    });
  });

  describe('connection', () => {
    it('multiplexes a whole page over one connection', async () => {
      const stub = stubHttp2({});
      const tokens = Array.from({ length: 50 }, (_, i) => `d-${i}`);

      await provider.send(creds, tokens, message);

      // A connection per notification is a TLS handshake per recipient, and
      // Apple discourages it.
      expect(stub.connects).toHaveLength(1);
      expect(stub.requests).toHaveLength(50);
    });

    it('closes the connection when the page is done', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['a', 'b'], message);

      expect(stub.closes).toBe(1);
    });

    it('closes the connection even when the send fails outright', async () => {
      const stub = stubHttp2({
        sendReply: () => ({ status: 403, body: errorBody('InvalidProviderToken') }),
      });

      await expect(provider.send(creds, ['a'], message)).rejects.toThrow();

      // Otherwise a campaign that fails on a bad key leaks a socket per page.
      expect(stub.closes).toBe(1);
    });

    it('opens a fresh connection for the next page', async () => {
      const stub = stubHttp2({});

      await provider.send(creds, ['a'], message);
      await provider.send(creds, ['b'], message);

      expect(stub.connects).toHaveLength(2);
    });

    it('caps how many notifications are in flight at once', async () => {
      const stub = stubHttp2({});
      const tokens = Array.from({ length: 60 }, (_, i) => `d-${i}`);

      await provider.send(creds, tokens, message);

      expect(stub.maxConcurrent).toBeLessThanOrEqual(APNS_MAX_CONCURRENT_SENDS);
    });
  });

  describe('validateCredentials', () => {
    it('accepts a well-formed key without contacting Apple', async () => {
      const stub = stubHttp2({});

      await expect(provider.validateCredentials(creds)).resolves.toBeUndefined();

      // There is no APNs endpoint that validates a key without also delivering
      // a notification, so checking one would mean sending one.
      expect(stub.connects).toEqual([]);
    });

    it.each(['keyId', 'teamId', 'privateKey', 'bundleId'])(
      'rejects credentials with no %s',
      async (field) => {
        const partial = { ...creds } as Record<string, unknown>;
        delete partial[field];

        await expect(
          provider.validateCredentials(partial as unknown as ApnsCredentials),
        ).rejects.toThrow(new RegExp(field));
      },
    );

    it('rejects whitespace passed off as a key id', async () => {
      await expect(
        provider.validateCredentials({ ...creds, keyId: '   ' }),
      ).rejects.toThrow(/keyId/);
    });

    it('rejects a private key that is not a readable key at all', async () => {
      await expect(
        provider.validateCredentials({ ...creds, privateKey: 'not a pem' }),
      ).rejects.toThrow(/privateKey/);
    });

    it('rejects an RSA key pasted where the .p8 belongs', async () => {
      const rsa = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      // ES256 is defined only over EC, so this would be InvalidProviderToken
      // on every request — a failure that reads like a wrong team id.
      await expect(
        provider.validateCredentials({
          ...creds,
          privateKey: rsa.privateKey as string,
        }),
      ).rejects.toThrow(/EC private key/);
    });

    it('rejects an EC key on the wrong curve', async () => {
      const p384 = crypto.generateKeyPairSync('ec', {
        namedCurve: 'secp384r1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      await expect(
        provider.validateCredentials({
          ...creds,
          privateKey: p384.privateKey as string,
        }),
      ).rejects.toThrow(/P-256/);
    });

    it('accepts a key whose newlines arrived escaped', async () => {
      // How a PEM survives an environment variable or a JSON blob.
      await expect(
        provider.validateCredentials({
          ...creds,
          privateKey: (privateKey as string).replace(/\n/g, '\\n'),
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects an environment it cannot address', async () => {
      await expect(
        provider.validateCredentials({
          ...creds,
          environment: 'staging' as ApnsEnvironment,
        }),
      ).rejects.toThrow(/environment/);
    });

    it('fails the whole send rather than every recipient when credentials are unusable', async () => {
      const stub = stubHttp2({});

      await expect(
        provider.send({ ...creds, privateKey: 'nope' }, ['a'], message),
      ).rejects.toThrow(/privateKey/);

      // Reporting a delivery failure per recipient would blame the devices for
      // a configuration mistake, and the campaign would look half-sent.
      expect(stub.connects).toEqual([]);
    });
  });
});

// Every channel is held to the same contract; a provider that overstates what
// it finished skips recipients silently and only under load.
describeChannelProviderConformance('ApnsProvider', () => new ApnsProvider(), {
  credentials: {
    keyId: 'ABCD123456',
    teamId: 'TEAM123456',
    privateKey: privateKey as string,
    bundleId: 'com.example.app',
  },
  stubAllDelivered: () => {
    stubHttp2({ sendReply: () => ({ status: 200, body: '' }) });
  },
});
