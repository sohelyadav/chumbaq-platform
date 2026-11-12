import { BadRequestException, Logger } from '@nestjs/common';
import * as dns from 'dns/promises';
import * as net from 'net';
import { WEBHOOK_COOLDOWN_START_MS } from './webhook-cooldown';
import { PerProjectLru, webhookCacheKey } from './per-project-lru';

/**
 * Where a webhook may be delivered. A tenant chooses the URL, so anything the
 * API host can reach but the internet cannot (loopback, Redis, the cloud
 * metadata service, the private network) must be refused, however the address
 * is spelled.
 *
 * Addresses are parsed to bytes and checked against ranges, never matched as
 * strings: WHATWG URL rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], and a
 * prefix test on the dotted form let exactly that through.
 */

// IANA IPv4 special-purpose registry, everything not globally reachable.
const PRIVATE_V4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network", 0.0.0.0 reaches the local host
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255 broadcast
] as const) {
  PRIVATE_V4.addSubnet(network, prefix, 'ipv4');
}

// Inside 2000::/3 (the only global unicast space; anything outside it is
// refused before this list is consulted), these are still not destinations.
const PRIVATE_V6_IN_GLOBAL = new net.BlockList();
for (const [network, prefix] of [
  ['2001::', 23], // IETF protocol assignments: Teredo, ORCHID, benchmarking
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
] as const) {
  PRIVATE_V6_IN_GLOBAL.addSubnet(network, prefix, 'ipv6');
}

/** IPv4 dotted quad from four bytes. */
const v4FromBytes = (b: number[]) => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;

/**
 * The 16 bytes of an IPv6 address, or null if it is not one. Accepts `::`
 * compression and a trailing dotted quad (::ffff:1.2.3.4), which is all
 * net.isIP accepts apart from zone IDs, refused by the caller.
 */
