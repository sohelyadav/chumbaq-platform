import { createSign, generateKeyPairSync } from 'crypto';
import { HttpException } from '@nestjs/common';
import {
  CertificateMissingException,
  EmailPublicController,
  SES_WEBHOOK_IN_FLIGHT_MS,
  SES_WEBHOOK_LIMIT_PER_MINUTE,
  SNS_CERT_FETCHES_PER_ACCOUNT,
  SNS_CERT_FETCHES_PER_MINUTE,
  SNS_CERT_MAX_CONCURRENT_FETCHES,
  SNS_CERT_MISSING_MAX_PROJECTS,
  SNS_CERT_MISSING_PER_PROJECT,
  SNS_CERT_MISSING_TTL_MS,
} from './email-public.controller';
import { SesProvider } from './providers/ses.provider';

/**
 * The SES webhook is reachable by anyone holding one project's secret URL.
 * These tests hold the rule that such a holder can disrupt only that
 * project: two tenants, A (the flooder) and B (the bystander), and every
 * shared resource A could try to use up.
 */

const TOKEN_A = 'a'.repeat(48);
const TOKEN_B = 'b'.repeat(48);
const TOPIC_A = 'arn:aws:sns:ap-south-1:111111111111:a-events';
const TOPIC_B = 'arn:aws:sns:ap-south-1:222222222222:b-events';
const CERT = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0a1b2c.pem';
const certUrl = (i: number) =>
  `https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-${i.toString(16).padStart(6, '0')}.pem`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

// SNS gives every message its own id; a repeated id is a replay.
let nextId = 0;

function signed(over: Record<string, string> = {}): Record<string, string> {
  const message: Record<string, string> = {
    Type: 'Notification',
    MessageId: `m-${++nextId}`,
    TopicArn: TOPIC_B,
    Message: JSON.stringify({
      eventType: 'Bounce',
      mail: { destination: ['gone@example.com'], tags: {} },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'gone@example.com' }] },
    }),
    Timestamp: new Date(Date.now()).toISOString(),
    SignatureVersion: '2',
    SigningCertURL: CERT,
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

/** Signed by someone else's key: looks right, never verifies. */
const forged = (over: Record<string, string> = {}) => ({
  ...signed(over),
  Signature: Buffer.alloc(256, 7).toString('base64'),
});

