import { FORM_PAGE_POLICY } from '../../common/security-headers';
import { createHmac, createSign, generateKeyPairSync } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  EmailPublicController,
  SES_WEBHOOK_LIMIT_PER_MINUTE,
  SNS_CERT_CACHE_ENTRIES,
  SNS_CERT_FETCHES_PER_MINUTE,
  SNS_CERT_MAX_BYTES,
  SNS_CERT_MISSING_TTL_MS,
  SNS_CERT_TIMEOUT_MS,
} from './email-public.controller';
import { UnsubscribeLinks } from './unsubscribe-link';

const PROJECT = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const TOKEN = 'a'.repeat(48);
const TOPIC = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-ses';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// SNS gives every message its own id; a repeated id is a replay.
let nextId = 0;

function snsMessage(over: Record<string, string> = {}) {
  const message: Record<string, string> = {
    Type: 'Notification',
    MessageId: `m-${++nextId}`,
    TopicArn: TOPIC,
    Message: JSON.stringify({
      eventType: 'Bounce',
      mail: { destination: ['gone@example.com'], tags: {} },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'gone@example.com' }] },
    }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0a1b2c.pem',
    ...over,
  };
  const keys =
    message.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const canonical = keys
    .filter((key) => message[key] !== undefined)
    .map((key) => `${key}\n${message[key]}\n`)
    .join('');
  message.Signature = createSign('RSA-SHA256').update(canonical).sign(privateKey, 'base64');
  return message;
}

