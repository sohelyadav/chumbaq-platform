import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { TrackingObjectionEntity } from './entities/tracking-objection.entity';

/**
 * Whatever a request knows about who it is about. Any one key is enough; a
 * request carrying none of them is about nobody we know and is never treated
 * as do-not-track.
 */
export interface TrackingSubject {
  projectId: string;
  /** The device row; its own flag applies. */
  deviceIdentityId?: string | null;
  /** The device row, by fingerprint; its own flag applies. */
  deviceFingerprint?: string | null;
  /**
   * An event's distinct id: an unverified claim, matched only against trusted
   * objections, never against any device row (not even as a fingerprint).
   */
  distinctId?: string | null;
  /** A claimed external id: matched only against trusted objections. */
  externalUserId?: string | null;
}

/** What was not stored because its subject is do-not-track. Labels only, never who. */
export const TRACKING_DROP_KINDS = [
  'event',
  'conversion',
  'revenue',
  'touchpoint',
  'click_device_link',
  'in_app_event',
  'session',
] as const;
export type TrackingDropKind = (typeof TRACKING_DROP_KINDS)[number];

/** At most one summary line per this interval, however many drops. */
const DROP_REPORT_INTERVAL_MS = 60_000;

/**
 * The trust model (DPDP work item 2b; the erasure work uses the same one):
 * identity links reported by the SDK (`distinct_id`, `external_user_id`) are
 * unverified claims, because the SDK's API key ships inside every app. So:
 *
 * - An SDK-set `device_identities.do_not_track` covers only the row that set
 *   it, and data arriving for that row, named by its id or its fingerprint.
 *   It never spreads through those links: otherwise anyone could identify a
 *   device as a stranger's external id, turn do-not-track on, and switch off
 *   tracking for the stranger. A request's distinct id never names a device
 *   row either: an attacker can register a device whose *fingerprint* is the
 *   victim's distinct id, and matching one against the other would hand the
 *   attacker's flag to every event the victim sends. The SDKs send the
 *   device's own fingerprint with every event, which is what names the row.
 * - A `tracking_objections` row, written only by an explicit person-level
 *   dashboard action (PersonObjectionsService), covers the whole person: every row, and every request, naming
 *   that external id. Matching a request's *claimed* external or distinct id
 *   against it can only over-apply do-not-track, never lift it.
 *
 * Every lookup is one equality on one indexed key per branch, joined by UNION
 * ALL or separate EXISTS, never OR across columns: an OR cannot use any one
 * index and degraded to a scan of the project's whole `device_identities` on
 * every ingest call. `tracking-consent-plan.int-spec.ts` fails if a sequential
 * scan comes back. Exported for that spec.
 *
 * $1 project, $2 identity id, $3 fingerprint, $4 distinct id, $5 external id.
 */
export const IS_DO_NOT_TRACK_SQL = `
  WITH subject AS (
    SELECT external_user_id, do_not_track FROM device_identities
     WHERE project_id = $1 AND id = $2::uuid
    UNION ALL
    SELECT external_user_id, do_not_track FROM device_identities
     WHERE project_id = $1 AND device_fingerprint = $3
  )
  SELECT (
    EXISTS (SELECT 1 FROM subject WHERE do_not_track = true)
    OR EXISTS (
      SELECT 1 FROM tracking_objections o
       WHERE o.project_id = $1 AND o.external_user_id = $5
    )
    OR EXISTS (
      SELECT 1 FROM tracking_objections o
       WHERE o.project_id = $1 AND o.external_user_id = $4
    )
    OR EXISTS (
      SELECT 1 FROM subject s
        JOIN tracking_objections o
          ON o.project_id = $1 AND o.external_user_id = s.external_user_id
    )
  ) AS dnt`;

/** The ids in $2 that are tracked: their own row is not do-not-track and no objection covers their person. */
export const WITHOUT_DO_NOT_TRACK_SQL = `
  SELECT i.id
  FROM device_identities i
  WHERE i.id = ANY($2::uuid[])
    AND i.project_id = $1
    AND i.do_not_track = false
    AND NOT EXISTS (
      SELECT 1 FROM tracking_objections o
       WHERE o.project_id = $1 AND o.external_user_id = i.external_user_id
    )`;

