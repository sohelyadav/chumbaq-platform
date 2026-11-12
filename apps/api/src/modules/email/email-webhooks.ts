import { createHmac, createVerify, timingSafeEqual } from 'crypto';
import { normaliseEmail } from '../push-notifications/message-channel';
import { CAMPAIGN_TAG, IDENTITY_TAG } from './email-rendering';
import { ProjectBoundedMap } from '../../common/project-bounded-map';
import { webhookCacheKey } from '../webhooks/per-project-lru';

/** A provider event, reduced to what Chumbaq records. */
export interface EmailEvent {
  /**
   * `unsubscribed` is a provider-side unsubscribe (Brevo can host its own).
   * It is a suppression, not engagement, so it is never written as a
   * campaign event.
   */
  type: 'delivered' | 'impression' | 'click' | 'bounced' | 'complained' | 'unsubscribed';
  address: string;
  campaignId: string | null;
  identityId: string | null;
  /** Bounces only: whether the address is gone for good. */
  permanent?: boolean;
  detail?: string;
  occurredAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

const dateOr = (value: unknown, fallback: Date): Date => {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
};

// ---------------------------------------------------------------- Resend ---

/** How far a Svix timestamp may be from now. Svix's own libraries use 5 min. */
const SVIX_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Resend (Svix) webhook signature over the raw body.
 *
 * The raw bytes matter: re-serialising parsed JSON changes whitespace and key
 * order, and the signature no longer matches.
 */
export function verifySvix(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  now: Date = new Date(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret.startsWith('whsec_')) return false;

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(now.getTime() / 1000 - seconds) > SVIX_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  // The header can carry several space-separated `v1,<sig>` entries during
  // a secret rotation; any one matching is enough.
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const RESEND_TYPES: Record<string, EmailEvent['type']> = {
  'email.delivered': 'delivered',
  'email.opened': 'impression',
  'email.clicked': 'click',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

/** Resend sends tags as an object, and has sent them as a list; read both. */
function resendTags(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw
        .filter((tag) => tag && typeof tag.name === 'string')
        .map((tag) => [tag.name, String(tag.value)]),
    );
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
}

export function parseResendEvent(payload: unknown, now: Date = new Date()): EmailEvent[] {
  const body = payload as {
    type?: string;
    created_at?: string;
    data?: {
      to?: string[] | string;
      tags?: unknown;
      created_at?: string;
      bounce?: { type?: string; subType?: string; message?: string };
    };
  };
  const type = body?.type ? RESEND_TYPES[body.type] : undefined;
  if (!type || !body.data) return [];

  const data = body.data;
  const tags = resendTags(data.tags);
  const recipients = Array.isArray(data.to) ? data.to : [data.to];
  const bounce = data.bounce;

  return recipients
    .map((to) => normaliseEmail(to))
    .filter((address): address is string => !!address)
    .map((address) => ({
      type,
      address,
      campaignId: uuidOrNull(tags[CAMPAIGN_TAG]),
      identityId: uuidOrNull(tags[IDENTITY_TAG]),
      ...(type === 'bounced'
        ? {
            // Resend reports `Permanent` for a hard bounce. Anything else —
            // a full mailbox, a greylisting delay — may yet succeed.
            permanent: bounce?.type === 'Permanent',
            detail: [bounce?.subType, bounce?.message].filter(Boolean).join(': '),
          }
        : {}),
      occurredAt: dateOr(body.created_at ?? data.created_at, now),
    }));
}

// ----------------------------------------------------------------- Brevo ---

const BREVO_TYPES: Record<string, { type: EmailEvent['type']; permanent?: boolean }> = {
  delivered: { type: 'delivered' },
  opened: { type: 'impression' },
  unique_opened: { type: 'impression' },
  // An open fetched by a privacy proxy (Apple Mail). Still an open as far
  // as anyone can tell, and the unique index keeps it from double counting.
  proxy_open: { type: 'impression' },
  click: { type: 'click' },
  hard_bounce: { type: 'bounced', permanent: true },
  // Brevo refused to send: the address is invalid or on Brevo's own
  // blocklist. Either way it will not succeed next time.
  invalid_email: { type: 'bounced', permanent: true },
  blocked: { type: 'bounced', permanent: true },
  soft_bounce: { type: 'bounced', permanent: false },
  spam: { type: 'complained' },
  complaint: { type: 'complained' },
  unsubscribed: { type: 'unsubscribed' },
};

/** Brevo tags are strings; Chumbaq writes them as `name:value`. */
function brevoTag(tags: unknown, name: string): string | null {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [];
  for (const tag of list) {
    if (typeof tag !== 'string') continue;
    const at = tag.indexOf(':');
    if (at > 0 && tag.slice(0, at) === name) return uuidOrNull(tag.slice(at + 1));
  }
  return null;
}

/**
 * Reads a Brevo transactional webhook body: one event object, or an array of
 * them when the webhook is set to batch.
 */
export function parseBrevoEvent(payload: unknown, now: Date = new Date()): EmailEvent[] {
  const items = Array.isArray(payload) ? payload : [payload];

  return items.flatMap((item): EmailEvent[] => {
    const body = item as Record<string, unknown> | null;
    const mapped = body && typeof body.event === 'string' ? BREVO_TYPES[body.event] : undefined;
    const address = normaliseEmail(body?.email);
    if (!body || !mapped || !address) return [];

    const tags = body.tags ?? body.tag;
    const seconds = Number(body.ts_event ?? body.ts);

    return [
      {
        type: mapped.type,
        address,
        campaignId: brevoTag(tags, CAMPAIGN_TAG),
        identityId: brevoTag(tags, IDENTITY_TAG),
        ...(mapped.type === 'bounced'
          ? {
              permanent: mapped.permanent,
              detail: [body.event, body.reason].filter(Boolean).join(': '),
            }
          : {}),
        occurredAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : now,
      },
    ];
  });
}

// ------------------------------------------------------------- SES / SNS ---

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

/**
 * Every AWS region SNS runs in. A pattern for region names accepted any
 * made-up one (`xx-fake-9`), and each was another outbound request from this
 * server, so only real regions are trusted.
 *
 * When AWS opens a region, add it here; until then SES events from it are
 * refused with 401 and SNS retries them. The current list:
 * `aws ssm get-parameters-by-path --path /aws/service/global-infrastructure/services/sns/regions`
 * (run once per partition: commercial, China, GovCloud).
 */
export const SNS_REGIONS = {
  /** `sns.<region>.amazonaws.com` */
  commercial: [
    'af-south-1',
    'ap-east-1',
    'ap-east-2',
    'ap-northeast-1',
    'ap-northeast-2',
    'ap-northeast-3',
    'ap-south-1',
    'ap-south-2',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-southeast-3',
    'ap-southeast-4',
    'ap-southeast-5',
    'ap-southeast-6',
    'ap-southeast-7',
    'ca-central-1',
    'ca-west-1',
    'eu-central-1',
    'eu-central-2',
    'eu-north-1',
    'eu-south-1',
    'eu-south-2',
    'eu-west-1',
    'eu-west-2',
    'eu-west-3',
    'il-central-1',
    'me-central-1',
    'me-south-1',
    'mx-central-1',
    'sa-east-1',
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
  ],
  /** `sns.<region>.amazonaws.com.cn` */
  china: ['cn-north-1', 'cn-northwest-1'],
  /** `sns.<region>.amazonaws.com`, like commercial regions. */
  govCloud: ['us-gov-east-1', 'us-gov-west-1'],
} as const;

const SNS_HOSTS: ReadonlySet<string> = new Set([
  ...[...SNS_REGIONS.commercial, ...SNS_REGIONS.govCloud].map((r) => `sns.${r}.amazonaws.com`),
  ...SNS_REGIONS.china.map((r) => `sns.${r}.amazonaws.com.cn`),
]);

/** Whether `hostname` is SNS's own endpoint in a real region. */
export function isSnsHostname(hostname: string): boolean {
  return SNS_HOSTS.has(hostname);
}

/** The one file name SNS serves its signing certificates under. */
const SNS_CERT_PATH = /^\/SimpleNotificationService-[0-9a-f]{1,64}\.pem$/;

/**
 * Only certificates served by SNS itself may vouch for a message. Without
 * this, anyone could sign a forged bounce with their own key and point
 * `SigningCertURL` at it.
 *
 * The URL must also be in its one canonical form: no query, fragment,
 * credentials or port, and nothing the parser would rewrite. Each variant
 * of an otherwise valid URL would be another fetch and another cache entry,
 * and anyone holding a webhook URL can post as many as they like.
 */
export function isSnsCertUrl(value: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      isSnsHostname(url.hostname) &&
      SNS_CERT_PATH.test(url.pathname) &&
      // Catches what the URL object hides: `:443` (dropped as the default),
      // an empty `?` or `#`, userinfo, dot segments and percent-encoding.
      value === `${url.origin}${url.pathname}`
    );
  } catch {
    return false;
  }
}