function ipv6Bytes(addr: string): number[] | null {
  let text = addr;
  // A trailing dotted quad stands for the last two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

const allZero = (b: number[]) => b.every((x) => x === 0);

function isPrivateV4(addr: string): boolean {
  return PRIVATE_V4.check(addr, 'ipv4');
}

function isPrivateV6(addr: string): boolean {
  // A zone ID (fe80::1%eth0) only exists for link-scoped addresses.
  if (addr.includes('%')) return true;
  const b = ipv6Bytes(addr);
  if (!b) return true;

  const embeddedAt = (offset: number) => v4FromBytes(b.slice(offset, offset + 4));

  // IPv4-mapped ::ffff:0:0/96 and SIIT ::ffff:0:0:0/96: the socket talks to
  // the embedded IPv4 address, so that is the one to judge.
  if (allZero(b.slice(0, 10)) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(embeddedAt(12));
  if (allZero(b.slice(0, 8)) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return isPrivateV4(embeddedAt(12));
  }
  // NAT64 well-known prefix 64:ff9b::/96: a DNS64 network translates it to
  // the embedded IPv4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b.slice(4, 12))) {
    return isPrivateV4(embeddedAt(12));
  }
  // IPv4-compatible ::/96 (deprecated, never legitimately used), :: and ::1.
  if (allZero(b.slice(0, 12))) return true;
  // 6to4 2002::/16 carries an IPv4 address in bytes 2-5, which a relay
  // would deliver to.
  if (b[0] === 0x20 && b[1] === 0x02 && isPrivateV4(embeddedAt(2))) return true;

  // Only 2000::/3 is global unicast. This also covers fc00::/7, fe80::/10,
  // fec0::/10, ff00::/8, 100::/64 and the NAT64 local-use 64:ff9b:1::/48.
  if ((b[0] & 0xe0) !== 0x20) return true;
  return PRIVATE_V6_IN_GLOBAL.check(addr, 'ipv6');
}

/**
 * True for any address a webhook must not be sent to. Anything that does not
 * parse as an IP address counts as private: the caller never has a reason to
 * pass one.
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = net.isIP(host);
  if (family === 4) return isPrivateV4(host);
  if (family === 6) return isPrivateV6(host.toLowerCase());
  return true;
}

/**
 * localhost and *.localhost always mean this machine (RFC 6761), whatever DNS
 * is configured to say, and some resolvers answer them without asking DNS.
 */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** A URL that passed the guard, with the only addresses it may be sent to. */
export interface VettedWebhookTarget {
  url: URL;
  /** The hostname without IPv6 brackets: what the socket and TLS are given. */
  hostname: string;
  addresses: { address: string; family: 4 | 6 }[];
}

const logger = new Logger('WebhookAddress');

/** Why a host was refused, short and fixed, so refusals can be counted by it. */
export type HostRefusal =
  | 'localhost name'
  | 'private address literal'
  | 'lookup failed'
  | 'no DNS records'
  | 'resolves to a private address';

/**
 * Every refusal of a host. The message is the same for all of them (see
 * notPublic); `kind` and `detail` are for the server's log only.
 */
export class WebhookHostRefusedException extends BadRequestException {
  constructor(
    readonly kind: HostRefusal,
    /** The kind with what was seen, such as the error code or the address. */
    readonly detail: string,
  ) {
    super('Webhook URL must resolve to a public address');
  }
}

/**
 * Refusals that are definite answers about the name: NXDOMAIN or NODATA for
 * both families, or addresses that are private. Only these are cached. A
 * lookup that failed (a timeout, SERVFAIL, an unreachable resolver) says
 * nothing lasting.
 */
const LASTING_REFUSALS: ReadonlySet<HostRefusal> = new Set<HostRefusal>([
  'no DNS records',
  'resolves to a private address',
]);

/** c-ares codes that mean the name has no address, as opposed to no answer. */
const NAME_HAS_NO_ADDRESS = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Longest a good answer is reused for deliveries. Short, so a tenant moving
 * their endpoint is followed soon; long enough that a busy link does not ask
 * DNS on every click.
 */
export const WEBHOOK_DNS_CACHE_MS = 60_000;

type CachedHost =
  | { expiresAt: number; addresses: VettedWebhookTarget['addresses'] }
  | { expiresAt: number; refusal: WebhookHostRefusedException };

/**
 * Most hostnames one project's lookups are kept for, and most projects whose
 * lookups a process keeps (per-project-lru.ts). A tenant can make new names
 * cheaply (a wildcard domain, a new URL per event), so the per-project cap
 * bounds what one can hold, and only its own entries make room for more; a
 * project has at most 10 active webhooks, so 20 names is twice what an honest
 * one uses in a minute. 2,000 projects of 20 is at most 40,000 entries.
 * Pushed out, an entry only costs that project one more lookup.
 */
export const WEBHOOK_DNS_CACHE_MAX_PROJECTS = 2_000;
export const WEBHOOK_DNS_CACHE_MAX_ENTRIES_PER_PROJECT = 20;

/**
 * Lookups for deliveries only. Create and update never use it: a tenant who
 * has just fixed their DNS must see the fix at once.
 *
 * Everything is kept per project, good answers too, keyed by a digest of the
 * hostname (webhookCacheKey): each project's lookups go in its own map, so no
 * project's lookups can push out another's (see PerProjectLru for the one
 * way they can go). Good answers were once shared by hostname and counted
 * against whichever project stored them last, which let two projects storing
 * one name in turn push out other projects' entries without limit; sharing
 * only saved one lookup a minute per project and name.
 *
 * Refusals are kept for the first cool-down, and only definite ones
 * (LASTING_REFUSALS) from a lookup that had the whole delivery budget: a
 * project whose webhooks point at names that do not resolve otherwise had
 * every click send a query to whichever nameserver the tenant chose. Shared, a
 * refusal one tenant's lookup saw (one cut short by an event's deadline, or a
 * name that resolved a moment later) switched off every other tenant's
 * webhooks to that host. Only what came from DNS is kept; refusals that need
 * no query (localhost, literals) are as cheap to make again. A project's
 * latest lookup of a name replaces its earlier one, refusal or answer.
 */
export class WebhookDnsCache {
  private readonly hosts: PerProjectLru<CachedHost>;

  constructor(
    maxProjects = WEBHOOK_DNS_CACHE_MAX_PROJECTS,
    maxPerProject = WEBHOOK_DNS_CACHE_MAX_ENTRIES_PER_PROJECT,
  ) {
    this.hosts = new PerProjectLru(maxProjects, maxPerProject);
  }

  /** Entries held across all projects, for tests. */
  get size(): number {
    return this.hosts.size;
  }

  get projectCount(): number {
    return this.hosts.projectCount;
  }

  get(projectId: string, hostname: string, now = Date.now()): CachedHost | undefined {
    const key = webhookCacheKey(hostname);
    const entry = this.hosts.get(projectId, key);
    if (entry && now >= entry.expiresAt) {
      this.hosts.delete(projectId, key);
      return undefined;
    }
    return entry;
  }

  /** Returns how many entries were pushed out to make room. */
  answer(projectId: string, hostname: string, addresses: VettedWebhookTarget['addresses'], now = Date.now()): number {
    return this.hosts.set(projectId, webhookCacheKey(hostname), { expiresAt: now + WEBHOOK_DNS_CACHE_MS, addresses });
  }

  /** Returns how many entries were pushed out to make room. */
  refuse(projectId: string, hostname: string, refusal: WebhookHostRefusedException, now = Date.now()): number {
    return this.hosts.set(projectId, webhookCacheKey(hostname), {
      expiresAt: now + WEBHOOK_COOLDOWN_START_MS,
      refusal,
    });
  }
}

/**
 * How long create and update wait for DNS before refusing the URL. Short,
 * since a tenant is waiting on the request, and any longer only lets one
 * tenant's slow nameserver hold an API request open.
 */
export const WEBHOOK_VALIDATION_DNS_TIMEOUT_MS = 3000;

// c-ares gives up on one query after DNS_TRY_TIMEOUT_MS, DNS_TRIES times per
// nameserver, so even a query nobody waits for any more does not linger.
const DNS_TRY_TIMEOUT_MS = 1000;
const DNS_TRIES = 2;

/**
 * What one lookup needs to get c-ares's whole answer from a nameserver. A
 * delivery is not started with less (webhooks.service.ts): a lookup cut
 * shorter fails for want of time, which says nothing about the name.
 */
export const WEBHOOK_MIN_DNS_BUDGET_MS = DNS_TRY_TIMEOUT_MS * DNS_TRIES;

/**
 * Webhook hosts are resolved with c-ares (Resolver), never dns.lookup:
 * lookup is getaddrinfo on libuv's four-thread pool with no time limit, so a
 * tenant nameserver that drops queries held a thread for tens of seconds and
 * stalled bcrypt, fs, zlib and crypto for every tenant. c-ares queries run on
 * the event loop and have their own timeout.
 *
 * One shared resolver: making one per call reads resolv.conf every time, and
 * the delivery caps in webhooks.service.ts bound how many queries it carries.
 * It does not read /etc/hosts, which no tenant's public host needs.
 */
let sharedResolver: dns.Resolver | undefined;
function webhookResolver(): dns.Resolver {
  sharedResolver ??= new dns.Resolver({ timeout: DNS_TRY_TIMEOUT_MS, tries: DNS_TRIES });
  return sharedResolver;
}

/**
 * Every A and AAAA address of a name, or a rejection once `timeoutMs` has
 * passed. A family with no records is skipped; the name fails only if
 * neither has any. Missing a family cannot let a private address through,
 * since delivery connects only to addresses returned here.
 */
async function resolveHost(hostname: string, timeoutMs: number): Promise<{ address: string; family: 4 | 6 }[]> {
  const resolver = webhookResolver();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`no answer in ${timeoutMs}ms`), { code: 'ETIMEOUT' })),
      timeoutMs,
    );
  });
  try {
    const [v4, v6] = await Promise.race([
      Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]),
      deadline,
    ]);
    if (v4.status === 'rejected' && v6.status === 'rejected') {
      // Both families must say the name has no address for that to be the
      // answer; if either just failed, the failure is what happened.
      const failed = [v4.reason, v6.reason].find(
        (e) => !NAME_HAS_NO_ADDRESS.has((e as NodeJS.ErrnoException | undefined)?.code ?? ''),
      );
      throw failed ?? v4.reason;
    }
    return [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
    ];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every refusal of the host gets one message, the exception's. Told apart,
 * "resolves to a private address" and "could not be resolved" would let a
 * tenant map the API host's internal DNS (redis, postgres, *.internal) one
 * guess at a time. Why it was refused goes only to the server's log.
 */
