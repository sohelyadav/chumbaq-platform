import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Not, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { WebhookEntity } from './entities/webhook.entity';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { logValue } from '../../common/log-value';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import {
  generateWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  webhookSecretHint,
} from './webhook-secret';
import {
  WEBHOOK_MIN_DNS_BUDGET_MS,
  WebhookDnsCache,
  WebhookHostRefusedException,
  resolvePublicWebhookTarget,
} from './webhook-address';
import { postToVettedTarget } from './webhook-delivery';
import { EndpointCooldown, WEBHOOK_SLOW_RESPONSE_MS, cooldownKey } from './webhook-cooldown';

/**
 * One deadline per delivery, from the start of DNS resolution until the
 * receiver's status line and headers arrive.
 */
export const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * One deadline per event, for all of a project's deliveries together, from
 * when the event fires. They run at once, as many as the in-flight caps let
 * the event have, and the rest start as the event's own deliveries finish;
 * whatever has not started by the deadline is dropped. Two delivery timeouts,
 * so a project at its webhook cap whose clicks only get part of its slots
 * still reaches every webhook when its receivers are merely slow.
 *
 * The caps below count deliveries in flight, not for how long: this, the
 * webhook cap and the cool-down are what bound the slot-time one event takes.
 */
export const WEBHOOK_EVENT_DEADLINE_MS = 2 * WEBHOOK_TIMEOUT_MS;

/**
 * Least time a delivery is started with; with less left before the event's
 * deadline it is dropped (and counted) instead. One whole DNS lookup: a
 * delivery started a few milliseconds before the deadline gave DNS that long,
 * and failed for a reason that said nothing about the endpoint.
 */
export const WEBHOOK_MIN_DELIVERY_MS = WEBHOOK_MIN_DNS_BUDGET_MS;

/**
 * Most active webhooks a project can have. Each event goes to every one of
 * them, so without a cap one event to a project with a thousand webhooks at
 * a tarpit held its slot for a thousand timeouts. Projects from before the
 * cap keep their rows, but only the oldest this many are sent events.
 */
export const MAX_WEBHOOKS_PER_PROJECT = 10;

const OVER_WEBHOOK_CAP = `A project can have at most ${MAX_WEBHOOKS_PER_PROJECT} active webhooks. Turn one off or delete one first.`;

/**
 * Most deliveries in flight at once: per project, per account (a project's
 * owner, which is what a tenant is), and per process.
 *
 * Clicks and conversions fire webhooks without waiting for them, so nothing
 * upstream bounds these; without a cap, a tenant whose endpoint or nameserver
 * stalls piles up sockets and DNS queries for as long as traffic comes in.
 * An account may own up to MAX_PROJECTS_PER_ACCOUNT projects (10 by default,
 * more where staff raised it), so a per-project cap alone would let one
 * account hold 80 slots or more; the account cap is what tenants meet. It is
 * twice the project cap so one stalled project still leaves its sibling
 * projects room. The process cap is a safety net: one account holds at most
 * 16 of its 256 slots, so filling it takes 16 saturated accounts at once,
 * which registration throttling bounds. The project limit does not change
 * these numbers: even ten projects at their own cap would be five times the
 * account cap. The endpoint cool-down (webhook-cooldown.ts) is what keeps slow
 * endpoints from holding their slots on every event. See WEBHOOK_ISOLATION for what this
 * adds up to.
 *
 * Beyond any cap the delivery is dropped, as webhooks are best effort and have
 * no queue to hold it in. Per process: each API instance has its own counts.
 */
export const MAX_IN_FLIGHT_WEBHOOKS = 256;
export const MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT = 16;
export const MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT = 8;

/**
 * How many of a cap's slots clicks may fill. Clicks come from anyone opening a
 * public short link, so they are the volume that saturates a pool, and one is
 * worth less than a conversion; the rest of every pool is kept for conversions
 * and other events.
 */
export function clickShareOf(cap: number): number {
  return Math.floor((cap * 3) / 4);
}

/** Events that may only use the click share of each pool. */
const CLICK_EVENTS = new Set(['click']);

/** Each project's undelivered webhooks are logged at most once per this long. */
export const WEBHOOK_DROP_LOG_INTERVAL_MS = 60_000;