/** The region in a certificate URL `isSnsCertUrl` accepted: `sns.<region>.amazonaws.com`. */
export function snsCertRegion(value: string): string {
  return new URL(value).hostname.split('.')[1];
}

/** What a certificate is cached under. Only ever called on a URL `isSnsCertUrl` accepted. */
export function snsCertCacheKey(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

/**
 * A small least-recently-used map whose entries also expire. A Map keeps
 * insertion order, so re-inserting on read makes the first key the oldest.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
    // Read through a closure so a test's clock (a spy on Date.now) applies.
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * `expiresAt` lets a caller keep an entry's age fixed to when its value
   * was obtained rather than when it was stored.
   */
  set(key: string, value: V, expiresAt: number = this.now() + this.ttlMs): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

/**
 * Counts requests per key in fixed windows. Kept here rather than in the
 * global throttler because that one's in-memory store never forgets a key
 * and keeps a timer per hit; callers only pass keys that name a real row.
 *
 * At most `maxKeys` windows, because projects are unlimited per account and
 * one tenant could otherwise hold a window for each of thousands. When every
 * window is still running, the one that started first is forgotten, which
 * only gives that key a fresh allowance early: a limiter that is full never
 * refuses anyone, so filling it costs other projects nothing.
 */
export class WindowLimiter {
  /** In order of when each window started, oldest first. */
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.windows.size;
  }

  /** Counts one request for `key`; false once the window's limit is used up. */
  take(key: string): boolean {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      // Deleted first, so the map stays in order of start and the sweep can
      // stop at the first window still running.
      this.windows.delete(key);
      this.sweep(now);
      if (this.windows.size >= this.maxKeys) {
        this.windows.delete(this.windows.keys().next().value!);
      }
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count++;
    return window.count <= this.limit;
  }

  /** How many `take`s `key` has made in its current window. Counts nothing. */
  used(key: string): number {
    const window = this.windows.get(key);
    return window && this.now() - window.startedAt < this.windowMs ? window.count : 0;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt < this.windowMs) return;
      this.windows.delete(key);
    }
  }
}

