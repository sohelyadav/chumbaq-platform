import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { ConsentEventsService } from './consent-events.service';
import { TrackingObjectionEntity } from './entities/tracking-objection.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

const FOREIGN_KEY_VIOLATION = '23503';
/** A deadlock or serialization failure: a retryable conflict, not a server error. */
const RETRYABLE = new Set(['40P01', '40001']);

/** What the dashboard shows before, and returns after, a person-level action. */
export interface PersonObjectionView {
  externalUserId: string;
  /** Device rows in the project claiming this external id right now. */
  deviceCount: number;
  objecting: boolean;
  createdAt: Date | null;
  createdBy: string | null;
  sourceIdentityId: string | null;
}

/**
 * Whole-person do-not-track (`tracking_objections`), as explicit dashboard
 * actions that name the external id. The only writer of that table.
 *
 * Never implied by anything else: a row-level consent change, an identify or
 * a login. The external id on a device row is whatever its SDK last claimed
 * (the SDK key is public), so deriving a person-wide objection from a row
 * would let anyone aim one at a stranger, or have support lift a stranger's.
 * Naming the id, and seeing how many devices claim it, is what makes the team
 * member's decision about that person. The controller adds owner-only access,
 * no view-as, and a recent sign-in to lift.
 */
@Injectable()
export class PersonObjectionsService {
  constructor(
    @InjectRepository(TrackingObjectionEntity)
    private readonly objections: Repository<TrackingObjectionEntity>,
    @InjectRepository(DeviceIdentityEntity)
    private readonly identities: Repository<DeviceIdentityEntity>,
    private readonly consentEvents: ConsentEventsService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** For the confirmation: the exact id and how many devices it would cover. */
  async preview(projectId: string, externalUserId: string): Promise<PersonObjectionView> {
    return this.view(this.identities.manager, projectId, externalUserId);
  }

  /**
   * Records a whole-person objection. Idempotent: an existing one keeps its
   * provenance and writes no new history. Otherwise writes `consent_events`
   * (`tracking`, not granted, `dashboard`) for every device currently claiming
   * the id, in the same transaction.
   *
   * With a `requester`, a new objection is also written to the project activity
   * log as `tracking.objection_recorded`, in the same transaction, with no
   * target and no details: it is made by external id, which never reaches the
   * log, and the source row would point straight back at that id. An existing
   * one writes nothing.
   */
  async object(
    projectId: string,
    externalUserId: string,
    actor: { userId: string; sourceIdentityId?: string | null },
    requester: ActivityRequester | null,
  ): Promise<PersonObjectionView> {
    const sourceIdentityId = actor.sourceIdentityId ?? null;

    return this.inTransaction(async (manager) => {
      const locked = await this.lockDevices(manager, projectId, externalUserId, sourceIdentityId);
      if (sourceIdentityId && !locked.includes(sourceIdentityId)) {
        throw new NotFoundException('Person not found');
      }

      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(TrackingObjectionEntity)
        .values({ projectId, externalUserId, createdBy: actor.userId, sourceIdentityId })
        .orIgnore()
        .returning(['external_user_id'])
        .execute();
      const created = ((result.raw ?? []) as unknown[]).length > 0;
      if (created) {
        await this.consentEvents.recordForPerson(manager, projectId, externalUserId, false);
        if (requester) {
          await recordBy(this.activity, requester, { projectId, action: 'tracking.objection_recorded' }, manager);
        }
      }
      return this.view(manager, projectId, externalUserId);
    });
  }

  /**
   * Lifts a whole-person objection, writing `granted` history for every device claiming the id.
   *
   * With a `requester`, a lift that removed an objection is also written to the project
   * activity log as `tracking.objection_lifted`, in the same transaction, with no target
   * and no details (as for `object`). Lifting where there was none writes nothing.
   */
  async lift(
    projectId: string,
    externalUserId: string,
    requester: ActivityRequester | null,
  ): Promise<PersonObjectionView> {
    return this.inTransaction(async (manager) => {
      await this.lockDevices(manager, projectId, externalUserId, null);
      const result = await manager.delete(TrackingObjectionEntity, { projectId, externalUserId });
      if ((result.affected ?? 0) > 0) {
        await this.consentEvents.recordForPerson(manager, projectId, externalUserId, true);
        if (requester) {
          await recordBy(this.activity, requester, { projectId, action: 'tracking.objection_lifted' }, manager);
        }
      }
      return this.view(manager, projectId, externalUserId);
    });
  }

  /**
   * Holds the device rows this action will reference, FOR KEY SHARE, in one
   * statement in id order: the source row, and every row claiming the id
   * (`recordForPerson` writes history against each).
   *
   * An erasure of the same person locks those rows FOR UPDATE in id order
   * (`resolvePersonScope`) and deletes them. Checked before the transaction,
   * as this once was, a row the erasure was deleting still looked present, and
   * the insert then failed its foreign key with a 500. Locked here, this waits
   * for the erasure, and an erased row is simply not returned: the source is a
   * 404, and erased devices get no history. Same order as the erasure, so the
   * two cannot deadlock.
   *
   * @returns the ids locked.
   */
  private async lockDevices(
    manager: EntityManager,
    projectId: string,
    externalUserId: string,
    sourceIdentityId: string | null,
  ): Promise<string[]> {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT id FROM device_identities
       WHERE project_id = $1 AND (external_user_id = $2 OR id = ANY($3::uuid[]))
       ORDER BY id
       FOR KEY SHARE`,
      [projectId, externalUserId, sourceIdentityId ? [sourceIdentityId] : []],
    );
    return rows.map((row) => row.id);
  }

  /**
   * The locks above leave one gap: a device claiming the id that arrives and
   * is erased between them and the history insert. Its foreign key violation
   * is a conflict to retry, not a server error.
   */
  private async inTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.identities.manager.transaction(work);
    } catch (error) {
      const code = error instanceof QueryFailedError ? (error as { code?: string }).code : undefined;
      if (code === FOREIGN_KEY_VIOLATION || (code !== undefined && RETRYABLE.has(code))) {
        throw new ConflictException('This person changed while saving. Nothing was changed. Try again.');
      }
      throw error;
    }
  }

  private async view(
    manager: EntityManager,
    projectId: string,
    externalUserId: string,
  ): Promise<PersonObjectionView> {
    const [objection, deviceCount] = await Promise.all([
      manager.getRepository(TrackingObjectionEntity).findOne({ where: { projectId, externalUserId } }),
      manager.getRepository(DeviceIdentityEntity).count({ where: { projectId, externalUserId } }),
    ]);
    return {
      externalUserId,
      deviceCount,
      objecting: !!objection,
      createdAt: objection?.createdAt ?? null,
      createdBy: objection?.createdBy ?? null,
      sourceIdentityId: objection?.sourceIdentityId ?? null,
    };
  }
}
