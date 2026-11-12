import { BadRequestException, Logger } from '@nestjs/common';

// Every Resolver the code makes is this one stub, so a test decides what DNS
// answers for A and AAAA, or that it never answers at all.
jest.mock('dns/promises', () => {
  const resolver = { resolve4: jest.fn(), resolve6: jest.fn() };
  return { Resolver: jest.fn(() => resolver), resolverStub: resolver };
});
import * as dns from 'dns/promises';
import * as net from 'net';
import {
  WEBHOOK_DNS_CACHE_MAX_PROJECTS,
  WEBHOOK_DNS_CACHE_MAX_ENTRIES_PER_PROJECT,
  WEBHOOK_DNS_CACHE_MS,
  WebhookDnsCache,
  WebhookHostRefusedException,
  isLocalHostname,
  isPrivateAddress,
  resolvePublicWebhookTarget,
} from './webhook-address';
import { WEBHOOK_COOLDOWN_START_MS } from './webhook-cooldown';
import { webhookCacheKey } from './per-project-lru';

const resolver = (jest.requireMock('dns/promises') as any).resolverStub as {
  resolve4: jest.Mock;
  resolve6: jest.Mock;
};
const noData = (rrtype: string) =>
  Promise.reject(Object.assign(new Error(`query${rrtype} ENODATA`), { code: 'ENODATA' }));
/** DNS answers every name with these addresses, split into A and AAAA. */
const dnsAnswers = (...addresses: string[]) => {
  const v4 = addresses.filter((a) => net.isIPv4(a));
  const v6 = addresses.filter((a) => net.isIPv6(a));
  resolver.resolve4.mockImplementation(() => (v4.length ? Promise.resolve(v4) : noData('A')));
  resolver.resolve6.mockImplementation(() => (v6.length ? Promise.resolve(v6) : noData('AAAA')));
};
const askedDns = () => resolver.resolve4.mock.calls.length + resolver.resolve6.mock.calls.length;