export interface DeliverySlotRequest {
  projectId: string;
  accountId: string;
  /** Limited to the click share of each pool. */
  click: boolean;
}

/** Which cap refused a delivery, for the log. */
export type RefusingCap = 'project' | 'account' | 'server';

/**
 * Counts deliveries in flight, per process, account and project. Exported for
 * its tests only.
 */
export class InFlightDeliveries {
  private total = 0;
  private readonly byAccount = new Map<string, number>();
  private readonly byProject = new Map<string, number>();

  tryAcquire({ projectId, accountId, click }: DeliverySlotRequest):
    | { release: () => void }
    | { refused: RefusingCap } {
    const limit = (cap: number) => (click ? clickShareOf(cap) : cap);
    const forProject = this.byProject.get(projectId) ?? 0;
    const forAccount = this.byAccount.get(accountId) ?? 0;
    // Narrowest first, so the log names the cap the tenant actually met.
    if (forProject >= limit(MAX_IN_FLIGHT_WEBHOOKS_PER_PROJECT)) return { refused: 'project' };
    if (forAccount >= limit(MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT)) return { refused: 'account' };
    if (this.total >= limit(MAX_IN_FLIGHT_WEBHOOKS)) return { refused: 'server' };

    this.total++;
    this.byAccount.set(accountId, forAccount + 1);
    this.byProject.set(projectId, forProject + 1);
    // A second call must not free a slot some other delivery now holds.
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.total--;
        decrement(this.byAccount, accountId);
        decrement(this.byProject, projectId);
      },
    };
  }
}

/** Removes the key at zero, so the maps only hold what is in flight. */
function decrement(counts: Map<string, number>, key: string): void {
  const left = (counts.get(key) ?? 1) - 1;
  if (left > 0) counts.set(key, left);
  else counts.delete(key);
}

/**
 * Undelivered webhooks counted by reason, with the first example of each.
 * Reasons come from a fixed set (see `failureOf`), so a tally stays small
 * however many deliveries it counts. Exported for its tests only.
 */
export class Tally {
  readonly counts = new Map<string, number>();
  readonly examples = new Map<string, string>();

  add(reason: string, example?: string, count = 1): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + count);
    if (example !== undefined && !this.examples.has(reason)) this.examples.set(reason, example);
  }

  addAll(other: Tally): void {
    for (const [reason, count] of other.counts) this.add(reason, other.examples.get(reason), count);
  }

  get isEmpty(): boolean {
    return this.counts.size === 0;
  }
}

/**
 * Collects each project's undelivered webhooks and says when to log them. A
 * stalled endpoint on a busy link fails on every click, and a line per
 * delivery (ten per click, each with its DNS refusal) would flood the log just
 * when it is needed. Exported for its tests only.
 */
export class DeliveryReport {
  /**
   * Most projects tracked. At it, entries with nothing to report are pruned
   * and, if that frees nothing, the oldest goes: a forgotten project only gets
   * its next line early, and loses what was held back for it.
   */
  static readonly MAX_PROJECTS = 10_000;
  private readonly byProject = new Map<string, { lastLoggedAt: number; unreported: Tally | null }>();

  constructor(private readonly maxProjects = DeliveryReport.MAX_PROJECTS) {}

  get size(): number {
    return this.byProject.size;
  }

  /**
   * Adds one event's tally. Returns what to log (with anything held back since
   * the last line) if the project is due a line, otherwise null.
   */
  record(projectId: string, tally: Tally, now = Date.now()): { tally: Tally; heldOver: boolean } | null {
    const entry = this.byProject.get(projectId);
    if (entry && now - entry.lastLoggedAt < WEBHOOK_DROP_LOG_INTERVAL_MS) {
      (entry.unreported ??= new Tally()).addAll(tally);
      return null;
    }
    const heldOver = entry?.unreported ?? null;
    if (heldOver) heldOver.addAll(tally);
    if (!entry && this.byProject.size >= this.maxProjects) {
      this.prune(now);
      // Every one held something back within the minute; Map order is oldest logged first.
      if (this.byProject.size >= this.maxProjects) this.byProject.delete(this.byProject.keys().next().value!);
    }
    // Deleted first, so the order stays by when each was last logged.
    this.byProject.delete(projectId);
    this.byProject.set(projectId, { lastLoggedAt: now, unreported: null });
    return { tally: heldOver ?? tally, heldOver: heldOver !== null };
  }