/**
 * SNS message ids each project has processed, or is processing, so a copy is
 * handled once. One store for the whole process, bounded in total and per
 * project (`ProjectBoundedMap`): a project at its share, or any project once
 * the store is full, pushes out its own oldest id; only a project with none,
 * arriving at a full store, pushes out the oldest id overall, once. Nothing
 * here deletes an id, so a project gets back to none only when other projects
 * push its ids out.
 *
 * Only a fast path. Processing is idempotent in the database (one event row
 * per campaign, person and type; one suppression per address; confirming a
 * topic again pins the same topic), so a forgotten id costs one more
 * processing of a duplicate, never a wrong record.
 *
 * A copy arriving while the first is in flight waits for it and gets its
 * outcome, success or failure. It is never answered "done" before the work
 * is: SNS takes any 2xx as delivered and would not send it again. A first
 * copy is waited on only for `inFlightMs`; after that a copy runs the work
 * itself, so one stuck on something with no time limit of its own does not
 * hold every retry until SNS gives up.
 */
export class SeenMessages<T> {
  private readonly entries: ProjectBoundedMap<{ outcome: Promise<T> | 'done'; expiresAt: number }>;

  constructor(
    maxEntries: number,
    maxPerProject: number,
    /** How long a success is remembered. */
    private readonly ttlMs: number,
    /** How long a copy waits on a first copy still in flight. */
    private readonly inFlightMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.entries = new ProjectBoundedMap(maxEntries, maxPerProject);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Runs `work` for the first copy of `id` in `project`. A copy arriving
   * while it runs gets the same outcome; one arriving after it succeeded
   * gets `replayed`. A failure is not remembered as done, so SNS's next try
   * runs again; the id keeps its slot, so a project's ids never drop to none
   * by its own failures.
   */
  run(project: string, id: string, work: () => Promise<T>, replayed: T): Promise<T> {
    // A digest, so an entry costs the same whatever the id's length.
    const key = webhookCacheKey(project, id);
    const seen = this.entries.get(key);
    if (seen && seen.expiresAt > this.now()) {
      return seen.outcome === 'done' ? Promise.resolve(replayed) : seen.outcome;
    }

    const outcome = work();
    const entry = { outcome, expiresAt: this.now() + this.inFlightMs };
    this.entries.set(project, key, entry);
    // Only this run's own entry changes: if it was pushed out, or outlived
    // its time in flight, another copy may have started afresh and owns the
    // key now. Writing anyway would put back an id the project had pushed
    // out (pushing out a newer one) or end a newer run's wait early.
    outcome.then(
      () => {
        if (this.entries.get(key) === entry) {
          this.entries.set(project, key, { outcome: 'done', expiresAt: this.now() + this.ttlMs });
        }
      },
      () => {
        // Expired in place rather than deleted, so the next try runs again
        // but the id keeps its slot. Deleted, a project's last id would leave
        // it with none, and a project with none arriving at a full store
        // pushes out the oldest id overall: failing on purpose (over its rate
        // limit) and trying again, it could do that without end. Storing the
        // same key again frees its own slot first, so it pushes out nothing.
        if (this.entries.get(key) === entry) entry.expiresAt = Number.NEGATIVE_INFINITY;
      },
    );
    return outcome;
  }
}

/** The canonical string SNS signs, per message type. */
export function snsStringToSign(message: SnsMessage): string {
  const keys =
    message.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  return keys
    .filter((key) => (message as unknown as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${key}\n${(message as unknown as Record<string, string>)[key]}\n`)
    .join('');
}

export function verifySnsSignature(message: SnsMessage, certificatePem: string): boolean {
  const algorithm =
    message.SignatureVersion === '2'
      ? 'RSA-SHA256'
      : message.SignatureVersion === '1'
        ? 'RSA-SHA1'
        : null;
  if (!algorithm || typeof message.Signature !== 'string') return false;

  try {
    return createVerify(algorithm)
      .update(snsStringToSign(message), 'utf8')
      .verify(certificatePem, message.Signature, 'base64');
  } catch {
    return false;
  }
}

/** Tags in an SES event are `name -> [values]`. */
const sesTag = (tags: Record<string, string[]> | undefined, name: string): string | null =>
  uuidOrNull(tags?.[name]?.[0]);

/**
 * Reads an SES event, from configuration-set event publishing (`eventType`)
 * or from identity feedback notifications (`notificationType`).
 */
export function parseSesEvent(messageJson: string, now: Date = new Date()): EmailEvent[] {
  let event: Record<string, any>;
  try {
    event = JSON.parse(messageJson);
  } catch {
    return [];
  }

  const kind = String(event.eventType ?? event.notificationType ?? '');
  const mail = event.mail ?? {};
  const base = {
    campaignId: sesTag(mail.tags, CAMPAIGN_TAG),
    identityId: sesTag(mail.tags, IDENTITY_TAG),
  };

  const each = (
    addresses: unknown[],
    type: EmailEvent['type'],
    extra: Partial<EmailEvent>,
    at: unknown,
  ): EmailEvent[] =>
    addresses
      .map((address) => normaliseEmail(address))
      .filter((address): address is string => !!address)
      .map((address) => ({
        ...base,
        type,
        address,
        ...extra,
        occurredAt: dateOr(at, now),
      }));

  const destination: unknown[] = Array.isArray(mail.destination) ? mail.destination : [];

  switch (kind) {
    case 'Delivery':
      return each(
        event.delivery?.recipients ?? destination,
        'delivered',
        {},
        event.delivery?.timestamp,
      );
    case 'Open':
      return each(destination, 'impression', {}, event.open?.timestamp);
    case 'Click':
      return each(destination, 'click', {}, event.click?.timestamp);
    case 'Bounce': {
      const bounce = event.bounce ?? {};
      return (bounce.bouncedRecipients ?? []).flatMap((recipient: Record<string, unknown>) =>
        each([recipient.emailAddress], 'bounced', {
          permanent: bounce.bounceType === 'Permanent',
          detail: [bounce.bounceSubType, recipient.diagnosticCode]
            .filter(Boolean)
            .join(': '),
        }, bounce.timestamp),
      );
    }
    case 'Complaint': {
      const complaint = event.complaint ?? {};
      return each(
        (complaint.complainedRecipients ?? []).map(
          (recipient: Record<string, unknown>) => recipient.emailAddress,
        ),
        'complained',
        { detail: complaint.complaintFeedbackType },
        complaint.timestamp,
      );
    }
    default:
      return [];
  }
}