function refused(kind: HostRefusal, detail: string = kind): WebhookHostRefusedException {
  return new WebhookHostRefusedException(kind, detail);
}

/** What a delivery passes, so its lookups are cached and its refusals left to it to count. */
export interface DeliveryLookup {
  cache: WebhookDnsCache;
  /** Whose delivery it is: refusals are cached for this project only. */
  projectId: string;
  /**
   * The lookup has the whole delivery budget, not what an event's deadline
   * left. Only then is a refusal cached: one under a cut budget was a race
   * against the clock.
   */
  fullBudget: boolean;
  /** Called with how many cache entries this lookup pushed out, for the project's report. */
  onEvicted?: (count: number) => void;
}

/**
 * Parses, resolves once, and checks every address. Delivery must then connect
 * to `addresses` and nothing else (see webhook-delivery.ts): resolving the
 * name a second time is what DNS rebinding exploits. A cached answer is no
 * second resolution: it is the addresses one earlier check saw, and only
 * they are connected to.
 *
 * DNS gets at most `timeoutMs`; past that the host is refused like any other
 * that does not resolve.
 *
 * Without `delivery` (create, update) each refusal is logged here. With it,
 * nothing is: one click can refuse every webhook of a project, so the caller
 * counts refusals into its summary instead.
 */
