import { PerProjectLru, webhookCacheKey } from './per-project-lru';

/**
 * How long a webhook is left alone after a slow delivery: 30 seconds, doubling
 * with each slow retry up to 10 minutes, and forgotten as soon as it answers
 * fast, with any status.
 *
 * The in-flight caps bound how many deliveries wait at once, not how long each
 * waits, so endpoints that never answer, or answer late, would otherwise keep
 * their share of every pool full for as long as traffic comes in. Skipped, a
 * slow endpoint holds one of its account's slots for one timeout per
 * cool-down.
 *
 * Keyed by project and URL (`cooldownKey`), never by host: on a shared
 * receiver (Slack, Zapier, Apps Script) the path picks the code that runs, so
 * a key any wider let one tenant's slow path switch off other tenants there.
 */
export const WEBHOOK_COOLDOWN_START_MS = 30_000;
export const WEBHOOK_COOLDOWN_MAX_MS = 10 * 60_000;

/**
 * A delivery that took longer than this, from its start to however it ended
 * (an answer with any status, a timeout, a reset, a parse error), is slow.
 * Judging by the outcome let a receiver that answers, or resets, just inside
 * the 5s timeout hold its slot for almost the whole timeout on every delivery,
 * which is the same pool exhaustion as never answering. Half the delivery
 * timeout (webhooks.service.ts).
 */
export const WEBHOOK_SLOW_RESPONSE_MS = 2500;

/**
 * Most endpoints one project has cooled down at once, and most projects whose
 * cool-downs a process keeps (per-project-lru.ts). A tenant adds entries
 * cheaply (a webhook at a closed port, a new URL, an event fired with their
 * own API key), so without caps the map grew for as long as they kept at it.
 * A project has at most 10 active webhooks, so 20 is twice what an honest one
 * uses, and a project flooding new URLs only pushes out its own. 5,000
 * projects of 20 is at most 100,000 entries, a few tens of megabytes. Pushing
 * out a project's cool-downs takes 5,000 other projects active more recently,
 * and costs it only deliveries to its own slow endpoints, in its own slots.
 */
export const WEBHOOK_COOLDOWN_MAX_PROJECTS = 5_000;
export const WEBHOOK_COOLDOWN_MAX_ENTRIES_PER_PROJECT = 20;

/** One project's webhooks at one URL: what a cool-down belongs to. */
export interface CooldownKey {
  projectId: string;
  /** A digest of the project and URL, so an entry's size is the same for any URL. */
  digest: string;
}

/**
 * The cool-down's key: one project's webhooks at one URL. By URL rather than
 * webhook id, so deleting and re-creating the webhook does not start it
 * afresh; spelled as the URL parser writes it, so `HTTPS://Host:443/x` is the
 * same endpoint as `https://host/x`. A changed URL is a new key, which the
 * per-project cap bounds.
 */
export function cooldownKey(projectId: string, rawUrl: string): CooldownKey {
  let url: string;
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    url = parsed.href;
  } catch {
    // Saved URLs were all parsed on create; this only keeps a bad row its own key.
    url = rawUrl;
  }
  return { projectId, digest: webhookCacheKey(projectId, url) };
}

interface CooldownEntry {
  /** Not sent to before this. */
  until: number;
  /** The cool-down this entry was given, which the next slow delivery doubles. */
  backoffMs: number;
  /** A delivery started after the cool-down ended and has not finished. */
  probing: boolean;
  /** When the slow delivery that set `until` ended. */
  failedAt: number;
}

/**
 * Per key, per process, in memory: each API instance finds a slow endpoint out
 * for itself, which costs one timeout per instance. Exported for its tests
 * only.
 *
 * Entries are only removed by a fast answer or by the caps: within a project
 * the one set longest ago goes first, which is also the one most likely long
 * finished, and a whole project's go when it is the least recently active of
 * WEBHOOK_COOLDOWN_MAX_PROJECTS. Forgetting one only means that endpoint is
 * tried again, in its own project's slots.
 */
export class EndpointCooldown {
  private readonly byKey: PerProjectLru<CooldownEntry>;

  constructor(maxProjects = WEBHOOK_COOLDOWN_MAX_PROJECTS, maxPerProject = WEBHOOK_COOLDOWN_MAX_ENTRIES_PER_PROJECT) {
    this.byKey = new PerProjectLru(maxProjects, maxPerProject);
  }

  get projectCount(): number {
    return this.byKey.projectCount;
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * True while the endpoint is cooling down, or while the one delivery that
   * tests it afterwards is out: until that ends, more would only stall
   * beside it.
   */
  blocks(key: CooldownKey, now = Date.now()): boolean {
    const entry = this.byKey.get(key.projectId, key.digest);
    return !!entry && (now < entry.until || entry.probing);
  }

  /** A delivery to the endpoint has started. */
  started(key: CooldownKey): void {
    const entry = this.byKey.get(key.projectId, key.digest);
    if (entry) entry.probing = true;
  }

  /**
   * It answered fast, whatever the status: it starts afresh. Not if the
   * delivery started before the slow one that cooled it, which a burst of
   * deliveries started together would otherwise undo.
   */
  answered(key: CooldownKey, startedAt?: number): void {
    const entry = this.byKey.get(key.projectId, key.digest);
    if (entry && startedAt !== undefined && startedAt < entry.failedAt) return;
    this.byKey.delete(key.projectId, key.digest);
  }

  /**
   * It was slow, however it ended, or could not be reached at all. Returns
   * how many other endpoints were forgotten to make room.
   */
  slow(key: CooldownKey, now = Date.now()): number {
    const entry = this.byKey.get(key.projectId, key.digest);
    // Deliveries that started before the first slow one end together; one
    // cool-down covers them all, or a burst would jump to the maximum at once.
    if (entry && !entry.probing && now < entry.until) return 0;
    const backoffMs = entry ? Math.min(entry.backoffMs * 2, WEBHOOK_COOLDOWN_MAX_MS) : WEBHOOK_COOLDOWN_START_MS;
    return this.byKey.set(key.projectId, key.digest, { until: now + backoffMs, backoffMs, probing: false, failedAt: now });
  }

  /** It ended fast some other way, which says nothing about the endpoint. */
  settled(key: CooldownKey): void {
    const entry = this.byKey.get(key.projectId, key.digest);
    if (entry) entry.probing = false;
  }
}