describe('isPrivateAddress', () => {
  it.each([
    // IPv4 ranges
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'RFC 1918'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT top'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback top'],
    ['169.254.169.254', 'link-local metadata'],
    ['172.16.0.1', 'RFC 1918'],
    ['172.31.255.255', 'RFC 1918 top'],
    ['192.0.0.8', 'IETF assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.1.1', 'RFC 1918'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking top'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    // IPv6
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback, uncompressed'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone'],
    ['febf::1', 'link-local top'],
    ['fec0::1', 'site-local'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['100::1', 'discard'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
    ['64:ff9b:1::1', 'NAT64 local use'],
    // IPv4 embedded in IPv6: the bypass forms
    ['::ffff:7f00:1', 'mapped loopback, hex (what URL produces)'],
    ['::ffff:127.0.0.1', 'mapped loopback, dotted'],
    ['::FFFF:7F00:1', 'mapped loopback, upper case'],
    ['::ffff:a9fe:a9fe', 'mapped metadata, hex'],
    ['::ffff:169.254.169.254', 'mapped metadata, dotted'],
    ['0:0:0:0:0:ffff:a00:1', 'mapped 10/8, uncompressed'],
    ['::ffff:0:7f00:1', 'SIIT translated loopback'],
    ['::7f00:1', 'compatible loopback, hex'],
    ['::127.0.0.1', 'compatible loopback, dotted'],
    ['::8.8.8.8', 'compatible, even public (deprecated)'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::169.254.169.254', 'NAT64 metadata, dotted'],
    ['2002:7f00:1::', '6to4 loopback'],
    ['2002:a9fe:a9fe::1', '6to4 metadata'],
    ['2002:c0a8:101::', '6to4 192.168.1.1'],
    // Not addresses at all
    ['localhost', 'a name'],
    ['', 'empty'],
    ['1.2.3', 'short'],
    ['[::1]', 'bracketed loopback'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    ['93.184.216.34'],
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['100.63.255.255'], // just below CGNAT
    ['100.128.0.0'], // just above CGNAT
    ['172.15.255.255'],
    ['172.32.0.0'],
    ['198.20.0.0'],
    ['223.255.255.254'],
    ['2606:4700:4700::1111'],
    ['2a00:1450:4001:82a::200e'],
    ['::ffff:8.8.8.8'], // mapped public
    ['::ffff:808:808'],
    ['64:ff9b::808:808'], // NAT64 to a public address
    ['2002:808:808::1'], // 6to4 of a public address
    ['[2606:4700:4700::1111]'],
  ])('allows public %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('isLocalHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'a.b.localhost..'])('%s is local', (h) => {
    expect(isLocalHostname(h)).toBe(true);
  });
  it.each(['example.com', 'localhost.example.com', 'notlocalhost'])('%s is not', (h) => {
    expect(isLocalHostname(h)).toBe(false);
  });
});

describe('resolvePublicWebhookTarget', () => {
  beforeEach(() => {
    resolver.resolve4.mockReset();
    resolver.resolve6.mockReset();
    dnsAnswers('93.184.216.34');
  });

  // WHATWG URL rewrites every one of these to a loopback or metadata literal
  // before the guard sees it; this pins that the guard sees the rewrite.
  it.each([
    'http://[::ffff:127.0.0.1]:6379/',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[2002:7f00:1::]/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::]/',
    'http://2130706433/', // decimal
    'http://0x7f.1/', // hex, short form
    'http://0x7f000001/',
    'http://017700000001/', // octal
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://127.0.0.1./',
    'http://%31%32%37.0.0.1/', // percent-encoded
    'http://0/',
    'http://2852039166/', // 169.254.169.254 in decimal
  ])('refuses %s without asking DNS', async (url) => {
    await expect(resolvePublicWebhookTarget(url)).rejects.toThrow(BadRequestException);
    expect(askedDns()).toBe(0);
  });

  it.each(['http://localhost/', 'http://LOCALHOST:8080/', 'http://localhost./', 'http://redis.localhost/'])(
    'refuses %s even if DNS would call it public',
    async (url) => {
      await expect(resolvePublicWebhookTarget(url)).rejects.toThrow(BadRequestException);
      expect(askedDns()).toBe(0);
    },
  );

  // A distinct message per reason would tell a tenant which names the API
  // host can resolve internally (redis, postgres, *.internal): try a name,
  // read whether it "resolves to a private address" or "could not be
  // resolved". Every refusal of the host reads the same.
  describe('says the same thing whatever was wrong with the host', () => {
    const PUBLIC_ONLY = 'Webhook URL must resolve to a public address';

    it.each([
      ['an internal name', () => dnsAnswers('10.0.0.7'), 'https://redis/'],
      [
        'a name DNS does not know',
        () => {
          const notFound = () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
          resolver.resolve4.mockImplementation(notFound);
          resolver.resolve6.mockImplementation(notFound);
        },
        'https://nope.invalid/',
      ],
      ['a name with no records', () => dnsAnswers(), 'https://empty.example.com/'],
      [
        'a name whose nameserver never answers',
        () => {
          resolver.resolve4.mockImplementation(() => new Promise(() => undefined));
          resolver.resolve6.mockImplementation(() => new Promise(() => undefined));
        },
        'https://silent.example.com/',
      ],
      ['a private literal', () => undefined, 'http://10.0.0.7/'],
      ['localhost', () => undefined, 'http://localhost/'],
    ])('for %s', async (_label, arrange, url) => {
      arrange();
      const err = await resolvePublicWebhookTarget(url, 50).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getStatus()).toBe(400);
      expect((err as BadRequestException).message).toBe(PUBLIC_ONLY);
    });
  });

  it('refuses a name if any of its addresses is private', async () => {
    dnsAnswers('93.184.216.34', '::ffff:7f00:1');
    await expect(resolvePublicWebhookTarget('https://dual.example.com/')).rejects.toThrow(
      'Webhook URL must resolve to a public address',
    );
  });

  it('refuses credentials in the URL', async () => {
    await expect(resolvePublicWebhookTarget('https://u:p@example.com/hook')).rejects.toThrow(
      'Webhook URL must not contain credentials',
    );
  });

  it('returns the addresses it checked, for the request to use', async () => {
    dnsAnswers('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    const target = await resolvePublicWebhookTarget('https://example.com/hook?x=1');
    expect(target.hostname).toBe('example.com');
    expect(target.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    expect(resolver.resolve4).toHaveBeenCalledTimes(1);
    expect(resolver.resolve6).toHaveBeenCalledTimes(1);
  });

  it('uses a public literal as its own address, unbracketed', async () => {
    const target = await resolvePublicWebhookTarget('https://[2606:4700:4700::1111]:8443/x');
    expect(target.hostname).toBe('2606:4700:4700::1111');
    expect(target.addresses).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
    expect(askedDns()).toBe(0);
  });
  it('uses the A records when the name has no AAAA, and the other way round', async () => {
    dnsAnswers('93.184.216.34');
    expect((await resolvePublicWebhookTarget('https://v4.example.com/')).addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    dnsAnswers('2606:4700:4700::1111');
    expect((await resolvePublicWebhookTarget('https://v6.example.com/')).addresses).toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('refuses a name whose AAAA is private even when its A is still pending', async () => {
    resolver.resolve4.mockImplementation(() => new Promise(() => undefined));
    resolver.resolve6.mockResolvedValue(['::1']);
    await expect(resolvePublicWebhookTarget('https://half.example.com/', 50)).rejects.toThrow(
      'Webhook URL must resolve to a public address',
    );
  });

  // getaddrinfo ran on libuv's four-thread pool with no time limit, so a
  // tenant nameserver that drops queries held a thread for tens of seconds,
  // and bcrypt, fs and crypto for every tenant queued behind it.
  it('asks DNS through a resolver with its own time limit, not getaddrinfo', async () => {
    await resolvePublicWebhookTarget('https://example.com/');
    const options = (dns.Resolver as unknown as jest.Mock).mock.calls[0][0];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.tries).toBeGreaterThan(0);
  });

  it('gives up on a nameserver that never answers once its time is up', async () => {
    resolver.resolve4.mockImplementation(() => new Promise(() => undefined));
    resolver.resolve6.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(resolvePublicWebhookTarget('https://silent.example.com/', 100)).rejects.toThrow(
      'Webhook URL must resolve to a public address',
    );
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(1000);
  });
});

// Every delivery resolves its host again. Without a cache, a project whose
// webhooks point at a name with no records sent a query to the tenant's
// nameserver, and wrote a log line, for every webhook on every click.
describe('resolvePublicWebhookTarget with a delivery cache', () => {
  const asDelivery = (cache: WebhookDnsCache, projectId = 'p1', fullBudget = true) => ({
    cache,
    projectId,
    fullBudget,
  });
  const notFound = () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));

  beforeEach(() => {
    resolver.resolve4.mockReset();
    resolver.resolve6.mockReset();
    dnsAnswers('93.184.216.34');
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => jest.useRealTimers());

  it('answers a refused name from the cache for the cool-down, without asking DNS', async () => {
    resolver.resolve4.mockImplementation(notFound);
    resolver.resolve6.mockImplementation(notFound);
    const cache = new WebhookDnsCache();

    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache))).rejects.toThrow(
      'Webhook URL must resolve to a public address',
    );
    expect(askedDns()).toBe(2);
    for (let i = 0; i < 20; i++) {
      await expect(resolvePublicWebhookTarget('https://gone.example.com/x', 50, asDelivery(cache))).rejects.toThrow(
        'Webhook URL must resolve to a public address',
      );
    }
    expect(askedDns()).toBe(2);

    // Once the cool-down is over the name is asked about again.
    jest.advanceTimersByTime(WEBHOOK_COOLDOWN_START_MS);
    dnsAnswers('93.184.216.34');
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache))).resolves.toBeTruthy();
    expect(askedDns()).toBe(4);
  });

  // Shared, one tenant's refusal (or a name that resolved a moment later)
  // switched off every other tenant's webhooks to that host.
  it('keeps a refusal for the project that saw it only, and good answers per project too', async () => {
    resolver.resolve4.mockImplementation(notFound);
    resolver.resolve6.mockImplementation(notFound);
    const cache = new WebhookDnsCache();
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'a'))).rejects.toThrow();
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'a'))).rejects.toThrow();
    expect(askedDns()).toBe(2);

    dnsAnswers('93.184.216.34');
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'b'))).resolves.toBeTruthy();
    expect(askedDns()).toBe(4);
    // Project b reuses its own answer; project c asks for itself, since a
    // shared entry was what let projects push out each other's.
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'b'))).resolves.toBeTruthy();
    expect(askedDns()).toBe(4);
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'c'))).resolves.toBeTruthy();
    expect(askedDns()).toBe(6);
  });

  it('does not cache a definite refusal from a lookup without the whole budget', async () => {
    resolver.resolve4.mockImplementation(notFound);
    resolver.resolve6.mockImplementation(notFound);
    const cache = new WebhookDnsCache();
    await expect(
      resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'a', false)),
    ).rejects.toMatchObject({ kind: 'no DNS records' });
    dnsAnswers('93.184.216.34');
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(cache, 'a'))).resolves.toBeTruthy();
  });

  it('caches a refusal for resolving to a private address too', async () => {
    dnsAnswers('10.0.0.9');
    const cache = new WebhookDnsCache();
    await expect(resolvePublicWebhookTarget('https://inside.example.com/', 50, asDelivery(cache))).rejects.toThrow();
    await expect(resolvePublicWebhookTarget('https://inside.example.com/', 50, asDelivery(cache))).rejects.toThrow();
    expect(askedDns()).toBe(2);
  });

  it('keeps a good answer for at most a minute', async () => {
    const cache = new WebhookDnsCache();
    const first = await resolvePublicWebhookTarget('https://ok.example.com/a', 50, asDelivery(cache));
    jest.advanceTimersByTime(WEBHOOK_DNS_CACHE_MS - 1);
    // A cached answer is still used with the URL it was asked for.
    const second = await resolvePublicWebhookTarget('https://ok.example.com/b?x=1', 50, asDelivery(cache));
    expect(askedDns()).toBe(2);
    expect(second.addresses).toEqual(first.addresses);
    expect(second.url.href).toBe('https://ok.example.com/b?x=1');

    expect(WEBHOOK_DNS_CACHE_MS).toBeLessThanOrEqual(60_000);
    jest.advanceTimersByTime(1);
    dnsAnswers('10.0.0.9');
    await expect(resolvePublicWebhookTarget('https://ok.example.com/a', 50, asDelivery(cache))).rejects.toThrow();
    expect(askedDns()).toBe(4);
  });

  it('does not log a refusal itself, so the caller can count it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    resolver.resolve4.mockImplementation(notFound);
    resolver.resolve6.mockImplementation(notFound);
    const err = await resolvePublicWebhookTarget('https://gone.example.com/', 50, asDelivery(new WebhookDnsCache())).catch(
      (e: unknown) => e,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(err).toMatchObject({ kind: 'no DNS records' });
    warn.mockRestore();
  });

  // A refusal that only says this one lookup ran out of time, kept for 30s,
  // refused a host that was fine, even with the whole budget.
  it.each([
    ['a timeout', () => new Promise(() => undefined)],
    ['SERVFAIL', () => Promise.reject(Object.assign(new Error('x'), { code: 'ESERVFAIL' }))],
    ['a refused resolver', () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))],
  ])('never caches a lookup that failed through %s', async (_what, failing) => {
    resolver.resolve4.mockImplementation(failing);
    resolver.resolve6.mockImplementation(failing);
    const cache = new WebhookDnsCache();
    // A delivery that started with almost no time left.
    const short = resolvePublicWebhookTarget('https://hooks.popular.example/a', 5, asDelivery(cache)).catch(
      (e: unknown) => e,
    );
    await jest.advanceTimersByTimeAsync(5);
    expect(await short).toMatchObject({ kind: 'lookup failed' });

    // The next one, with its full budget, asks DNS and gets through.
    dnsAnswers('93.184.216.34');
    await expect(
      resolvePublicWebhookTarget('https://hooks.popular.example/b', 5000, asDelivery(cache)),
    ).resolves.toMatchObject({ addresses: [{ address: '93.184.216.34', family: 4 }] });
  });

  it('counts a name as missing only if both families say so', async () => {
    resolver.resolve4.mockImplementation(notFound);
    resolver.resolve6.mockImplementation(() => Promise.reject(Object.assign(new Error('x'), { code: 'ETIMEOUT' })));
    const cache = new WebhookDnsCache();
    await expect(resolvePublicWebhookTarget('https://half.example.com/', 50, asDelivery(cache))).rejects.toMatchObject({
      kind: 'lookup failed',
    });
    dnsAnswers('93.184.216.34');
    await expect(resolvePublicWebhookTarget('https://half.example.com/', 50, asDelivery(cache))).resolves.toBeTruthy();
  });

  it('never caches for create and update, where a tenant may have just fixed their DNS', async () => {
    resolver.resolve4.mockImplementation(notFound);
    resolver.resolve6.mockImplementation(notFound);
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50)).rejects.toThrow();
    dnsAnswers('93.184.216.34');
    await expect(resolvePublicWebhookTarget('https://gone.example.com/', 50)).resolves.toBeTruthy();
  });
});

