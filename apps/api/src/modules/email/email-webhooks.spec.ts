import { createHmac, createSign, generateKeyPairSync } from 'crypto';
import {
  SNS_REGIONS,
  SnsMessage,
  isSnsCertUrl,
  snsCertCacheKey,
  snsCertRegion,
  BoundedCache,
  SeenMessages,
  WindowLimiter,
  parseBrevoEvent,
  parseResendEvent,
  parseSesEvent,
  verifySnsSignature,
  verifySvix,
} from './email-webhooks';
import {
  SES_WEBHOOK_SEEN_MESSAGES,
  SES_WEBHOOK_IN_FLIGHT_MS,
  SES_WEBHOOK_SEEN_MESSAGES_PER_PROJECT,
} from './email-public.controller';

const CAMPAIGN = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const IDENTITY = '11111111-2222-4333-8444-555555555555';

describe('verifySvix', () => {
  const key = Buffer.from('resend-webhook-test-key-32-bytes!');
  const secret = `whsec_${key.toString('base64')}`;
  const body = '{"type":"email.delivered"}';
  const now = new Date('2026-11-01T10:00:00Z');
  const timestamp = String(now.getTime() / 1000);
  const sign = (payload: string) =>
    createHmac('sha256', key).update(`msg_1.${timestamp}.${payload}`).digest('base64');

  it('accepts a body signed with the secret', () => {
    expect(
      verifySvix(secret, { id: 'msg_1', timestamp, signature: `v1,${sign(body)}` }, body, now),
    ).toBe(true);
  });

  it('accepts any of several signatures during a rotation', () => {
    const signature = `v1,${Buffer.alloc(32).toString('base64')} v1,${sign(body)}`;
    expect(verifySvix(secret, { id: 'msg_1', timestamp, signature }, body, now)).toBe(true);
  });

  it('refuses a body that was altered after signing', () => {
    expect(
      verifySvix(
        secret,
        { id: 'msg_1', timestamp, signature: `v1,${sign(body)}` },
        '{"type":"email.bounced"}',
        now,
      ),
    ).toBe(false);
  });

  it('refuses a replay outside the five-minute window', () => {
    const later = new Date(now.getTime() + 6 * 60 * 1000);
    expect(
      verifySvix(secret, { id: 'msg_1', timestamp, signature: `v1,${sign(body)}` }, body, later),
    ).toBe(false);
  });
});