  private prune(now: number): void {
    for (const [projectId, entry] of this.byProject) {
      if (!entry.unreported && now - entry.lastLoggedAt >= WEBHOOK_DROP_LOG_INTERVAL_MS) {
        this.byProject.delete(projectId);
      }
    }
  }
}

const REFUSAL_REASON: Record<RefusingCap, string> = {
  project: 'dropped (too many deliveries in flight for the project)',
  account: 'dropped (too many deliveries in flight for its account)',
  server: 'dropped (too many deliveries in flight on this server)',
};
const PAST_DEADLINE = 'dropped (event deadline passed)';
const COOLING_DOWN = 'skipped (endpoint cooling down)';
const SLOW_ANSWER = `delivered (answered after ${WEBHOOK_SLOW_RESPONSE_MS}ms, cooling down)`;
/** The memory caps at work: a project seeing these is adding new URLs or names fast. */
const COOLDOWN_EVICTED = 'cool-down list full (oldest forgotten)';
const DNS_CACHE_EVICTED = 'DNS cache full (oldest forgotten)';

/** Failures that mean nothing answered at that address, so the endpoint cools down. */
const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENOTFOUND']);

/**
 * WEBHOOK_ISOLATION, what one tenant can do to another's webhooks (also in
 * CLAUDE.md):
 *
 *   Everything that skips or refuses a delivery (the cool-down, keyed by
 *   project and URL, and cached DNS refusals, keyed by project and hostname)
 *   belongs to one project, so slow endpoints, slow nameservers or events near
 *   their deadline can only switch off that project's own webhooks. The only
 *   state tenants share is the in-flight count, of which one account holds at
 *   most MAX_IN_FLIGHT_WEBHOOKS_PER_ACCOUNT slots.
 *
 * So degrading other tenants takes enough accounts to fill the per-process
 * cap (16 of them, at 16 of 256 slots each), which registration throttling
 * and the per-account cap bound. Spreading over many projects no longer helps
 * one account: projects per account are limited (MAX_PROJECTS_PER_ACCOUNT). Within a
 * project it is accepted that whoever can make its endpoint slow (the
 * receiver, or anyone holding a token in its URL) or fire its events (its API
 * key) can cool down that project's webhooks; the tenant points the webhook at
 * a new URL, a new token at their receiver, which is a fresh key. There is
 * deliberately no host-wide cool-down: on a shared receiver (Slack, Zapier,
 * Apps Script) it let one tenant's slow path switch off everyone's there.
 *
 * Memory (per-project-lru.ts): the cool-down and the DNS cache, good answers
 * included, keep each project's entries in that project's own small map,
 * keyed by digests, and keep the maps of a bounded number of projects
 * (webhook-cooldown.ts, webhook-address.ts). A project's entries are added and
 * pushed out only by its own deliveries, except that its whole map goes when
 * it is the least recently active of those projects and a project not in the
 * list arrives. So pushing out one project's entries takes that many other
 * projects active more recently, which with the project limit means hundreds
 * of accounts (500 for the cool-down's 5,000 at the default of 10 each, 200
 * for DNS), and costs it only one more delivery to its own slow endpoint (in
 * its own slots) or one more lookup. Each eviction is
 * counted in the report of the project that caused it.
 */

/**
 * How a delivery that threw failed, as a reason to count it under, and
 * whether a fast failure still cools the webhook down: one that could not
 * connect, or whose host was refused, would fail the same way next time. A
 * fast reset, TLS error or timeout under a budget the event's deadline cut
 * short says nothing lasting. A slow delivery cools down whatever this says.
 */