// Keyed by the hostname as written, with only a total cap, one tenant changing
// a webhook's URL through a wildcard domain could fill both maps and push out
// every other tenant's entries.
describe('WebhookDnsCache memory', () => {
  const addresses = [{ address: '93.184.216.34', family: 4 as const }];
  const refusal = () => new WebhookHostRefusedException('no DNS records', 'no DNS records (ENOTFOUND)');
  const longHost = (n: number) => `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.n${n}.example.com`;

  it('keys entries by a fixed-size digest, however long the name', () => {
    expect(webhookCacheKey('p1', 'x'.repeat(2000))).toHaveLength(43);
    expect(webhookCacheKey('x'.repeat(2000))).toHaveLength(43);
    // A project and name pair cannot spell another's.
    expect(webhookCacheKey('a b', 'c')).not.toBe(webhookCacheKey('a', 'b c'));
  });

  it('sizes the caps for an honest project and a bounded process', () => {
    // A project has at most 10 active webhooks (MAX_WEBHOOKS_PER_PROJECT).
    expect(WEBHOOK_DNS_CACHE_MAX_ENTRIES_PER_PROJECT).toBeGreaterThanOrEqual(10);
    expect(WEBHOOK_DNS_CACHE_MAX_PROJECTS * WEBHOOK_DNS_CACHE_MAX_ENTRIES_PER_PROJECT).toBeLessThanOrEqual(50_000);
  });

  it('holds at most its project cap of maps, each at most its entry cap, however many projects flood it', () => {
    const cache = new WebhookDnsCache(50, 4);
    for (let p = 0; p < 500; p++) {
      for (let n = 0; n < 10; n++) {
        cache.answer(`p${p}`, longHost(n), addresses, 0);
        cache.refuse(`p${p}`, longHost(100 + n), refusal(), 0);
      }
    }
    expect(cache.projectCount).toBe(50);
    expect(cache.size).toBe(50 * 4);
  });

  it('keeps at most the per-project cap of refusals, forgetting the project\'s oldest first', () => {
    const cache = new WebhookDnsCache(100, 2);
    const evicted = [0, 1, 2].map((n) => cache.refuse('flood', longHost(n), refusal(), 0));
    expect(evicted).toEqual([0, 0, 1]);
    expect(cache.get('flood', longHost(0), 1)).toBeUndefined();
    expect(cache.get('flood', longHost(1), 1)).toMatchObject({ refusal: expect.anything() });
    expect(cache.get('flood', longHost(2), 1)).toMatchObject({ refusal: expect.anything() });
  });

  it('keeps at most the project cap, forgetting the least recently active project', () => {
    const cache = new WebhookDnsCache(3, 2);
    const evicted = [0, 1, 2, 3].map((n) => cache.answer(`p${n}`, longHost(n), addresses, 0));
    expect(evicted).toEqual([0, 0, 0, 1]);
    expect(cache.get('p0', longHost(0), 1)).toBeUndefined();
    for (const n of [1, 2, 3]) expect(cache.get(`p${n}`, longHost(n), 1)).toMatchObject({ addresses });
  });

  it('lets a later lookup of a name replace the project\'s earlier one', () => {
    const cache = new WebhookDnsCache(10, 5);
    cache.refuse('p', 'flip.example.com', refusal(), 0);
    cache.answer('p', 'flip.example.com', addresses, 0);
    expect(cache.get('p', 'flip.example.com', 1)).toMatchObject({ addresses });
    expect(cache.size).toBe(1);
  });

  it('never lets a project flooding names push out another project\'s entries before its own', () => {
    const cache = new WebhookDnsCache(10, 3);
    cache.refuse('victim', 'gone.example.com', refusal(), 0);
    cache.answer('victim', 'hooks.example.com', addresses, 0);
    for (let n = 0; n < 500; n++) {
      cache.refuse('flood', longHost(n), refusal(), 0);
      cache.answer('flood', longHost(n), addresses, 0);
    }
    expect(cache.get('victim', 'gone.example.com', 1)).toMatchObject({ refusal: expect.anything() });
    expect(cache.get('victim', 'hooks.example.com', 1)).toMatchObject({ addresses });
  });

  it('keeps another project\'s entries while projects at their caps fill a map and keep flooding', () => {
    const cache = new WebhookDnsCache(10, 2);
    for (let p = 0; p < 5; p++) {
      for (let n = 0; n < 2; n++) {
        cache.refuse(`att${p}`, longHost(p * 2 + n), refusal(), 0);
        cache.answer(`att${p}`, longHost(p * 2 + n), addresses, 0);
      }
    }
    cache.refuse('victim', 'gone.example.com', refusal(), 0);
    cache.answer('victim', 'hooks.example.com', addresses, 0);
    for (let n = 10; n < 500; n++) {
      cache.refuse(`att${n % 5}`, longHost(n), refusal(), 0);
      cache.answer(`att${n % 5}`, longHost(n), addresses, 0);
    }
    expect(cache.get('victim', 'gone.example.com', 1)).toMatchObject({ refusal: expect.anything() });
    expect(cache.get('victim', 'hooks.example.com', 1)).toMatchObject({ addresses });
  });

  // W4: a good answer was shared by hostname and owned by whichever project
  // stored it last, so two projects storing one name in turn each left the
  // other with no entries, and a project with no entries could push out the
  // oldest entry overall, again and again.
  it('does not let two projects alternating on a shared hostname push out other projects\' entries', () => {
    const cache = new WebhookDnsCache(4, 2);
    cache.answer('v1', 'hooks.v1.example.com', addresses, 0);
    cache.answer('v2', 'hooks.v2.example.com', addresses, 0);
    for (let n = 0; n < 100; n++) {
      cache.answer('a', 'shared.example.com', addresses, 0);
      cache.answer('b', 'shared.example.com', addresses, 0);
      cache.answer('a', longHost(2 * n), addresses, 0);
      cache.answer('b', longHost(2 * n + 1), addresses, 0);
    }
    expect(cache.get('v1', 'hooks.v1.example.com', 1)).toMatchObject({ addresses });
    expect(cache.get('v2', 'hooks.v2.example.com', 1)).toMatchObject({ addresses });
  });

  it('tells the delivery when its lookup pushed an entry out', async () => {
    resolver.resolve4.mockReset();
    resolver.resolve6.mockReset();
    dnsAnswers('93.184.216.34');
    const cache = new WebhookDnsCache(100, 1);
    const onEvicted = jest.fn();
    const delivery = { cache, projectId: 'p', fullBudget: true, onEvicted };
    await resolvePublicWebhookTarget('https://one.example.com/', 50, delivery);
    expect(onEvicted).not.toHaveBeenCalled();
    await resolvePublicWebhookTarget('https://two.example.com/', 50, delivery);
    expect(onEvicted).toHaveBeenCalledWith(1);
  });
});