describe('SNS signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const base: SnsMessage = {
    Type: 'Notification',
    MessageId: 'm-1',
    TopicArn: 'arn:aws:sns:ap-south-1:123456789012:chumbaq-ses',
    Message: '{"eventType":"Delivery"}',
    Timestamp: '2026-11-01T10:00:00.000Z',
    SignatureVersion: '2',
    Signature: '',
    SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc.pem',
  };

  const signed = (message: SnsMessage): SnsMessage => {
    const canonical =
      `Message\n${message.Message}\nMessageId\n${message.MessageId}\n` +
      `Timestamp\n${message.Timestamp}\nTopicArn\n${message.TopicArn}\nType\n${message.Type}\n`;
    return {
      ...message,
      Signature: createSign('RSA-SHA256').update(canonical).sign(privateKey, 'base64'),
    };
  };

  it('verifies a notification signed by the certificate key', () => {
    expect(verifySnsSignature(signed(base), publicPem)).toBe(true);
  });

  it('rejects a notification whose message was swapped', () => {
    const forged = { ...signed(base), Message: '{"eventType":"Complaint"}' };
    expect(verifySnsSignature(forged, publicPem)).toBe(false);
  });

  it('only trusts certificates served by SNS', () => {
    expect(isSnsCertUrl(base.SigningCertURL)).toBe(true);
    expect(isSnsCertUrl('https://sns.ap-south-1.amazonaws.com.evil.example/x.pem')).toBe(false);
    expect(isSnsCertUrl('http://sns.ap-south-1.amazonaws.com/x.pem')).toBe(false);
    expect(isSnsCertUrl('https://evil.example/sns.us-east-1.amazonaws.com.pem')).toBe(false);
  });

  it.each([
    'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem',
    'https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc123.pem',
    'https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-abc123.pem',
    'https://sns.cn-northwest-1.amazonaws.com.cn/SimpleNotificationService-abc123.pem',
    'https://sns.us-gov-east-1.amazonaws.com/SimpleNotificationService-abc123.pem',
    'https://sns.eu-central-2.amazonaws.com/SimpleNotificationService-abc123.pem',
    'https://sns.mx-central-1.amazonaws.com/SimpleNotificationService-abc123.pem',
  ])('accepts the URL SNS really sends: %s', (url) => {
    expect(isSnsCertUrl(url)).toBe(true);
  });

  it('accepts every listed region on its own domain only', () => {
    const url = (host: string) => `https://${host}/SimpleNotificationService-abc123.pem`;
    for (const region of [...SNS_REGIONS.commercial, ...SNS_REGIONS.govCloud]) {
      expect(isSnsCertUrl(url(`sns.${region}.amazonaws.com`))).toBe(true);
      expect(isSnsCertUrl(url(`sns.${region}.amazonaws.com.cn`))).toBe(false);
    }
    for (const region of SNS_REGIONS.china) {
      expect(isSnsCertUrl(url(`sns.${region}.amazonaws.com.cn`))).toBe(true);
      expect(isSnsCertUrl(url(`sns.${region}.amazonaws.com`))).toBe(false);
    }
  });

  // Each of these still names an SNS host, but a different string per request
  // would be a fresh cache entry and a fresh fetch, so only the one canonical
  // form is trusted.
  it.each([
    ['a query string', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem?n=1'],
    ['an empty query string', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem?'],
    ['a fragment', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem#n'],
    ['the default port spelled out', 'https://sns.us-east-1.amazonaws.com:443/SimpleNotificationService-abc.pem'],
    ['another port', 'https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-abc.pem'],
    ['a username', 'https://n@sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a username and password', 'https://n:p@sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['another file name', 'https://sns.us-east-1.amazonaws.com/other.pem'],
    ['a name that is not hex', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-xyz.pem'],
    ['a nested path', 'https://sns.us-east-1.amazonaws.com/a/SimpleNotificationService-abc.pem'],
    ['dot segments', 'https://sns.us-east-1.amazonaws.com/a/../SimpleNotificationService-abc.pem'],
    ['an encoded path', 'https://sns.us-east-1.amazonaws.com/%53impleNotificationService-abc.pem'],
    ['upper-case host', 'https://SNS.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a trailing dot on the host', 'https://sns.us-east-1.amazonaws.com./SimpleNotificationService-abc.pem'],
    ['a host that is not a region', 'https://sns.evil.amazonaws.com/SimpleNotificationService-abc.pem'],
    // Shaped like a region, so a pattern accepted it, but AWS has no such
    // region: every made-up one was another outbound fetch.
    ['a made-up region', 'https://sns.xx-fake-9.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a made-up region number', 'https://sns.us-east-99.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a China region on the global domain', 'https://sns.cn-north-1.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a global region on the China domain', 'https://sns.us-east-1.amazonaws.com.cn/SimpleNotificationService-abc.pem'],
    ['surrounding whitespace', ' https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem'],
    ['a non-string', 42 as unknown as string],
  ])('refuses a certificate URL with %s', (_label, url) => {
    expect(isSnsCertUrl(url)).toBe(false);
  });

  it('keys a certificate on origin and path only', () => {
    expect(snsCertCacheKey('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem')).toBe(
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem',
    );
  });
});

describe('BoundedCache', () => {
  it('keeps at most its capacity, dropping the least recently used', () => {
    const cache = new BoundedCache<string>(2, 60_000);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.get('a')).toBe('1'); // a is now the most recent
    cache.set('c', '3');
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
  });

  it('forgets an entry once it expires', () => {
    let now = 1_000;
    const cache = new BoundedCache<string>(2, 60_000, () => now);
    cache.set('a', '1');
    now += 59_999;
    expect(cache.get('a')).toBe('1');
    now += 2;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('parseSesEvent', () => {
  const mail = {
    destination: ['Priya@Example.com'],
    tags: { chumbaq_campaign_id: [CAMPAIGN], chumbaq_identity_id: [IDENTITY] },
  };

  it('reads a permanent bounce as a suppressible bounce', () => {
    const events = parseSesEvent(
      JSON.stringify({
        eventType: 'Bounce',
        mail,
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            { emailAddress: 'priya@example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' },
          ],
          timestamp: '2026-11-01T10:00:00.000Z',
        },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'bounced',
        address: 'priya@example.com',
        campaignId: CAMPAIGN,
        identityId: IDENTITY,
        permanent: true,
        detail: 'General: smtp; 550 5.1.1 user unknown',
      }),
    ]);
  });

  it('does not treat a transient bounce as permanent', () => {
    const [event] = parseSesEvent(
      JSON.stringify({
        eventType: 'Bounce',
        mail,
        bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@b.co' }] },
      }),
    );
    expect(event.permanent).toBe(false);
  });

  it('maps opens and clicks onto the push engagement types', () => {
    expect(parseSesEvent(JSON.stringify({ eventType: 'Open', mail }))[0].type).toBe('impression');
    expect(parseSesEvent(JSON.stringify({ eventType: 'Click', mail }))[0].type).toBe('click');
  });

  it('reads identity feedback notifications too', () => {
    const [event] = parseSesEvent(
      JSON.stringify({
        notificationType: 'Complaint',
        mail,
        complaint: { complainedRecipients: [{ emailAddress: 'priya@example.com' }] },
      }),
    );
    expect(event).toMatchObject({ type: 'complained', address: 'priya@example.com' });
  });

  it('drops a tag that is not a uuid rather than trusting it', () => {
    const [event] = parseSesEvent(
      JSON.stringify({
        eventType: 'Delivery',
        mail: { ...mail, tags: { chumbaq_campaign_id: ["x' OR 1=1"] } },
      }),
    );
    expect(event.campaignId).toBeNull();
  });
});

describe('parseResendEvent', () => {
  it('reads a hard bounce with object-shaped tags', () => {
    const [event] = parseResendEvent({
      type: 'email.bounced',
      created_at: '2026-11-01T10:00:00.000Z',
      data: {
        to: ['priya@example.com'],
        tags: { chumbaq_campaign_id: CAMPAIGN, chumbaq_identity_id: IDENTITY },
        bounce: { type: 'Permanent', subType: 'Suppressed', message: 'Recipient suppressed' },
      },
    });
    expect(event).toMatchObject({
      type: 'bounced',
      permanent: true,
      campaignId: CAMPAIGN,
      identityId: IDENTITY,
    });
  });

  it('reads list-shaped tags', () => {
    const [event] = parseResendEvent({
      type: 'email.clicked',
      data: {
        to: ['priya@example.com'],
        tags: [{ name: 'chumbaq_campaign_id', value: CAMPAIGN }],
      },
    });
    expect(event).toMatchObject({ type: 'click', campaignId: CAMPAIGN, identityId: null });
  });

  it('ignores events Chumbaq does not record', () => {
    expect(parseResendEvent({ type: 'email.sent', data: { to: ['a@b.co'] } })).toEqual([]);
  });
});

describe('parseBrevoEvent', () => {
  // Shape from Brevo's transactional webhook documentation.
  const base = {
    email: 'Priya@Example.com',
    'message-id': '<202611011000.123@smtp-relay.mailin.fr>',
    date: '2026-11-01 11:00:00',
    ts_event: 1793530800,
    tags: [`chumbaq_campaign_id:${CAMPAIGN}`, `chumbaq_identity_id:${IDENTITY}`],
  };

  it('reads a hard bounce with its reason', () => {
    const [event] = parseBrevoEvent({ ...base, event: 'hard_bounce', reason: '550 user unknown' });
    expect(event).toMatchObject({
      type: 'bounced',
      permanent: true,
      address: 'priya@example.com',
      campaignId: CAMPAIGN,
      identityId: IDENTITY,
      detail: 'hard_bounce: 550 user unknown',
    });
    expect(event.occurredAt.toISOString()).toBe(new Date(1793530800 * 1000).toISOString());
  });

  it('does not treat a soft bounce as permanent', () => {
    expect(parseBrevoEvent({ ...base, event: 'soft_bounce' })[0].permanent).toBe(false);
  });

  it('maps every kind of open to an impression, and spam to a complaint', () => {
    for (const name of ['opened', 'unique_opened', 'proxy_open']) {
      expect(parseBrevoEvent({ ...base, event: name })[0].type).toBe('impression');
    }
    expect(parseBrevoEvent({ ...base, event: 'spam' })[0].type).toBe('complained');
    expect(parseBrevoEvent({ ...base, event: 'unsubscribed' })[0].type).toBe('unsubscribed');
  });

  it('reads a batched body', () => {
    const events = parseBrevoEvent([
      { ...base, event: 'delivered' },
      { ...base, event: 'click', link: 'https://shop.example' },
    ]);
    expect(events.map((e) => e.type)).toEqual(['delivered', 'click']);
  });

  it('ignores events it does not record and tags it did not write', () => {
    expect(parseBrevoEvent({ ...base, event: 'request' })).toEqual([]);
    const [event] = parseBrevoEvent({ ...base, event: 'delivered', tags: ['newsletter'] });
    expect(event.campaignId).toBeNull();
  });
});

describe('snsCertRegion', () => {
  it("reads the region from each partition's certificate host", () => {
    const pem = '/SimpleNotificationService-0a.pem';
    expect(snsCertRegion(`https://sns.ap-south-1.amazonaws.com${pem}`)).toBe('ap-south-1');
    expect(snsCertRegion(`https://sns.cn-north-1.amazonaws.com.cn${pem}`)).toBe('cn-north-1');
    expect(snsCertRegion(`https://sns.us-gov-west-1.amazonaws.com${pem}`)).toBe('us-gov-west-1');
  });
});

describe('BoundedCache expiry set by the caller', () => {
  it('keeps the age it was given and forgets a deleted entry', () => {
    let clock = 1_000;
    const cache = new BoundedCache<string>(4, 100, () => clock);
    // Obtained 60 ms ago: 40 ms left, not 100.
    cache.set('k', 'v', clock + 40);
    clock += 39;
    expect(cache.get('k')).toBe('v');
    clock += 1;
    expect(cache.get('k')).toBeUndefined();

    cache.set('k', 'v');
    cache.delete('k');
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('WindowLimiter.used', () => {
  it('reports the current window without counting, and nothing once it ends', () => {
    let clock = 0;
    const limiter = new WindowLimiter(2, 60_000, 10, () => clock);
    expect(limiter.used('p')).toBe(0);
    limiter.take('p');
    limiter.take('p');
    limiter.take('p');
    expect(limiter.used('p')).toBe(3);
    expect(limiter.used('p')).toBe(3);
    clock = 60_000;
    expect(limiter.used('p')).toBe(0);
  });
});

describe('WindowLimiter bounds', () => {
  it('keeps at most maxKeys windows, however many projects arrive within one window', () => {
    const limiter = new WindowLimiter(2, 60_000, 3, () => 0);
    for (let p = 0; p < 1_000; p++) expect(limiter.take(`p-${p}`)).toBe(true);
    expect(limiter.size).toBe(3);
  });

  it('when full, forgets the oldest window, which only gives that key a fresh allowance', () => {
    const limiter = new WindowLimiter(2, 60_000, 3, () => 0);
    limiter.take('busy');
    limiter.take('busy');
    expect(limiter.take('busy')).toBe(false);
    // A newcomer is never refused for want of room.
    for (const key of ['b', 'c', 'd']) expect(limiter.take(key)).toBe(true);
    expect(limiter.used('busy')).toBe(0);
    expect(limiter.take('busy')).toBe(true);
  });

  it('keeps windows in order of their start, so expired ones go first', () => {
    let clock = 0;
    const limiter = new WindowLimiter(5, 60_000, 2, () => clock);
    limiter.take('p');
    clock = 10;
    limiter.take('q');
    // p starts a new window, so q's is now the oldest.
    clock = 60_000;
    limiter.take('p');
    clock = 60_005;
    limiter.take('r');
    expect(limiter.size).toBe(2);
    expect(limiter.used('p')).toBe(1);
    expect(limiter.used('q')).toBe(0);
  });
});

describe('SeenMessages', () => {
  /** Work the test settles by hand, to hold a message in flight. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const settle = () => new Promise((r) => setImmediate(r));
  const REPLAYED = 'replayed';

  it('runs a message once and answers a later copy as a replay, for that project only', async () => {
    const seen = new SeenMessages<string>(100, 10, 60_000, 60_000, () => 0);
    const work = jest.fn(async () => 'done');
    await expect(seen.run('a', 'm-1', work, REPLAYED)).resolves.toBe('done');
    await expect(seen.run('a', 'm-1', work, REPLAYED)).resolves.toBe(REPLAYED);
    await expect(seen.run('b', 'm-1', work, REPLAYED)).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('forgets a message once its time is up', async () => {
    let clock = 0;
    const seen = new SeenMessages<string>(100, 10, 60_000, 60_000, () => clock);
    const work = jest.fn(async () => 'done');
    await seen.run('a', 'm-1', work, REPLAYED);
    clock = 59_999;
    await expect(seen.run('a', 'm-1', work, REPLAYED)).resolves.toBe(REPLAYED);
    clock = 60_000;
    await expect(seen.run('a', 'm-1', work, REPLAYED)).resolves.toBe('done');
  });

  it('never answers a copy as done while the first is still in flight', async () => {
    const seen = new SeenMessages<string>(100, 10, 60_000, 60_000, () => 0);
    const first = deferred<string>();
    const work = jest.fn(() => first.promise);
    const one = seen.run('a', 'm-1', work, REPLAYED);
    let secondAnswer: string | undefined;
    const two = seen.run('a', 'm-1', work, REPLAYED).then((v) => (secondAnswer = v));
    await settle();
    // SNS takes any 2xx as delivered, so an early answer here would be final.
    expect(secondAnswer).toBeUndefined();
    first.resolve('done');
    await expect(one).resolves.toBe('done');
    await two;
    expect(secondAnswer).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('fails a copy that waited on a first that failed, and lets the next one through', async () => {
    const seen = new SeenMessages<string>(100, 10, 60_000, 60_000, () => 0);
    const first = deferred<string>();
    const one = seen.run('a', 'm-1', () => first.promise, REPLAYED);
    const two = seen.run('a', 'm-1', async () => 'second ran', REPLAYED);
    const failure = new Error('STS down');
    first.reject(failure);
    await expect(one).rejects.toBe(failure);
    await expect(two).rejects.toBe(failure);
    await expect(seen.run('a', 'm-1', async () => 'retried', REPLAYED)).resolves.toBe('retried');
    await expect(seen.run('a', 'm-1', async () => 'again', REPLAYED)).resolves.toBe(REPLAYED);
  });

  it('pushes out a project\'s own oldest ids first, never another project\'s', async () => {
    const seen = new SeenMessages<string>(100, 10, 60_000, 60_000, () => 0);
    await seen.run('b', 'keep', async () => 'done', REPLAYED);
    for (let i = 0; i < 1_000; i++) await seen.run('a', `m-${i}`, async () => 'done', REPLAYED);
    await expect(seen.run('b', 'keep', async () => 'again', REPLAYED)).resolves.toBe(REPLAYED);
    await expect(seen.run('a', 'm-999', async () => 'again', REPLAYED)).resolves.toBe(REPLAYED);
    await expect(seen.run('a', 'm-989', async () => 'again', REPLAYED)).resolves.toBe('again');
  });

  it('lets a project failing over and over push out another project\'s id at most once', async () => {
    const seen = new SeenMessages<string>(10, 10, 60_000, 60_000, () => 0);
    for (let i = 0; i < 8; i++) await seen.run('victim', `v-${i}`, async () => 'done', REPLAYED);
    await seen.run('busy', 'c-0', async () => 'done', REPLAYED);
    await seen.run('busy', 'c-00', async () => 'done', REPLAYED);
    // The store is full. A project over its rate limit fails every copy (429). Had a failure
    // emptied its share, each retry would arrive as a project with no ids and
    // push out the oldest id overall, as often as it liked, while a busy
    // third project kept refilling the freed slot.
    for (let i = 1; i <= 5; i++) {
      await expect(
        seen.run('flood', 'm-1', async () => Promise.reject(new Error('429')), REPLAYED),
      ).rejects.toThrow('429');
      await seen.run('busy', `c-${i}`, async () => 'done', REPLAYED);
    }
    // Newest first, stopping at the first one forgotten: running that one
    // again stores it, which pushes out the victim's own oldest.
    let kept = 0;
    for (let i = 7; i >= 0; i--) {
      if ((await seen.run('victim', `v-${i}`, async () => 'ran', REPLAYED)) !== REPLAYED) break;
      kept++;
    }
    expect(kept).toBe(7);
  });

  it('stays bounded in total across 1,000 projects, at the limits the webhook uses', async () => {
    const seen = new SeenMessages<string>(
      SES_WEBHOOK_SEEN_MESSAGES,
      SES_WEBHOOK_SEEN_MESSAGES_PER_PROJECT,
      60_000,
      SES_WEBHOOK_IN_FLIGHT_MS,
      () => 0,
    );
    // Projects are unlimited per account, so one tenant can post its own
    // genuine messages across as many as it likes.
    for (let p = 0; p < 1_000; p++) {
      for (let i = 0; i < 150; i++) await seen.run(`p-${p}`, `m-${i}`, async () => 'done', REPLAYED);
    }
    expect(seen.size).toBe(SES_WEBHOOK_SEEN_MESSAGES);
    expect(SES_WEBHOOK_SEEN_MESSAGES).toBeLessThanOrEqual(100_000);
  });

  it('leaves room for other projects when one fills the store, at the limits the webhook uses', async () => {
    const seen = new SeenMessages<string>(
      SES_WEBHOOK_SEEN_MESSAGES,
      SES_WEBHOOK_SEEN_MESSAGES_PER_PROJECT,
      60_000,
      SES_WEBHOOK_IN_FLIGHT_MS,
      () => 0,
    );
    for (let i = 0; i < SES_WEBHOOK_SEEN_MESSAGES; i++) {
      await seen.run('flood', `m-${i}`, async () => 'done', REPLAYED);
    }
    // Were a project's share the whole store, the flood would hold all of it
    // and the bystander would keep one id: each new one pushing out its last.
    for (let i = 0; i < 100; i++) await seen.run('bystander', `b-${i}`, async () => 'done', REPLAYED);
    let remembered = 0;
    for (let i = 0; i < 100; i++) {
      const answer = await seen.run('bystander', `b-${i}`, async () => 'again', REPLAYED);
      if (answer === REPLAYED) remembered++;
    }
    expect(remembered).toBe(100);
  });

  it('lets a copy run the work itself once the first has been in flight past its lifetime', async () => {
    let clock = 0;
    const seen = new SeenMessages<string>(100, 10, 60_000, 30_000, () => clock);
    const hung = deferred<string>();
    const work = jest.fn(() => hung.promise);
    void seen.run('a', 'm-1', work, REPLAYED);
    clock = 29_999;
    let waited: string | undefined;
    void seen.run('a', 'm-1', work, REPLAYED).then((v) => (waited = v));
    await settle();
    expect(waited).toBeUndefined();
    expect(work).toHaveBeenCalledTimes(1);

    clock = 30_000;
    await expect(seen.run('a', 'm-1', async () => 'ran again', REPLAYED)).resolves.toBe('ran again');
    // Done now, for the full lifetime from that run's success.
    clock = 30_000 + 59_999;
    await expect(seen.run('a', 'm-1', async () => 'third', REPLAYED)).resolves.toBe(REPLAYED);
  });

  it('a superseded run that fails leaves the newer run in place', async () => {
    let clock = 0;
    const seen = new SeenMessages<string>(100, 10, 60_000, 30_000, () => clock);
    const first = deferred<string>();
    const second = deferred<string>();
    const one = seen.run('a', 'm-1', () => first.promise, REPLAYED);
    clock = 30_000;
    const two = seen.run('a', 'm-1', () => second.promise, REPLAYED);
    first.reject(new Error('late failure'));
    await expect(one).rejects.toThrow('late failure');

    // A third copy still waits for the second run rather than starting its own.
    const third = jest.fn(async () => 'third ran');
    const three = seen.run('a', 'm-1', third, REPLAYED);
    second.resolve('second done');
    await expect(two).resolves.toBe('second done');
    await expect(three).resolves.toBe('second done');
    expect(third).not.toHaveBeenCalled();
    await expect(seen.run('a', 'm-1', third, REPLAYED)).resolves.toBe(REPLAYED);
  });

  it('a run pushed out of the store does not come back when it finishes and push out a newer id', async () => {
    const seen = new SeenMessages<string>(100, 2, 60_000, 30_000, () => 0);
    const old = deferred<string>();
    const newer = deferred<string>();
    const oldRun = seen.run('a', 'old', () => old.promise, REPLAYED);
    const newerRun = seen.run('a', 'newer', () => newer.promise, REPLAYED);
    // The project's share is 2, so this pushes out 'old' while it runs.
    await seen.run('a', 'newest', async () => 'done', REPLAYED);
    old.resolve('old done');
    await oldRun;
    await settle();

    // 'newer' is still in flight: a copy must wait for it, not run again.
    const copy = jest.fn(async () => 'copy ran');
    const copyRun = seen.run('a', 'newer', copy, REPLAYED);
    newer.resolve('newer done');
    await expect(newerRun).resolves.toBe('newer done');
    await expect(copyRun).resolves.toBe('newer done');
    expect(copy).not.toHaveBeenCalled();
  });
});