function failureOf(err: unknown, fullBudget: boolean): { reason: string; coolsDown: boolean; detail: string } {
  if (err instanceof WebhookHostRefusedException) {
    // A lookup that failed under a cut budget may only have run out of time.
    const coolsDown = err.kind !== 'lookup failed' || fullBudget;
    return { reason: `refused (${err.kind})`, coolsDown, detail: err.detail };
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const detail = String(err);
  if (code === 'ETIMEDOUT') return { reason: 'failed (no response in time)', coolsDown: false, detail };
  if (code && CONNECT_FAILURES.has(code)) {
    return { reason: `failed (could not connect: ${code})`, coolsDown: true, detail };
  }
  // Node's codes are a fixed set; anything else counts as one reason, so a
  // tally cannot grow with whatever text an error carries.
  const known = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error';
  return { reason: `failed (${known})`, coolsDown: false, detail };
}

/** What any response says about a webhook. Never the secret. */
export interface WebhookView {
  id: string;
  projectId: string;
  url: string;
  events: string[];
  isActive: boolean;
  secretHint: string | null;
  secretRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Only from create and rotate: the one time the plaintext leaves the server. */
export interface WebhookWithSecret extends WebhookView {
  secret: string;
}

/**
 * Built field by field rather than spread, so a column added to the entity
 * later is not returned until someone decides it should be.
 */
export function toWebhookView(webhook: WebhookEntity): WebhookView {
  return {
    id: webhook.id,
    projectId: webhook.projectId,
    url: webhook.url,
    events: webhook.events,
    isActive: webhook.isActive,
    secretHint: webhook.secretHint ?? null,
    secretRotatedAt: webhook.secretRotatedAt ?? null,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}

/** The same events, in any order: a reordered list is not a change. */
function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  const sorted = (list: readonly string[]) => [...list].sort();
  return a.length === b.length && sorted(a).every((event, i) => event === sorted(b)[i]);
}

/** The requested fields whose value differs from the stored row's. */
export function changedWebhookFields(
  current: Pick<WebhookEntity, 'url' | 'events' | 'isActive'>,
  requested: Partial<Pick<WebhookEntity, 'url' | 'events' | 'isActive'>>,
): Partial<Pick<WebhookEntity, 'url' | 'events' | 'isActive'>> {
  const patch: Partial<Pick<WebhookEntity, 'url' | 'events' | 'isActive'>> = {};
  if (requested.url !== undefined && requested.url !== current.url) patch.url = requested.url;
  if (requested.events !== undefined && !sameEvents(requested.events, current.events)) {
    patch.events = requested.events;
  }
  if (requested.isActive !== undefined && requested.isActive !== current.isActive) {
    patch.isActive = requested.isActive;
  }
  return patch;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  // The service is a singleton, so these cover every delivery in the process.
  private readonly inFlight = new InFlightDeliveries();
  private readonly reports = new DeliveryReport();
  /** By project and URL (cooldownKey): only ever the project's own endpoint. */
  private readonly cooldown = new EndpointCooldown();
  private readonly dnsCache = new WebhookDnsCache();
  /** Projects already told they are over the webhook cap. */
  private readonly toldOverCap = new Set<string>();

  constructor(
    @InjectRepository(WebhookEntity)
    private readonly webhookRepository: Repository<WebhookEntity>,
    private readonly suspension: ProjectSuspensionService,
    private readonly credentialsCrypto: CredentialsCryptoService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * How the activity log names a webhook: by its id, never its URL. The URL is often the
   * credential itself (a Slack or Zapier hook), and even its host can carry a token.
   */
  private webhookTarget(id: string): { type: 'webhook'; id: string; label: string } {
    return { type: 'webhook', id, label: id };
  }

  /** `webhook.created` (its events, never its URL) is written in the insert's transaction. */
  async create(
    projectId: string,
    dto: CreateWebhookDto,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<WebhookWithSecret> {
    await resolvePublicWebhookTarget(dto.url);
    const secret = generateWebhookSecret();
    const isActive = dto.isActive !== undefined ? dto.isActive : true;
    const saved = await this.webhookRepository.manager.transaction(async (manager) => {
      if (isActive) await this.assertRoomForActive(manager, projectId);
      const webhooks = manager.getRepository(WebhookEntity);
      const row = await webhooks.save(
        webhooks.create({
          projectId,
          url: dto.url,
          events: dto.events,
          secretSealed: sealWebhookSecret(this.credentialsCrypto, secret),
          secretHint: webhookSecretHint(secret),
          secretRotatedAt: null,
          isActive,
        }),
      );
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'webhook.created',
          target: this.webhookTarget(row.id),
          details: { events: row.events },
        },
        ctx,
        manager,
      );
      return row;
    });
    return { ...toWebhookView(saved), secret };
  }

  /**
   * Refuses one more active webhook in a project at the cap. `except` is the
   * webhook being turned on, which must not count against itself.
   */
  private async assertRoomForActive(manager: EntityManager, projectId: string, except?: string): Promise<void> {
    // Two requests at once would otherwise both count nine and both add one.
    // NO KEY UPDATE, so the webhook insert's own foreign key check still passes.
    await manager.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [projectId]);
    const active = await manager.getRepository(WebhookEntity).count({
      where: { projectId, isActive: true, ...(except ? { id: Not(except) } : {}) },
    });
    if (active >= MAX_WEBHOOKS_PER_PROJECT) throw new BadRequestException(OVER_WEBHOOK_CAP);
  }

  /**
   * Replaces the secret at once; the old one stops verifying with the next
   * delivery. No overlap window: a rotation is usually because the old secret
   * leaked, and an overlap would keep the leak useful.
   */
  async rotateSecret(
    id: string,
    projectId: string,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<WebhookWithSecret> {
    await this.findOne(id, projectId);
    const secret = generateWebhookSecret();
    await this.webhookRepository.manager.transaction(async (manager) => {
      // Only the secret columns: a save() of a loaded row would also write back
      // url, events and isActive as they were when it was read.
      const result = await manager.getRepository(WebhookEntity).update(
        { id, projectId },
        {
          secretSealed: sealWebhookSecret(this.credentialsCrypto, secret),
          secretHint: webhookSecretHint(secret),
          secretRotatedAt: new Date(),
        },
      );
      if (!result.affected) throw new NotFoundException('Webhook not found');
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'webhook.secret_rotated',
          target: this.webhookTarget(id),
        },
        ctx,
        manager,
      );
    });
    return { ...toWebhookView(await this.findOne(id, projectId)), secret };
  }

  async findAllByProject(projectId: string): Promise<WebhookEntity[]> {
    return this.webhookRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, projectId: string): Promise<WebhookEntity> {
    const webhook = await this.webhookRepository.findOne({
      where: { id, projectId },
    });
    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }
    return webhook;
  }

  /**
   * Writes only the fields whose value really changes, compared with the row under a
   * lock, and logs `webhook.changed` with those field *names* in the same transaction.
   * A new URL shows up only as the name `url`. A PATCH that changes nothing writes and
   * logs nothing.
   */
  async update(
    id: string,
    projectId: string,
    dto: UpdateWebhookDto,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<WebhookEntity> {
    const webhook = await this.findOne(id, projectId);
    if (dto.url && dto.url !== webhook.url) {
      await resolvePublicWebhookTarget(dto.url);
    }
    // Named fields, not Object.assign: whatever else a body carries must never
    // reach the row, least of all projectId or the secret. And update(), not
    // save(): save() writes back every column of the row as it was loaded, so a
    // rotation landing between that read and this write would be undone, and
    // deliveries would go on signing with the secret the user just replaced.
    const requested: Partial<Pick<WebhookEntity, 'url' | 'events' | 'isActive'>> = {};
    if (dto.url !== undefined) requested.url = dto.url;
    if (dto.events !== undefined) requested.events = dto.events;
    if (dto.isActive !== undefined) requested.isActive = dto.isActive;
    if (Object.keys(requested).length > 0) {
      await this.webhookRepository.manager.transaction(async (manager) => {
        // The projects row first, as every project transaction takes it (lock order),
        // then the webhook row the comparison is made against.
        await manager.query('SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE', [projectId]);
        const webhooks = manager.getRepository(WebhookEntity);
        const current = await webhooks.findOne({
          where: { id, projectId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current) throw new NotFoundException('Webhook not found');
        const patch = changedWebhookFields(current, requested);
        const fields = Object.keys(patch);
        if (fields.length === 0) return;
        if (patch.isActive === true) await this.assertRoomForActive(manager, projectId, id);
        await webhooks.update({ id, projectId }, patch);
        await this.activity.record(
          {
            projectId,
            actor: { kind: 'user', userId: actorId },
            action: 'webhook.changed',
            target: this.webhookTarget(id),
            details: { events: patch.events ?? current.events, fields },
          },
          ctx,
          manager,
        );
      });
    }
    // Nothing to forget: the cool-down is keyed by URL, so a new one starts
    // afresh and the old one's runs out on its own.
    return this.findOne(id, projectId);
  }

  /**
   * `webhook.deleted` is written in the delete's transaction, and only by the request
   * whose DELETE removed the row: a second one racing it gets the usual 404.
   */
  async remove(id: string, projectId: string, actorId: string, ctx: ActivityContext): Promise<void> {
    await this.findOne(id, projectId);
    await this.webhookRepository.manager.transaction(async (manager) => {
      const result = await manager.getRepository(WebhookEntity).delete({ id, projectId });
      if (!result.affected) throw new NotFoundException('Webhook not found');
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'webhook.deleted',
          target: this.webhookTarget(id),
        },
        ctx,
        manager,
      );
    });
  }

  async fireWebhook(
    projectId: string,
    eventType: string,
    payload: Record<string, any>,
  ): Promise<void> {
    // From the start, so a slow query or suspension check comes out of it too.
    const eventDeadline = Date.now() + WEBHOOK_EVENT_DEADLINE_MS;
    // The project comes in the same query: its owner is the account the
    // in-flight caps count against, without a lookup per click. Oldest first,
    // and one more than are sent to, only to tell a project over the cap.
    const webhooks = await this.webhookRepository.find({
      where: { projectId, isActive: true },
      relations: { project: true },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: MAX_WEBHOOKS_PER_PROJECT + 1,
    });
    if (webhooks.length > MAX_WEBHOOKS_PER_PROJECT) this.tellOverCap(projectId);

    const relevant = webhooks.slice(0, MAX_WEBHOOKS_PER_PROJECT).filter((w) => w.events.includes(eventType));
    if (relevant.length === 0) return;

    // Conversions keep being ingested during a suspension, so without this a
    // suspended tenant's data would keep leaving for its endpoints. Dropped, not
    // held: webhooks have no queue to hold them in, as with any other miss.
    if (await this.suspension.isSuspended(projectId)) return;

    const slot: DeliverySlotRequest = {
      projectId,
      // Every row has a project (the foreign key cascades), so the fallback
      // only stops a missing join from merging unrelated projects into one
      // account; it still caps the project.
      accountId: relevant[0].project?.ownerId ?? `project:${projectId}`,
      click: CLICK_EVENTS.has(eventType),
    };
    const tally = new Tally();
    await this.deliverAll(relevant, slot, eventDeadline, tally, (webhook) =>
      this.deliverOne(webhook, eventType, payload, eventDeadline, tally),
    );
    this.report(projectId, tally);
  }

  /**
   * Starts as many deliveries as the caps allow, and another each time one of
   * this event's own finishes, until all have started or the deadline has
   * passed. Each takes its own slot and gives it back when it ends, whatever
   * the outcome. Resolves once every delivery has ended or been dropped.
   */
  private deliverAll(
    webhooks: WebhookEntity[],
    slot: DeliverySlotRequest,
    eventDeadline: number,
    tally: Tally,
    deliver: (webhook: WebhookEntity) => Promise<void>,
  ): Promise<void> {
    const queue = [...webhooks];
    let running = 0;
    const keyOf = (webhook: WebhookEntity) => cooldownKey(webhook.projectId, webhook.url);
    const cooling = (webhook: WebhookEntity) => this.cooldown.blocks(keyOf(webhook));
    const dropRest = (reason: string) => {
      for (const webhook of queue.splice(0)) tally.add(cooling(webhook) ? COOLING_DOWN : reason);
    };
    return new Promise((done) => {
      const pump = () => {
        while (queue.length > 0) {
          if (eventDeadline - Date.now() < WEBHOOK_MIN_DELIVERY_MS) {
            dropRest(PAST_DEADLINE);
            break;
          }
          // Checked before a slot is taken, so a cooling endpoint takes none.
          if (cooling(queue[0])) {
            queue.shift();
            tally.add(COOLING_DOWN);
            continue;
          }
          const acquired = this.inFlight.tryAcquire(slot);
          if ('refused' in acquired) {
            // One of this event's own deliveries finishing frees a slot it can
            // use. With none out, nothing here will.
            if (running === 0) dropRest(REFUSAL_REASON[acquired.refused]);
            break;
          }
          const webhook = queue.shift()!;
          running++;
          this.cooldown.started(keyOf(webhook));
          void deliver(webhook).finally(() => {
            acquired.release();
            running--;
            pump();
          });
        }
        if (running === 0 && queue.length === 0) done();
      };
      pump();
    });
  }

  /** Never rejects: every way it can end is counted into `tally`. */
  private async deliverOne(
    webhook: WebhookEntity,
    eventType: string,
    payload: Record<string, any>,
    eventDeadline: number,
    tally: Tally,
  ): Promise<void> {
    // A delivery's own deadline, never past the event's.
    const startedAt = Date.now();
    const timeoutMs = Math.min(WEBHOOK_TIMEOUT_MS, eventDeadline - startedAt);
    const fullBudget = timeoutMs >= WEBHOOK_TIMEOUT_MS;
    const deadline = startedAt + timeoutMs;
    const key = cooldownKey(webhook.projectId, webhook.url);
    /** Slow is judged on the whole delivery, DNS included, however it ended. */
    const wasSlow = () => Date.now() - startedAt > WEBHOOK_SLOW_RESPONSE_MS;
    const coolDown = () => {
      const evicted = this.cooldown.slow(key);
      if (evicted > 0) tally.add(COOLDOWN_EVICTED, undefined, evicted);
    };
    try {
      // Resolved and checked again here, since DNS may have changed since
      // the URL was saved, and the request then goes only to the addresses
      // this check saw: postToVettedTarget never asks DNS a second time,
      // which is what DNS rebinding relies on.
      const target = await resolvePublicWebhookTarget(webhook.url, timeoutMs, {
        cache: this.dnsCache,
        projectId: webhook.projectId,
        fullBudget,
        onEvicted: (count) => tally.add(DNS_CACHE_EVICTED, undefined, count),
      });

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({
        event: eventType,
        data: payload,
        timestamp: new Date().toISOString(),
      });
      // Sign `<timestamp>.<body>` so receivers can validate freshness and
      // reject replayed payloads. Stripe-style.
      const signature = crypto
        .createHmac('sha256', openWebhookSecret(this.credentialsCrypto, webhook.secretSealed))
        .update(`${timestamp}.${body}`)
        .digest('hex');

      // What DNS used comes out of the same deadline, so a slow nameserver
      // and a slow receiver together still cannot hold the slot longer.
      const left = deadline - Date.now();
      if (left <= 0) {
        throw Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
      }
      await postToVettedTarget(target, {
        timeoutMs: left,
        headers: {
          'Content-Type': 'application/json',
          'X-Chumbaq-Signature': signature,
          'X-Chumbaq-Timestamp': timestamp,
        },
        body,
      });
      if (wasSlow()) {
        // A late answer held the slot nearly as long as a stall.
        coolDown();
        tally.add(SLOW_ANSWER, `webhook ${webhook.id}`);
      } else {
        this.cooldown.answered(key, startedAt);
      }
    } catch (err) {
      const failure = failureOf(err, fullBudget);
      if (wasSlow() || failure.coolsDown) coolDown();
      else this.cooldown.settled(key);
      tally.add(failure.reason, `webhook ${webhook.id}: ${logValue(failure.detail)}`);
    }
  }

  private report(projectId: string, tally: Tally): void {
    if (tally.isEmpty) return;
    const due = this.reports.record(projectId, tally);
    if (!due) return;
    const parts = [...due.tally.counts].map(([reason, count]) => {
      const example = due.tally.examples.get(reason);
      return `${count} ${reason}${example ? `, e.g. ${example}` : ''}`;
    });
    const since = due.heldOver ? ' since the last report' : '';
    this.logger.warn(`Webhook deliveries for project ${projectId}${since}: ${parts.join('; ')}`);
  }

  /** Once per project per process, not per event: it will not change until someone deletes webhooks. */
  private tellOverCap(projectId: string): void {
    if (this.toldOverCap.has(projectId)) return;
    // Bounded; a project forgotten here is only told again.
    if (this.toldOverCap.size >= 10_000) this.toldOverCap.clear();
    this.toldOverCap.add(projectId);
    this.logger.warn(
      `Project ${projectId} has more than ${MAX_WEBHOOKS_PER_PROJECT} active webhooks, from before the cap; only the ${MAX_WEBHOOKS_PER_PROJECT} oldest are sent events`,
    );
  }
}