export async function resolvePublicWebhookTarget(
  rawUrl: string,
  timeoutMs: number = WEBHOOK_VALIDATION_DNS_TIMEOUT_MS,
  delivery?: DeliveryLookup,
): Promise<VettedWebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid webhook URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException('Webhook URL must use http(s)');
  }
  // fetch refused these before, and the delivery path has no use for them; a
  // URL carrying a password is also one more thing for a viewer to read.
  if (url.username || url.password) {
    throw new BadRequestException('Webhook URL must not contain credentials');
  }

  // URL has already turned decimal, octal and hex IPv4 (2130706433, 0x7f.1,
  // 0177.0.0.1) into dotted form, so a literal is recognised here however it
  // was typed.
  const raw = url.hostname;
  const hostname = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;

  try {
    return { url, hostname, addresses: await publicAddressesOf(hostname, timeoutMs, delivery) };
  } catch (err) {
    if (!delivery && err instanceof WebhookHostRefusedException) {
      logger.warn(`Refused webhook host ${JSON.stringify(hostname)}: ${err.detail}`);
    }
    throw err;
  }
}

async function publicAddressesOf(
  hostname: string,
  timeoutMs: number,
  delivery: DeliveryLookup | undefined,
): Promise<VettedWebhookTarget['addresses']> {
  if (isLocalHostname(hostname)) {
    throw refused('localhost name');
  }

  const literal = net.isIP(hostname);
  if (literal) {
    if (isPrivateAddress(hostname)) {
      throw refused('private address literal');
    }
    return [{ address: hostname, family: literal as 4 | 6 }];
  }

  const cached = delivery?.cache.get(delivery.projectId, hostname);
  if (cached) {
    if ('refusal' in cached) throw cached.refusal;
    return [...cached.addresses];
  }
  try {
    const addresses = await resolvePublic(hostname, timeoutMs);
    if (delivery) reportEvicted(delivery, delivery.cache.answer(delivery.projectId, hostname, addresses));
    return addresses;
  } catch (err) {
    if (delivery?.fullBudget && err instanceof WebhookHostRefusedException && LASTING_REFUSALS.has(err.kind)) {
      reportEvicted(delivery, delivery.cache.refuse(delivery.projectId, hostname, err));
    }
    throw err;
  }
}

function reportEvicted(delivery: DeliveryLookup, count: number): void {
  if (count > 0) delivery.onEvicted?.(count);
}

async function resolvePublic(hostname: string, timeoutMs: number): Promise<VettedWebhookTarget['addresses']> {
  // Every A and AAAA record is checked, since the connection may use any.
  let resolved: { address: string; family: 4 | 6 }[];
  try {
    resolved = await resolveHost(hostname, timeoutMs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // NXDOMAIN or NODATA for both families: the name has no address.
    if (code && NAME_HAS_NO_ADDRESS.has(code)) throw refused('no DNS records', `no DNS records (${code})`);
    throw refused('lookup failed', `lookup failed (${code ?? err})`);
  }
  if (!resolved || resolved.length === 0) {
    throw refused('no DNS records');
  }
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw refused('resolves to a private address', `resolves to private address ${address}`);
    }
  }
  return resolved;
}