/**
 * Decides whether behavioural data about someone may be stored or used, and
 * counts what was dropped because it may not.
 *
 * `do_not_track` is a withdrawal of consent to behavioural analytics (DPDP Act
 * s.6(6): processing stops). Every SDK ingest path that would store behaviour
 * asks this first and, for a do-not-track person, drops it while still
 * answering 2xx, because the native SDK queues treat a 4xx as terminal and a
 * 5xx as retry-forever, and neither is what a consent decision should cause.
 * Consent changes themselves are never dropped. Design and the full list of
 * paths: docs/superpowers/specs/2026-11-07-consent-enforcement.md.
 */
@Injectable()
export class TrackingConsentService {
  private readonly logger = new Logger(TrackingConsentService.name);
  private readonly drops = new Map<TrackingDropKind, number>();
  private lastReportAt = 0;

  constructor(
    @InjectRepository(DeviceIdentityEntity)
    private readonly identityRepository: Repository<DeviceIdentityEntity>,
  ) {}

  /**
   * True when what this request is about must not be tracked: the device row
   * it names set do-not-track itself, or a trusted objection covers the
   * external id of that row or the one the request claims. See the trust model
   * above IS_DO_NOT_TRACK_SQL.
   */
  async isDoNotTrack(subject: TrackingSubject, manager?: EntityManager): Promise<boolean> {
    const id = subject.deviceIdentityId ?? null;
    const fingerprint = subject.deviceFingerprint ?? null;
    const distinctId = subject.distinctId ?? null;
    const externalUserId = subject.externalUserId ?? null;
    if (!id && !fingerprint && !distinctId && !externalUserId) return false;

    // On the caller's transaction when it holds one (identify does, under a
    // row lock): another connection here would wait on the pool or the lock.
    const rows: Array<{ dnt: boolean }> = await (manager ?? this.identityRepository.manager).query(
      IS_DO_NOT_TRACK_SQL,
      [subject.projectId, id, fingerprint, distinctId, externalUserId],
    );
    return rows[0]?.dnt === true;
  }

  /**
   * The identities in `ids` whose person is not do-not-track, in one query.
   * For audiences built from stored behaviour (Mixpanel cohorts), which a
   * do-not-track person must not be picked by.
   */
  async withoutDoNotTrack(projectId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows: Array<{ id: string }> = await this.identityRepository.query(
      WITHOUT_DO_NOT_TRACK_SQL,
      [projectId, ids],
    );
    const kept = new Set(rows.map((row) => row.id));
    return ids.filter((id) => kept.has(id));
  }

  /** True when a trusted whole-person objection exists for this external id. */
  async hasPersonObjection(
    projectId: string,
    externalUserId: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const count = await (manager ?? this.identityRepository.manager)
      .getRepository(TrackingObjectionEntity)
      .count({ where: { projectId, externalUserId } });
    return count > 0;
  }

  /**
   * Counts one dropped item and, at most once a minute, logs the running
   * totals. Never who, never which project: the count is the metric, and a
   * log line naming a person would itself be the tracking that was refused.
   */
  recordDrop(kind: TrackingDropKind): void {
    this.drops.set(kind, (this.drops.get(kind) ?? 0) + 1);
    const now = Date.now();
    if (now - this.lastReportAt < DROP_REPORT_INTERVAL_MS) return;
    this.lastReportAt = now;
    const summary = [...this.drops.entries()]
      .map(([dropKind, count]) => `${dropKind}=${count}`)
      .join(' ');
    this.logger.log(`do_not_track: not stored since start: ${summary}`);
  }

  /** Running totals since the process started, for tests and a future metrics endpoint. */
  dropCounts(): Record<TrackingDropKind, number> {
    return Object.fromEntries(
      TRACKING_DROP_KINDS.map((kind) => [kind, this.drops.get(kind) ?? 0]),
    ) as Record<TrackingDropKind, number>;
  }
}