describe('EmailPublicController', () => {
  const links = new UnsubscribeLinks(Buffer.alloc(32, 1), 'https://api.example');
  const settingsRow = {
    id: 'set-1',
    projectId: PROJECT,
    sesTopicArn: null as string | null,
    project: { ownerId: 'owner-1' },
  };
  const settings = {
    findByWebhookToken: jest.fn(),
    credentialsFor: jest.fn(),
    pinSesTopic: jest.fn(),
  };
  const suppressions = { suppress: jest.fn() };
  const events = { ingest: jest.fn().mockResolvedValue(1) };
  const ses = { accountId: jest.fn() };
  const SES_CREDS = { region: 'ap-south-1', accessKeyId: 'AKIA', secretAccessKey: 's' };
  let controller: EmailPublicController;
  let fetchMock: jest.SpyInstance;

  const res = () => {
    const r: any = {};
    for (const m of ['status', 'type', 'setHeader']) r[m] = jest.fn(() => r);
    r.send = jest.fn(() => r);
    return r;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    settingsRow.sesTopicArn = null;
    settings.findByWebhookToken.mockResolvedValue(settingsRow);
    controller = new EmailPublicController(
      settings as never,
      { verify: (p: unknown, e: unknown, s: unknown) => links.verify(p, e, s) } as never,
      suppressions as never,
      events as never,
      ses as never,
    );
    ses.accountId.mockResolvedValue('123456789012');
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('.pem')
        ? new Response(publicPem)
        : new Response('<ConfirmSubscriptionResponse/>'),
    );
  });

  afterEach(() => fetchMock.mockRestore());

  describe('unsubscribe', () => {
    const query = () => Object.fromEntries(new URL(links.url(PROJECT, 'priya@example.com')).searchParams);

    it('only shows a confirmation on GET, because scanners fetch links', () => {
      const { p, e, s } = query();
      const response = res();
      controller.showUnsubscribe(p, e, s, response);
      expect(suppressions.suppress).not.toHaveBeenCalled();
      expect(response.send.mock.calls[0][0]).toContain('<form method="post"');
      expect(response.setHeader).toHaveBeenCalledWith('Content-Security-Policy', FORM_PAGE_POLICY);
    });

    it('suppresses the address on POST', async () => {
      const { p, e, s } = query();
      await controller.doUnsubscribe(p, e, s, { body: {} } as never, res());
      expect(suppressions.suppress).toHaveBeenCalledWith(
        PROJECT,
        'email',
        [{ address: 'priya@example.com', reason: 'unsubscribed' }],
        'link',
      );
    });

    it('answers a mail client one-click POST with plain text', async () => {
      const { p, e, s } = query();
      const response = res();
      await controller.doUnsubscribe(p, e, s, { body: { 'List-Unsubscribe': 'One-Click' } } as never, response);
      expect(response.type).toHaveBeenCalledWith('text');
    });

    it('refuses a tampered link and suppresses nothing', async () => {
      const { p, s } = query();
      const response = res();
      await controller.doUnsubscribe(
        p,
        Buffer.from('victim@example.com').toString('base64url'),
        s,
        { body: {} } as never,
        response,
      );
      expect(response.status).toHaveBeenCalledWith(400);
      expect(suppressions.suppress).not.toHaveBeenCalled();
    });
  });

  describe('Resend webhook', () => {
    const key = Buffer.from('k'.repeat(32));
    const secret = `whsec_${key.toString('base64')}`;
    const body = JSON.stringify({
      type: 'email.complained',
      data: { to: ['angry@example.com'], tags: {} },
    });
    const request = (signature: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig =
        signature ||
        createHmac('sha256', key).update(`msg_1.${timestamp}.${body}`).digest('base64');
      const headers: Record<string, string> = {
        'svix-id': 'msg_1',
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${sig}`,
      };
      return { rawBody: Buffer.from(body), header: (name: string) => headers[name] } as never;
    };

    it('refuses events when no signing secret is stored', async () => {
      settings.credentialsFor.mockResolvedValueOnce({ apiKey: 're_x' });
      await expect(controller.resendWebhook(TOKEN, request(''))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('refuses a forged signature', async () => {
      settings.credentialsFor.mockResolvedValueOnce({ apiKey: 're_x', webhookSecret: secret });
      await expect(
        controller.resendWebhook(TOKEN, request(Buffer.alloc(32).toString('base64'))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('records a correctly signed event for the token\'s project', async () => {
      settings.credentialsFor.mockResolvedValueOnce({ apiKey: 're_x', webhookSecret: secret });
      await controller.resendWebhook(TOKEN, request(''));
      expect(events.ingest).toHaveBeenCalledWith(PROJECT, 'resend', [
        expect.objectContaining({ type: 'complained', address: 'angry@example.com' }),
      ]);
    });
  });

  describe('Brevo webhook', () => {
    it('refuses an unknown webhook token', async () => {
      settings.findByWebhookToken.mockResolvedValueOnce(null);
      await expect(
        controller.brevoWebhook('b'.repeat(48), { body: {} } as never),
      ).rejects.toThrow();
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('ingests events as unsigned, so each is checked against the project', async () => {
      await controller.brevoWebhook(TOKEN, {
        body: { event: 'spam', email: 'angry@example.com', ts_event: 1793530800 },
      } as never);
      expect(events.ingest).toHaveBeenCalledWith(
        PROJECT,
        'brevo',
        [expect.objectContaining({ type: 'complained', address: 'angry@example.com' })],
        { signed: false },
      );
    });
  });

  describe('SES webhook', () => {
    beforeEach(() => {
      // Confirmed already; tests of the first confirmation clear it.
      settingsRow.sesTopicArn = TOPIC;
      settings.credentialsFor.mockImplementation(async (_p: string, provider: string) =>
        provider === 'ses' ? SES_CREDS : null,
      );
    });

    it('refuses a signed topic from an AWS account other than the connected one', async () => {
      // The attack the pin alone did not stop: a topic in the attacker's own
      // account, posted to before the customer's real topic ever was.
      const attacker = snsMessage({ TopicArn: 'arn:aws:sns:ap-south-1:999999999999:chumbaq-ses' });
      settingsRow.sesTopicArn = attacker.TopicArn;
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(attacker) } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(settings.pinSesTopic).not.toHaveBeenCalled();
      expect(events.ingest).not.toHaveBeenCalled();
      expect(ses.accountId).toHaveBeenCalledWith(SES_CREDS);
    });

    it('confirms no subscription for a topic in another account', async () => {
      settingsRow.sesTopicArn = null;
      const confirm = snsMessage({
        Type: 'SubscriptionConfirmation',
        TopicArn: 'arn:aws:sns:ap-south-1:999999999999:chumbaq-ses',
        SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
        Token: 't',
      });
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(confirm) } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(confirm.SubscribeURL);
    });

    it('refuses events while SES is not connected, since no account can be checked', async () => {
      settings.credentialsFor.mockResolvedValue(null);
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(snsMessage()) } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('refuses a replayed message', async () => {
      const old = snsMessage({ Timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() });
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(old) } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('asks SNS to retry when AWS cannot confirm the account', async () => {
      ses.accountId.mockRejectedValueOnce(new Error('STS down'));
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(snsMessage()) } as never),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(events.ingest).not.toHaveBeenCalled();
    });

    it('records a signed notification from the confirmed topic', async () => {
      await controller.sesWebhook(TOKEN, { body: JSON.stringify(snsMessage()) } as never);
      expect(settings.pinSesTopic).not.toHaveBeenCalled();
      expect(events.ingest).toHaveBeenCalledWith(PROJECT, 'ses', [
        expect.objectContaining({ type: 'bounced', permanent: true }),
      ]);
    });

    it('refuses events from a topic other than the pinned one', async () => {
      settingsRow.sesTopicArn = 'arn:aws:sns:ap-south-1:999999999999:attacker';
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(snsMessage()) } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(events.ingest).not.toHaveBeenCalled();
    });

    describe(`at most ${SES_WEBHOOK_LIMIT_PER_MINUTE} verified requests a minute per webhook`, () => {
      const OTHER_TOKEN = 'b'.repeat(48);
      const OTHER = { id: 'set-2', projectId: PROJECT, sesTopicArn: TOPIC, project: { ownerId: 'owner-1' } };
      const status = (promise: Promise<unknown>) =>
        promise.then(
          () => 200,
          (error: unknown) => (error as HttpException).getStatus(),
        );
      const genuine = (token: string, at: number) =>
        controller.sesWebhook(token, {
          body: JSON.stringify(snsMessage({ Timestamp: new Date(at).toISOString() })),
        } as never);

      beforeEach(() => {
        settings.findByWebhookToken.mockImplementation(async (token: string) =>
          token === TOKEN ? settingsRow : token === OTHER_TOKEN ? OTHER : null,
        );
      });

      it('answers 429 past the limit, so SNS retries later, and counts each webhook apart', async () => {
        const now = jest.spyOn(Date, 'now');
        try {
          const start = Date.now();
          now.mockReturnValue(start);
          for (let i = 0; i < SES_WEBHOOK_LIMIT_PER_MINUTE; i++) {
            expect(await status(genuine(TOKEN, start))).toBe(200);
          }
          expect(await status(genuine(TOKEN, start))).toBe(429);

          // Another project's webhook has its own allowance.
          expect(await status(genuine(OTHER_TOKEN, start))).toBe(200);

          // The next minute starts afresh.
          now.mockReturnValue(start + 60_000);
          expect(await status(genuine(TOKEN, start + 60_000))).toBe(200);
        } finally {
          now.mockRestore();
        }
      });

      it('keeps no count for a token that matches no project', async () => {
        for (let i = 0; i < 100; i++) {
          expect(await status(controller.sesWebhook('c'.repeat(48), { body: '{}' } as never))).toBe(404);
        }
        expect((controller as any).sesLimiter.size).toBe(0);
        expect((controller as any).seenMessages.size).toBe(0);
        expect((controller as any).certificateBudget.size).toBe(0);
      });
    });

    it('refuses a certificate not served by SNS', async () => {
      const forged = snsMessage({ SigningCertURL: 'https://evil.example/cert.pem' });
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(forged) } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('fetching the signing certificate', () => {
      const CERT = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0a1b2c';
      const post = (message: Record<string, string>) =>
        controller.sesWebhook(TOKEN, { body: JSON.stringify(message) } as never);
      const certFetches = () =>
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('.pem')).length;

      // Anyone holding the webhook URL can post here, unthrottled. A URL that
      // varies per request used to be a new fetch and a new cache entry
      // every time, until the process ran out of memory.
      it.each([
        ['a query string', `${CERT}.pem?n=1`],
        ['a fragment', `${CERT}.pem#n`],
        ['an explicit port', CERT.replace('.com/', '.com:443/') + '.pem'],
        ['a username', CERT.replace('https://', 'https://n@') + '.pem'],
        ['a username and password', CERT.replace('https://', 'https://n:p@') + '.pem'],
      ])('refuses a certificate URL with %s without fetching it', async (_label, url) => {
        await expect(post(snsMessage({ SigningCertURL: url }))).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it.each([
        ['an unknown type', { Type: 'Other' }],
        ['an unknown signature version', { SignatureVersion: '3' }],
        ['no signature', { Signature: '' }],
        ['a stale timestamp', { Timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() }],
        ['no timestamp', { Timestamp: 'yesterday' }],
        ['a topic that is not an SNS topic ARN', { TopicArn: 'arn:aws:sqs:ap-south-1:123456789012:q' }],
        ['a message that is not a string', { Message: 7 as unknown as string }],
      ])('fetches nothing for a message with %s', async (_label, over) => {
        // A certificate no earlier test has fetched, so a cache hit cannot
        // hide a fetch.
        const fresh = `${CERT}${Math.floor(Math.random() * 0xffffff).toString(16)}.pem`;
        const message = { ...snsMessage({ SigningCertURL: fresh }), ...over };
        await expect(post(message)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('fetches a certificate once and reuses it', async () => {
        await post(snsMessage());
        await post(snsMessage());
        expect(certFetches()).toBe(1);
      });

      it(`keeps at most ${SNS_CERT_CACHE_ENTRIES} certificates`, async () => {
        const url = (i: number) => `${CERT}${i.toString(16).padStart(4, '0')}.pem`;
        const now = jest.spyOn(Date, 'now');
        try {
          let clock = Date.now();
          now.mockImplementation(() => clock);
          const at = (i: number) => {
            // A project fetches only so many certificates a minute.
            if (i > 0 && i % SNS_CERT_FETCHES_PER_MINUTE === 0) clock += 60_000;
            return snsMessage({ SigningCertURL: url(i), Timestamp: new Date(clock).toISOString() });
          };
          for (let i = 0; i <= SNS_CERT_CACHE_ENTRIES; i++) {
            await expect(post(at(i))).resolves.toEqual({ recorded: 1 });
          }
          expect(certFetches()).toBe(SNS_CERT_CACHE_ENTRIES + 1);

          // The newest is still held; the oldest made room for it.
          const again = (i: number) =>
            snsMessage({ SigningCertURL: url(i), Timestamp: new Date(clock).toISOString() });
          await post(again(SNS_CERT_CACHE_ENTRIES));
          expect(certFetches()).toBe(SNS_CERT_CACHE_ENTRIES + 1);
          await post(again(0));
          expect(certFetches()).toBe(SNS_CERT_CACHE_ENTRIES + 2);
        } finally {
          now.mockRestore();
        }
      });

      it('trusts only a certificate that verified a signature', async () => {
        // Fetched, but the message was not signed with it: not cached, so the
        // next message with it is fetched again.
        const forged = { ...snsMessage(), Signature: Buffer.alloc(256, 1).toString('base64') };
        await expect(post(forged)).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(post(snsMessage())).resolves.toEqual({ recorded: 1 });
        await post(snsMessage());
        expect(certFetches()).toBe(2);
      });

      it('fetches again once a cached certificate expires', async () => {
        const now = jest.spyOn(Date, 'now');
        try {
          const start = Date.now();
          now.mockReturnValue(start);
          await post(snsMessage());
          now.mockReturnValue(start + 25 * 3600_000);
          // Signed "now" from the clock's point of view, so it is not stale.
          await post(snsMessage({ Timestamp: new Date(start + 25 * 3600_000).toISOString() }));
          expect(certFetches()).toBe(2);
        } finally {
          now.mockRestore();
        }
      });

      it('gives up on a certificate host that does not answer', async () => {
        const abort = new AbortController();
        const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
        try {
          fetchMock.mockImplementation(
            (_url, init?: RequestInit) =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
              }),
          );
          const pending = post(snsMessage());
          // The fetch hangs until the deadline fires; fire it once it is waiting.
          while (fetchMock.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
          abort.abort(new DOMException('timed out', 'TimeoutError'));
          // 503, so SNS retries a genuine message rather than dropping it.
          await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
          expect(timeout).toHaveBeenCalledWith(SNS_CERT_TIMEOUT_MS);
          expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: abort.signal, redirect: 'error' });
        } finally {
          timeout.mockRestore();
        }
      });

      it(`refuses a certificate larger than ${SNS_CERT_MAX_BYTES} bytes and stops reading it`, async () => {
        let pulled = 0;
        fetchMock.mockImplementation(async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulled++;
                controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
              },
            }),
          ),
        );
        await expect(post(snsMessage())).rejects.toBeInstanceOf(UnauthorizedException);
        // An endless body is abandoned soon after the cap, not read to the end.
        expect(pulled).toBeLessThan(SNS_CERT_MAX_BYTES / 4096 + 4);
      });

      it('accepts a certificate of exactly the cap and refuses one byte more', async () => {
        // A real certificate padded with trailing newlines, which PEM parsing
        // ignores, so only the size decides.
        const padded = (bytes: number) => publicPem + '\n'.repeat(bytes - publicPem.length);
        fetchMock.mockImplementation(async () => new Response(padded(SNS_CERT_MAX_BYTES)));
        await expect(post(snsMessage())).resolves.toEqual({ recorded: 1 });

        controller = new EmailPublicController(
          settings as never,
          {} as never,
          suppressions as never,
          events as never,
          ses as never,
        );
        fetchMock.mockImplementation(async () => new Response(padded(SNS_CERT_MAX_BYTES + 1)));
        await expect(post(snsMessage())).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('refuses a certificate URL in a region AWS does not have, without fetching it', async () => {
        const made = `https://sns.xx-fake-9.amazonaws.com/SimpleNotificationService-0a1b2c.pem`;
        await expect(post(snsMessage({ SigningCertURL: made }))).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it(`remembers a certificate AWS does not have for ${SNS_CERT_MISSING_TTL_MS / 1000}s, then tries again`, async () => {
        const now = jest.spyOn(Date, 'now');
        try {
          const start = Date.now();
          const at = (t: number) => {
            now.mockReturnValue(t);
            return snsMessage({ Timestamp: new Date(t).toISOString() });
          };
          fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 404 }));
          await expect(post(at(start))).rejects.toBeInstanceOf(UnauthorizedException);

          // Within the window: the same refusal, and no second request to AWS.
          await expect(post(at(start + SNS_CERT_MISSING_TTL_MS - 1))).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
          expect(certFetches()).toBe(1);

          // Past it, a real certificate is fetched and accepted.
          await expect(post(at(start + SNS_CERT_MISSING_TTL_MS))).resolves.toEqual({ recorded: 1 });
          expect(certFetches()).toBe(2);
        } finally {
          now.mockRestore();
        }
      });

      /** A certificate fetch that waits until the test lets it answer. */
      const heldFetches = () => {
        const release: Array<() => void> = [];
        fetchMock.mockImplementation(
          () => new Promise<Response>((resolve) => release.push(() => resolve(new Response(publicPem)))),
        );
        return release;
      };
      const settle = () => new Promise((r) => setImmediate(r));

      it('fetches a certificate once for requests that arrive together', async () => {
        const release = heldFetches();
        const together = [post(snsMessage()), post(snsMessage()), post(snsMessage())];
        await settle();
        expect(certFetches()).toBe(1);
        release.forEach((go) => go());
        await expect(Promise.all(together)).resolves.toEqual([
          { recorded: 1 },
          { recorded: 1 },
          { recorded: 1 },
        ]);
        expect(certFetches()).toBe(1);
      });

      it('fetches one certificate at a time per project and asks SNS to retry another', async () => {
        const release = heldFetches();
        const url = (i: number) => `${CERT}${i.toString(16).padStart(4, '0')}.pem`;
        const held = post(snsMessage({ SigningCertURL: url(0) }));
        await settle();
        await expect(post(snsMessage({ SigningCertURL: url(1) }))).rejects.toMatchObject({ status: 429 });
        expect(certFetches()).toBe(1);
        release.forEach((go) => go());
        await expect(held).resolves.toEqual({ recorded: 1 });

        // Not remembered: with the first done, the second is fetched.
        fetchMock.mockImplementation(async () => new Response(publicPem));
        await expect(post(snsMessage({ SigningCertURL: url(1) }))).resolves.toEqual({ recorded: 1 });
        expect(certFetches()).toBe(2);
      });

      it('frees its place when a certificate fetch fails', async () => {
        fetchMock.mockImplementation(async () => {
          throw new TypeError('fetch failed');
        });
        const url = (i: number) => `${CERT}${i.toString(16).padStart(4, '0')}.pem`;
        for (let i = 0; i < 3; i++) {
          await expect(post(snsMessage({ SigningCertURL: url(i) }))).rejects.toBeInstanceOf(
            ServiceUnavailableException,
          );
        }
        // Every one reached AWS; none was turned away for a fetch still held.
        expect(certFetches()).toBe(3);
        expect((controller as any).fetchesInFlight).toBe(0);
      });
    });

    it('refuses a message altered after signing', async () => {
      const message = snsMessage();
      message.Message = message.Message.replace('Permanent', 'Transient');
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(message) } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('confirms a subscription only against SNS itself', async () => {
      const confirm = snsMessage({
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
        Token: 't',
      });
      await controller.sesWebhook(TOKEN, { body: JSON.stringify(confirm) } as never);
      expect(fetchMock).toHaveBeenCalledWith(
        confirm.SubscribeURL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(settings.pinSesTopic).toHaveBeenCalledWith('set-1', TOPIC);

      const ssrf = snsMessage({
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'http://169.254.169.254/latest/meta-data/',
        Token: 't',
      });
      await expect(
        controller.sesWebhook(TOKEN, { body: JSON.stringify(ssrf) } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('topicAccount', () => {
  // Imported lazily so the describe above stays the file's subject.
  const { topicAccount } = jest.requireActual('./email-public.controller');

  it('reads the account from a topic ARN, including other partitions', () => {
    expect(topicAccount('arn:aws:sns:ap-south-1:123456789012:t')).toBe('123456789012');
    expect(topicAccount('arn:aws-cn:sns:cn-north-1:123456789012:t')).toBe('123456789012');
  });

  it('reads nothing from something that is not a topic ARN', () => {
    expect(topicAccount('arn:aws:sqs:ap-south-1:123456789012:t')).toBeNull();
    expect(topicAccount(undefined)).toBeNull();
    expect(topicAccount('123456789012')).toBeNull();
  });

  it('reads the region from a topic ARN', () => {
    const { topicRegion } = jest.requireActual('./email-public.controller');
    expect(topicRegion('arn:aws:sns:ap-south-1:123456789012:t')).toBe('ap-south-1');
    expect(topicRegion('arn:aws-us-gov:sns:us-gov-west-1:123456789012:t')).toBe('us-gov-west-1');
    expect(topicRegion('arn:aws:sqs:ap-south-1:123456789012:t')).toBeNull();
  });
});