describe('SES webhook: one project cannot degrade another', () => {
  const rows: Record<
    string,
    { id: string; projectId: string; sesTopicArn: string | null; project: { ownerId: string } }
  > = {};
  const settings = {
    findByWebhookToken: jest.fn(async (token: string) => rows[token] ?? null),
    credentialsFor: jest.fn(async (projectId: string) => ({
      region: 'ap-south-1',
      accessKeyId: projectId === 'project-a' ? 'AKIAA' : 'AKIAB',
      secretAccessKey: 's',
    })),
    pinSesTopic: jest.fn(),
  };
  const events = { ingest: jest.fn().mockResolvedValue(1) };
  // Each project's credentials belong to the account its topic is in.
  const ses = { accountId: jest.fn() };
  let controller: EmailPublicController;
  let fetchMock: jest.SpyInstance;
  let now: jest.SpyInstance;
  let clock: number;

  const post = (token: string, message: unknown) =>
    controller.sesWebhook(token, { body: JSON.stringify(message) } as never);
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: unknown) => (error instanceof HttpException ? error.getStatus() : 500),
    );
  const certFetches = (url?: string) =>
    fetchMock.mock.calls.filter(([u]) => String(u).endsWith('.pem') && (!url || String(u) === url))
      .length;
  const settle = () => new Promise((r) => setImmediate(r));

  /** Certificate fetches that wait until the test lets them answer. */
  const holdFetches = () => {
    const release: Array<() => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => release.push(() => resolve(new Response(publicPem)))),
    );
    return () => release.splice(0).forEach((go) => go());
  };

  const newController = () =>
    new EmailPublicController(
      settings as never,
      {} as never,
      {} as never,
      events as never,
      ses as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    clock = Date.now();
    now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    rows[TOKEN_A] = { id: 'set-a', projectId: 'project-a', sesTopicArn: TOPIC_A, project: { ownerId: 'owner-a' } };
    rows[TOKEN_B] = { id: 'set-b', projectId: 'project-b', sesTopicArn: TOPIC_B, project: { ownerId: 'owner-b' } };
    ses.accountId.mockImplementation(async (credentials: { accessKeyId: string }) =>
      credentials.accessKeyId === 'AKIAA' ? '111111111111' : '222222222222',
    );
    controller = newController();
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('.pem')
        ? new Response(publicPem)
        : new Response('<ConfirmSubscriptionResponse/>'),
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    now.mockRestore();
  });

  it('A holding certificate fetches open does not stop B fetching its own', async () => {
    const release = holdFetches();
    // A posts a fresh certificate name per request, each a fetch that hangs.
    const flood = Array.from({ length: 100 }, (_, i) =>
      outcome(post(TOKEN_A, forged({ TopicArn: TOPIC_A, SigningCertURL: certUrl(i) }))),
    );
    await settle();
    // B's genuine event needs a certificate nobody has fetched yet.
    const genuine = post(TOKEN_B, signed());
    await settle();
    expect(certFetches(CERT)).toBe(1);
    release();
    await expect(genuine).resolves.toEqual({ recorded: 1 });
    release();
    await Promise.all(flood);
  });

  it('A sending junk signatures on a cached certificate does not refuse B', async () => {
    await post(TOKEN_B, signed());
    for (let i = 0; i < 2000; i++) {
      await outcome(post(TOKEN_A, forged({ TopicArn: TOPIC_A })));
    }
    await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
  });

  it('junk does not spend the allowance genuine events are counted against', async () => {
    await post(TOKEN_B, signed());
    for (let i = 0; i < 300; i++) {
      expect(await outcome(post(TOKEN_B, { junk: true }))).toBe(401);
    }
    // The whole allowance is still there for verified events, and only those use it.
    for (let i = 1; i < SES_WEBHOOK_LIMIT_PER_MINUTE; i++) {
      await post(TOKEN_B, signed());
    }
    expect(await outcome(post(TOKEN_B, signed()))).toBe(429);
  });

  it('fetches nothing for a message from a topic other than the project\'s', async () => {
    const status = await outcome(
      post(TOKEN_B, signed({ TopicArn: 'arn:aws:sns:ap-south-1:999999999999:elsewhere' })),
    );
    expect(status).toBe(403);
    expect(certFetches()).toBe(0);
  });

  it('fetches nothing when the certificate is in another region than the topic', async () => {
    const status = await outcome(
      post(TOKEN_B, signed({ SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0a1b2c.pem' })),
    );
    expect(status).toBe(401);
    expect(certFetches()).toBe(0);
  });

  it('accepts only a subscription confirmation before a topic is confirmed', async () => {
    rows[TOKEN_B].sesTopicArn = null;
    expect(await outcome(post(TOKEN_B, signed()))).toBe(403);
    expect(certFetches()).toBe(0);
    expect(settings.pinSesTopic).not.toHaveBeenCalled();
    expect(events.ingest).not.toHaveBeenCalled();

    const confirm = signed({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Token: 't',
    });
    await expect(post(TOKEN_B, confirm)).resolves.toEqual({ recorded: 0 });
    expect(settings.pinSesTopic).toHaveBeenCalledWith('set-b', TOPIC_B);
  });

  it.each([
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a 500', async () => new Response('oops', { status: 500 })],
    ['a 503', async () => new Response('busy', { status: 503 })],
    ['a 429', async () => new Response('slow down', { status: 429 })],
  ])('answers %s from AWS with 503 and does not remember it', async (_label, failure) => {
    fetchMock.mockImplementationOnce(failure as never);
    expect(await outcome(post(TOKEN_B, signed()))).toBe(503);
    // The very next delivery asks AWS again and succeeds.
    await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
    expect(certFetches()).toBe(2);
  });

  it('a 404 from one project does not stop another project fetching the same certificate', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('gone', { status: 404 }));
    rows[TOKEN_A].sesTopicArn = TOPIC_B;
    expect(await outcome(post(TOKEN_A, forged()))).toBe(401);
    await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
  });

  it('stops trusting a certificate once AWS says it is gone, counting its age from the first fetch', async () => {
    const start = clock;
    await post(TOKEN_B, signed());
    // Used constantly; use does not extend its life.
    for (let hour = 1; hour < 24; hour++) {
      clock = start + hour * 3600_000;
      await post(TOKEN_B, signed());
    }
    expect(certFetches()).toBe(1);

    clock = start + 24 * 3600_000;
    fetchMock.mockImplementation(async () => new Response('<Code>CertificateMissing</Code>', { status: 404 }));
    expect(await outcome(post(TOKEN_B, signed()))).toBe(401);
    expect(certFetches()).toBe(2);
    expect(await outcome(post(TOKEN_A, signed({ TopicArn: TOPIC_A })))).toBe(401);
  });

  it('a 404 for a certificate another project just trusted drops it for everyone', async () => {
    rows[TOKEN_A].sesTopicArn = TOPIC_B;
    const answers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const fromB = post(TOKEN_B, signed());
    const fromA = outcome(post(TOKEN_A, forged()));
    await settle();
    expect(answers).toHaveLength(2);
    answers[0](new Response(publicPem));
    await expect(fromB).resolves.toEqual({ recorded: 1 });
    // AWS has withdrawn it since: the later answer wins.
    answers[1](new Response('<Code>CertificateMissing</Code>', { status: 404 }));
    expect(await fromA).toBe(401);

    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    expect(await outcome(post(TOKEN_B, signed()))).toBe(401);
    expect(certFetches()).toBe(3);
  });

  it(`remembers a 404 for ${SNS_CERT_MISSING_TTL_MS / 1000}s for the project that asked`, async () => {
    fetchMock.mockImplementationOnce(async () => new Response('gone', { status: 404 }));
    expect(await outcome(post(TOKEN_B, signed()))).toBe(401);
    clock += SNS_CERT_MISSING_TTL_MS - 1;
    expect(await outcome(post(TOKEN_B, signed()))).toBe(401);
    expect(certFetches()).toBe(1);
    clock += 1;
    await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
    expect(certFetches()).toBe(2);
  });

  it(`one account holds at most ${SNS_CERT_FETCHES_PER_ACCOUNT} fetches however many projects it has`, async () => {
    const release = holdFetches();
    // The greedy account's ten projects (the default project limit), each
    // with its own secret URL and a fresh certificate per request.
    const greedyToken = (p: number) => p.toString(16).padStart(48, 'e');
    for (let p = 0; p < 10; p++) {
      rows[greedyToken(p)] = {
        id: `set-greedy-${p}`,
        projectId: `project-greedy-${p}`,
        sesTopicArn: TOPIC_A,
        project: { ownerId: 'owner-greedy' },
      };
    }
    const flood = Array.from({ length: 10 }, (_, p) =>
      outcome(post(greedyToken(p), forged({ TopicArn: TOPIC_A, SigningCertURL: certUrl(2000 + p) }))),
    );
    await settle();
    expect(certFetches()).toBe(SNS_CERT_FETCHES_PER_ACCOUNT);

    // Another account still gets a slot of its own.
    const genuine = post(TOKEN_B, signed());
    await settle();
    expect(certFetches(CERT)).toBe(1);
    release();
    await expect(genuine).resolves.toEqual({ recorded: 1 });
    release();
    const outcomes = await Promise.all(flood);
    // Refused with a status SNS retries, never counted as a verdict on the message.
    expect(outcomes.filter((status) => status === 429)).toHaveLength(10 - SNS_CERT_FETCHES_PER_ACCOUNT);

    // The account's slots are given back once its fetches end.
    fetchMock.mockImplementation(async () => new Response(publicPem));
    expect(await outcome(post(greedyToken(9), forged({ TopicArn: TOPIC_A, SigningCertURL: certUrl(2100) })))).toBe(401);
    expect(certFetches(certUrl(2100))).toBe(1);
  });

  it(`filling the process-wide cap takes ${SNS_CERT_MAX_CONCURRENT_FETCHES / SNS_CERT_FETCHES_PER_ACCOUNT} accounts`, async () => {
    expect(SNS_CERT_MAX_CONCURRENT_FETCHES % SNS_CERT_FETCHES_PER_ACCOUNT).toBe(0);
    const release = holdFetches();
    const accounts = SNS_CERT_MAX_CONCURRENT_FETCHES / SNS_CERT_FETCHES_PER_ACCOUNT;
    const token = (a: number, p: number) => `${a.toString(16).padStart(4, '0')}${p}`.padStart(48, 'f');
    const flood: Promise<number>[] = [];
    for (let a = 0; a < accounts; a++) {
      // Three projects each: the third is turned away by its account's cap.
      for (let p = 0; p < 3; p++) {
        rows[token(a, p)] = {
          id: `set-${a}-${p}`,
          projectId: `project-${a}-${p}`,
          sesTopicArn: TOPIC_B,
          project: { ownerId: `owner-${a}` },
        };
        flood.push(outcome(post(token(a, p), forged({ SigningCertURL: certUrl(3000 + a * 3 + p) }))));
      }
    }
    await settle();
    expect(certFetches()).toBe(SNS_CERT_MAX_CONCURRENT_FETCHES);
    // Every account holds exactly its share: none of the third projects got a slot.
    for (let a = 0; a < accounts; a++) {
      expect([0, 1, 2].map((p) => certFetches(certUrl(3000 + a * 3 + p)))).toEqual([1, 1, 0]);
    }
    // Only once that many accounts hold their share is the bystander turned away.
    expect(await outcome(post(TOKEN_B, signed()))).toBe(503);
    release();
    await Promise.all(flood);
  });

  it('one project holds at most one fetch, and the process-wide cap needs that many projects', async () => {
    const release = holdFetches();
    const flood = Array.from({ length: 10 }, (_, i) =>
      outcome(post(TOKEN_A, forged({ TopicArn: TOPIC_A, SigningCertURL: certUrl(i) }))),
    );
    await settle();
    expect(certFetches()).toBe(1);

    // Fill every slot with a project of its own.
    for (let p = 0; p < SNS_CERT_MAX_CONCURRENT_FETCHES - 1; p++) {
      rows[p.toString(16).padStart(48, 'c')] = {
        id: `set-${p}`,
        projectId: `project-${p}`,
        sesTopicArn: TOPIC_B,
        project: { ownerId: `owner-${p}` },
      };
    }
    const others = Array.from({ length: SNS_CERT_MAX_CONCURRENT_FETCHES - 1 }, (_, p) =>
      outcome(post(p.toString(16).padStart(48, 'c'), forged({ SigningCertURL: certUrl(1000 + p) }))),
    );
    await settle();
    expect(certFetches()).toBe(SNS_CERT_MAX_CONCURRENT_FETCHES);
    // Only now is the bystander turned away, with a 503 SNS retries.
    expect(await outcome(post(TOKEN_B, signed()))).toBe(503);
    release();
    await Promise.all([...flood, ...others]);
    // The slots are given back once the fetches end.
    fetchMock.mockImplementation(async () => new Response(publicPem));
    await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
  });

  it(`fetches at most ${SNS_CERT_FETCHES_PER_MINUTE} uncached certificates a minute per project`, async () => {
    for (let i = 0; i < SNS_CERT_FETCHES_PER_MINUTE + 5; i++) {
      await outcome(post(TOKEN_A, signed({ TopicArn: TOPIC_A, SigningCertURL: certUrl(i), Signature: 'AAAA' })));
    }
    expect(certFetches()).toBe(SNS_CERT_FETCHES_PER_MINUTE);
    // B's allowance is its own.
    await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
    expect(certFetches()).toBe(SNS_CERT_FETCHES_PER_MINUTE + 1);
  });

  it("a 404 answered before an earlier fetch's 200 keeps the certificate out of the cache", async () => {
    // B's fetch starts first. A's starts later, after AWS withdrew the
    // certificate, and its 404 comes back before B's 200.
    rows[TOKEN_A].sesTopicArn = TOPIC_B;
    const answers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const fromB = post(TOKEN_B, signed());
    await settle();
    clock += 1;
    const fromA = outcome(post(TOKEN_A, forged()));
    await settle();
    expect(answers).toHaveLength(2);
    answers[1](new Response('<Code>CertificateMissing</Code>', { status: 404 }));
    expect(await fromA).toBe(401);
    clock += 1;
    answers[0](new Response(publicPem));
    await fromB;

    // Not trusted: the next message asks AWS again, which still says no.
    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    expect(await outcome(post(TOKEN_B, signed()))).toBe(401);
    expect(certFetches()).toBe(3);
  });

  it("a 404 answered just after an earlier fetch's 200, before that 200 is cached, keeps it out", async () => {
    // B's fetch starts first, A's after AWS withdrew the certificate. B's 200
    // arrives first and A's 404 a few microtasks later, while B's request is
    // still on its way to the cache write. Every gap is tried, since which
    // one lands between the two depends on how many awaits sit in that path.
    rows[TOKEN_A].sesTopicArn = TOPIC_B;
    for (let gap = 0; gap <= 15; gap++) {
      controller = newController();
      const answers: Array<{ ok: (pem: string) => void; gone: () => void }> = [];
      const fetchCertificate = jest
        .spyOn(controller as never as { fetchCertificate: () => Promise<string> }, 'fetchCertificate')
        .mockImplementation(
          () =>
            new Promise<string>((resolve, reject) =>
              answers.push({
                ok: resolve,
                gone: () => reject(new CertificateMissingException('gone')),
              }),
            ),
        );
      const fromB = post(TOKEN_B, signed());
      await settle();
      clock += 1;
      const fromA = outcome(post(TOKEN_A, forged()));
      await settle();
      expect(answers).toHaveLength(2);

      answers[0].ok(publicPem);
      for (let tick = 0; tick < gap; tick++) await Promise.resolve();
      answers[1].gone();
      await expect(fromB).resolves.toEqual({ recorded: 1 });
      expect(await fromA).toBe(401);

      // Not trusted: B's next message asks AWS again, which still says no.
      fetchCertificate.mockImplementation(async () => {
        throw new CertificateMissingException('gone');
      });
      expect({ gap, status: await outcome(post(TOKEN_B, signed())) }).toEqual({ gap, status: 401 });
      expect(fetchCertificate).toHaveBeenCalledTimes(3);
    }
  });

  describe('junk', () => {
    const MANY = 700;
    const postRaw = (token: string, body: string) =>
      controller.sesWebhook(token, { body } as never);

    // Each is refused without a certificate or a signature check.
    const cheap: Array<[string, () => Promise<unknown>]> = [
      ['a body that is not JSON', () => postRaw(TOKEN_B, '{not json')],
      ['a body that is not an SNS message', () => post(TOKEN_B, { junk: true })],
      ['a certificate URL not from SNS', () =>
        post(TOKEN_B, forged({ SigningCertURL: 'https://evil.example/c.pem' }))],
      ['a stale timestamp', () =>
        post(TOKEN_B, forged({ Timestamp: new Date(clock - 2 * 3600_000).toISOString() }))],
      ['another topic', () =>
        post(TOKEN_B, forged({ TopicArn: 'arn:aws:sns:ap-south-1:222222222222:other' }))],
      ['a certificate in another region', () =>
        post(TOKEN_B, forged({
          SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0a1b2c.pem',
        }))],
    ];

    it.each(cheap)(`${MANY} a minute with %s block no genuine message`, async (_label, send) => {
      await post(TOKEN_B, signed());
      for (let i = 0; i < MANY; i++) {
        expect([400, 401, 403]).toContain(await outcome(send()));
      }
      expect(certFetches()).toBe(1);
      // A certificate already trusted, and one nobody has fetched yet.
      await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
      await expect(post(TOKEN_B, signed({ SigningCertURL: certUrl(9) }))).resolves.toEqual({
        recorded: 1,
      });
    });

    it(`${MANY} forged signatures on a trusted certificate block no genuine message`, async () => {
      await post(TOKEN_B, signed());
      for (let i = 0; i < MANY; i++) {
        expect(await outcome(post(TOKEN_B, forged()))).toBe(401);
      }
      await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
      await expect(post(TOKEN_B, signed({ SigningCertURL: certUrl(9) }))).resolves.toEqual({
        recorded: 1,
      });
    });

    it('forged signatures on certificates nobody trusts are capped by fetches', async () => {
      await post(TOKEN_B, signed());
      for (let i = 0; i < MANY; i++) {
        await outcome(post(TOKEN_B, forged({ SigningCertURL: certUrl(i % 50) })));
      }
      // Each failure against a fetched certificate cost a fetch, and the
      // fetches ran out.
      expect(certFetches()).toBe(SNS_CERT_FETCHES_PER_MINUTE);
      expect(await outcome(post(TOKEN_B, forged({ SigningCertURL: certUrl(999) })))).toBe(429);
      // A message on a trusted certificate is still checked and accepted.
      await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
      // The cap is the flooded project's own.
      await expect(
        post(TOKEN_A, signed({ TopicArn: TOPIC_A, SigningCertURL: certUrl(998) })),
      ).resolves.toEqual({ recorded: 1 });

      clock += 60_000;
      await expect(
        post(TOKEN_B, signed({ SigningCertURL: certUrl(997), Timestamp: new Date(clock).toISOString() })),
      ).resolves.toEqual({ recorded: 1 });
    });
  });

  describe('a replayed message', () => {
    it('is answered without being recorded again', async () => {
      const message = signed();
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 1 });
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 0 });
      expect(events.ingest).toHaveBeenCalledTimes(1);
      expect(ses.accountId).toHaveBeenCalledTimes(1);
    });

    it('does not spend the allowance genuine events are counted against', async () => {
      const message = signed();
      await post(TOKEN_B, message);
      for (let i = 0; i < SES_WEBHOOK_LIMIT_PER_MINUTE + 10; i++) {
        await post(TOKEN_B, message);
      }
      await expect(post(TOKEN_B, signed())).resolves.toEqual({ recorded: 1 });
      expect(events.ingest).toHaveBeenCalledTimes(2);
    });

    it('is processed again when the first delivery failed, so SNS can retry', async () => {
      const message = signed();
      ses.accountId.mockRejectedValueOnce(new Error('STS down'));
      expect(await outcome(post(TOKEN_B, message))).toBe(503);
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 1 });
    });

    it('is not acknowledged while the first copy is still in flight', async () => {
      // SNS retries a slow delivery. Answering the retry 200 before the first
      // copy has finished would tell SNS it was delivered, and if the first
      // then failed nothing would ever send it again.
      const message = signed();
      let failFirst!: (error: Error) => void;
      ses.accountId.mockImplementationOnce(
        () => new Promise((_, reject) => (failFirst = reject)),
      );
      const first = outcome(post(TOKEN_B, message));
      await settle();
      let retryStatus: number | undefined;
      const retry = outcome(post(TOKEN_B, message)).then((status) => (retryStatus = status));
      await settle();
      expect(retryStatus).toBeUndefined();

      failFirst(new Error('STS down'));
      expect(await first).toBe(503);
      await retry;
      // The retry shares the first copy's failure, so SNS sends it again.
      expect(retryStatus).toBe(503);
      expect(events.ingest).not.toHaveBeenCalled();

      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 1 });
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 0 });
      expect(events.ingest).toHaveBeenCalledTimes(1);
    });

    it('is recorded once when copies arrive together and the first succeeds', async () => {
      const message = signed();
      let ingestFirst!: (recorded: number) => void;
      events.ingest.mockImplementationOnce(() => new Promise((resolve) => (ingestFirst = resolve)));
      const first = post(TOKEN_B, message);
      await settle();
      const retry = post(TOKEN_B, message);
      await settle();
      ingestFirst(1);
      await expect(first).resolves.toEqual({ recorded: 1 });
      await expect(retry).resolves.toEqual({ recorded: 1 });
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 0 });
      expect(events.ingest).toHaveBeenCalledTimes(1);
    });

    it('is told apart per project', async () => {
      await post(TOKEN_B, signed({ MessageId: 'same' }));
      await expect(
        post(TOKEN_A, signed({ MessageId: 'same', TopicArn: TOPIC_A })),
      ).resolves.toEqual({ recorded: 1 });
    });

    it('is not remembered from a forged copy, so the genuine one still counts', async () => {
      // Junk carrying a real message's id must not answer for it.
      const message = signed();
      expect(await outcome(post(TOKEN_B, { ...message, Signature: forged().Signature }))).toBe(401);
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 1 });
    });

    it(`is run again by a later copy once the first has been in flight ${SES_WEBHOOK_IN_FLIGHT_MS / 1000}s`, async () => {
      // A first copy stuck on something unbounded (a database that stopped
      // answering) must not hold every retry for the hour an id is kept.
      const message = signed();
      events.ingest.mockImplementationOnce(() => new Promise(() => undefined));
      void post(TOKEN_B, message);
      await settle();
      clock += SES_WEBHOOK_IN_FLIGHT_MS;
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 1 });
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 0 });
      expect(events.ingest).toHaveBeenCalledTimes(2);
    });
  });

  describe('memory', () => {
    const projectToken = (p: number) => p.toString(16).padStart(48, 'd');

    it(`keeps missing certificates for at most ${SNS_CERT_MISSING_MAX_PROJECTS} projects, however many there are`, async () => {
      fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
      // Projects are unlimited per account: one tenant can hold all of these.
      for (let p = 0; p < 1_000; p++) {
        rows[projectToken(p)] = {
          id: `set-${p}`,
          projectId: `project-${p}`,
          sesTopicArn: TOPIC_B,
          project: { ownerId: `owner-${p}` },
        };
        expect(await outcome(post(projectToken(p), forged({ SigningCertURL: certUrl(p) })))).toBe(401);
      }
      const missing = (controller as never as {
        missingCertificates: { projectCount: number; size: number };
      }).missingCertificates;
      // The cap is below 1,000, so this proves projects were pushed out.
      expect(SNS_CERT_MISSING_MAX_PROJECTS).toBeLessThan(1_000);
      expect(missing.projectCount).toBe(SNS_CERT_MISSING_MAX_PROJECTS);
      expect(missing.size).toBeLessThanOrEqual(
        SNS_CERT_MISSING_MAX_PROJECTS * SNS_CERT_MISSING_PER_PROJECT,
      );
      // The most recent project's answer is still remembered: no new fetch.
      const fetches = certFetches();
      expect(await outcome(post(projectToken(999), forged({ SigningCertURL: certUrl(999) })))).toBe(401);
      expect(certFetches()).toBe(fetches);
    });

    it("a project's own missing certificates push out only its own", async () => {
      fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
      expect(await outcome(post(TOKEN_B, forged()))).toBe(401);
      for (let i = 0; i < SNS_CERT_MISSING_PER_PROJECT * 2; i++) {
        await outcome(post(TOKEN_A, forged({ TopicArn: TOPIC_A, SigningCertURL: certUrl(i) })));
      }
      // B is still spared asking AWS again.
      expect(await outcome(post(TOKEN_B, forged()))).toBe(401);
      expect(certFetches(CERT)).toBe(1);
    });
  });

  describe('a hung STS lookup', () => {
    const STS_TIMEOUT_MS = 100;
    class QuickSts extends SesProvider {
      protected readonly stsTimeoutMs = STS_TIMEOUT_MS;
    }
    let stsAnswers: 'hang' | 'answer';

    beforeEach(() => {
      stsAnswers = 'hang';
      controller = new EmailPublicController(
        settings as never,
        {} as never,
        {} as never,
        events as never,
        new QuickSts(),
      );
      fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith('.pem')) return new Response(publicPem);
        if (stsAnswers === 'answer') {
          return new Response('<GetCallerIdentityResult><Account>222222222222</Account></GetCallerIdentityResult>');
        }
        // Never answers; only the caller's signal ends it.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      });
    });

    /** The status, or 'hung' if none came within a second. */
    const within = (promise: Promise<number>) =>
      Promise.race([promise, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1_000))]);

    it('answers 503 within the timeout, and so does a copy that waited on it', async () => {
      const message = signed();
      const first = outcome(post(TOKEN_B, message));
      await settle();
      const retry = outcome(post(TOKEN_B, message));
      expect(await within(first)).toBe(503);
      expect(await within(retry)).toBe(503);

      // Nothing is stuck: the next copy asks STS again and goes through.
      stsAnswers = 'answer';
      await expect(post(TOKEN_B, message)).resolves.toEqual({ recorded: 1 });
      expect(events.ingest).toHaveBeenCalledTimes(1);
    });
  });
});
