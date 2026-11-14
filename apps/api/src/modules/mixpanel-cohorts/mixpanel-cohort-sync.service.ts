import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity, ResolvedBy } from './entities/mixpanel-cohort-member.entity';
import { MixpanelApiService, MixpanelProfile } from './mixpanel-api.service';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { normaliseEmail } from '../push-notifications/message-channel';
import {
  COHORT_MEMBER_CAP,
  COHORT_RESOLVE_BATCH,
  COHORT_SYNC_DEADLINE_MS,
  CohortSyncLimitError,
  MIXPANEL_DISTINCT_ID_MAX,
  cohortSyncTooSlow,
} from './cohort-sync-limits';

/** A sync still `syncing` after this long is taken as stranded (as the hourly scheduler does). */
const SYNC_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

type MixpanelCredentials = { username: string; password: string; mixpanelProjectId: string };

/** How a queued sync ended, so the queue retries only what could go differently next time. */
export type CohortSyncOutcome =
  | { kind: 'synced' }
  /** Another sync of the cohort holds it; nothing was done. */
  | { kind: 'busy' }
  | { kind: 'failed'; message: string; retryable: boolean };

@Injectable()
export class MixpanelCohortSyncService {
  private readonly logger = new Logger(MixpanelCohortSyncService.name);

  constructor(
    @InjectRepository(MixpanelCohortEntity)
    private readonly cohortRepo: Repository<MixpanelCohortEntity>,
    @InjectRepository(MixpanelCohortMemberEntity)
    private readonly memberRepo: Repository<MixpanelCohortMemberEntity>,
    @InjectRepository(DeviceIdentityEntity)
    private readonly identityRepo: Repository<DeviceIdentityEntity>,
    private readonly mixpanelApiService: MixpanelApiService,
    private readonly mixpanelCohortsService: MixpanelCohortsService,
  ) {}

  /**
   * Imports a cohort, or syncs one already imported, and returns it at once: the sync
   * runs after the response (the dashboard polls the cohort's status).
   */
  async importCohort(projectId: string, mixpanelCohortId: number): Promise<MixpanelCohortEntity> {
    const { cohort, creds } = await this.claim(projectId, mixpanelCohortId);
    if (creds) {
      void this.runSync(cohort, creds, projectId);
    }
    return cohort;
  }

  /** For the queue: syncs the cohort and waits, saying how it ended. */
  async syncForJob(projectId: string, mixpanelCohortId: number): Promise<CohortSyncOutcome> {
    const { cohort, creds } = await this.claim(projectId, mixpanelCohortId);
    if (!creds) return { kind: 'busy' };
    return this.runSync(cohort, creds, projectId);
  }

  /**
   * Marks the cohort `syncing`, creating it on first import. `creds` is null when another
   * sync already holds it (and has not been left stranded).
   */
  private async claim(
    projectId: string,
    mixpanelCohortId: number,
  ): Promise<{ cohort: MixpanelCohortEntity; creds: MixpanelCredentials | null }> {
    const creds = await this.mixpanelCohortsService.getDecryptedConfig(projectId);
    if (!creds) {
      throw new BadRequestException('Mixpanel is not configured for this project');
    }

    const availableCohorts = await this.mixpanelApiService.listCohorts(creds);
    const cohortInfo = availableCohorts.find((c) => c.id === mixpanelCohortId);
    if (!cohortInfo) {
      throw new NotFoundException(`Cohort ${mixpanelCohortId} not found in Mixpanel`);
    }

    let cohort = await this.cohortRepo.findOne({
      where: { projectId, mixpanelCohortId },
    });

    if (cohort) {
      // Claimed with one conditional UPDATE: a cohort already syncing (and not left
      // stranded) is not synced again. Each sync is a full Mixpanel import held in this
      // process's memory, so otherwise every request started another one.
      const claimed = await this.cohortRepo
        .createQueryBuilder()
        .update(MixpanelCohortEntity)
        .set({
          name: cohortInfo.name,
          description: cohortInfo.description ?? null,
          mixpanelUserCount: cohortInfo.count,
          status: 'syncing',
          errorMessage: null,
        })
        .where('id = :id', { id: cohort.id })
        .andWhere(`(status <> 'syncing' OR "updatedAt" < :staleBefore)`, {
          staleBefore: new Date(Date.now() - SYNC_STALE_AFTER_MS),
        })
        .execute();
      if (!claimed.affected) return { cohort, creds: null };
      cohort = (await this.cohortRepo.findOne({ where: { id: cohort.id } })) ?? cohort;
    } else {
      cohort = this.cohortRepo.create({
        projectId,
        mixpanelCohortId,
        name: cohortInfo.name,
        description: cohortInfo.description ?? null,
        mixpanelUserCount: cohortInfo.count,
        status: 'syncing',
        errorMessage: null,
        resolvedCount: 0,
        unresolvedCount: 0,
      });
      cohort = await this.cohortRepo.save(cohort);
    }
    return { cohort, creds };
  }

  /**
   * Fetches the members and writes them, within the bounds in `cohort-sync-limits.ts`:
   * every tenant's syncs share one worker lane. Never throws; the outcome is also
   * written to the cohort row.
   */
  private async runSync(
    cohort: MixpanelCohortEntity,
    creds: MixpanelCredentials,
    projectId: string,
  ): Promise<CohortSyncOutcome> {
    const deadline = Date.now() + COHORT_SYNC_DEADLINE_MS;
    try {
      const rawProfiles = await this.mixpanelApiService.getCohortMembers(creds, cohort.mixpanelCohortId, {
        maxMembers: COHORT_MEMBER_CAP,
        deadline,
      });

      // One per distinct id (Mixpanel can repeat a profile), and none the column cannot hold.
      const profilesByDistinctId = new Map<string, MixpanelProfile>();
      for (const profile of rawProfiles) {
        const id = profile.$distinct_id;
        if (typeof id !== 'string' || !id || id.length > MIXPANEL_DISTINCT_ID_MAX) continue;
        profilesByDistinctId.set(id, profile);
      }
      const profiles = Array.from(profilesByDistinctId.values());

      this.logger.log(`Syncing ${profiles.length} members for cohort ${cohort.id}`);

      await this.memberRepo.query(
        `DELETE FROM mixpanel_cohort_members WHERE "cohortId" = $1 AND NOT ("mixpanelDistinctId" = ANY($2::text[]))`,
        [cohort.id, Array.from(profilesByDistinctId.keys())],
      );

      let resolvedCount = 0;
      for (let start = 0; start < profiles.length; start += COHORT_RESOLVE_BATCH) {
        if (Date.now() > deadline) throw cohortSyncTooSlow();
        resolvedCount += await this.writeBatch(projectId, cohort.id, profiles.slice(start, start + COHORT_RESOLVE_BATCH));
      }

      // update(), never save(): the cohort may have been deleted while this ran, and
      // save() of the entity loaded before would insert it again.
      await this.cohortRepo.update(
        { id: cohort.id },
        {
          mixpanelUserCount: profiles.length,
          resolvedCount,
          unresolvedCount: profiles.length - resolvedCount,
          status: 'synced',
          lastSyncedAt: new Date(),
          errorMessage: null,
        },
      );

      this.logger.log(
        `Cohort ${cohort.id} synced: ${resolvedCount} resolved, ${profiles.length - resolvedCount} unresolved`,
      );
      return { kind: 'synced' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = !(err instanceof CohortSyncLimitError);
      this.logger.error(
        `Sync error for cohort ${cohort.id}: ${message}`,
        retryable && err instanceof Error ? err.stack : undefined,
      );
      // update(), never save(): a sync that failed because the cohort was deleted
      // under it must not bring the cohort back.
      try {
        await this.cohortRepo.update(
          { id: cohort.id },
          { status: 'error', errorMessage: message || 'Unknown error during sync' },
        );
      } catch (updateErr: unknown) {
        this.logger.error(`Could not record the sync error for cohort ${cohort.id}: ${String(updateErr)}`);
      }
      return { kind: 'failed', message, retryable };
    }
  }

  /**
   * Resolves one batch of members to device rows and upserts them; returns how many
   * resolved. A member resolves only through something proved about the row:
   *
   * 1. Its external user id, which identify accepts only with the tenant server's
   *    `userHash`. Of several devices of that person, the most recently seen.
   * 2. Its Mixpanel `$email`, matched to a row holding that address only when exactly
   *    one row in the project holds it and that row's address was confirmed from the
   *    link mailed to it. A confirmation covers every row holding the address when the
   *    link is clicked, so a second row could be someone who wrote the address first;
   *    with two, nothing says which is the person.
   *
   * Never through a distinct id or an unconfirmed address: the app's key is public, so
   * anyone can report any value for either, and a row naming a stranger's id or address
   * would take their place in the cohort and receive its pushes and in-app messages.
   */
  private async writeBatch(projectId: string, cohortId: string, profiles: MixpanelProfile[]): Promise<number> {
    const ids = profiles.map((profile) => profile.$distinct_id);
    const byExternalId = new Map<string, string>(
      (
        (await this.identityRepo.query(
          `SELECT DISTINCT ON (external_user_id) external_user_id AS key, id
             FROM device_identities
            WHERE project_id = $1 AND external_user_id = ANY($2::text[])
            ORDER BY external_user_id, last_seen_at DESC, id`,
          [projectId, ids],
        )) as Array<{ key: string; id: string }>
      ).map((row) => [row.key, row.id]),
    );

    const emailOf = new Map<string, string>();
    for (const profile of profiles) {
      if (byExternalId.has(profile.$distinct_id)) continue;
      const email = normaliseEmail(profile.$properties?.$email);
      if (email) emailOf.set(profile.$distinct_id, email);
    }
    const byConfirmedEmail = new Map<string, string>();
    if (emailOf.size > 0) {
      const rows = (await this.identityRepo.query(
        `SELECT email AS key, (array_agg(id))[1] AS id
           FROM device_identities
          WHERE project_id = $1 AND email = ANY($2::text[])
          GROUP BY email
         HAVING count(*) = 1 AND bool_and(email_confirmed_at IS NOT NULL)`,
        [projectId, Array.from(new Set(emailOf.values()))],
      )) as Array<{ key: string; id: string }>;
      for (const row of rows) byConfirmedEmail.set(row.key, row.id);
    }

    let resolved = 0;
    const members = profiles.map((profile) => {
      const distinctId = profile.$distinct_id;
      let device: string | null = byExternalId.get(distinctId) ?? null;
      let by: ResolvedBy = device ? 'external_user_id' : null;
      if (!device) {
        const email = emailOf.get(distinctId);
        device = (email && byConfirmedEmail.get(email)) || null;
        by = device ? 'email' : null;
      }
      if (device) resolved++;
      return { d: distinctId, dev: device, by, profile: profile.$properties ?? {} };
    });

    await this.memberRepo.query(
      `INSERT INTO mixpanel_cohort_members
              ("cohortId", "projectId", "mixpanelDistinctId", "deviceIdentityId", "resolvedBy", "isResolved", "mixpanelProfile")
       SELECT $1::uuid, $2::uuid, m.d, m.dev, m.by, m.dev IS NOT NULL, m.profile
         FROM jsonb_to_recordset($3::jsonb) AS m(d text, dev uuid, by text, profile jsonb)
       ON CONFLICT ("cohortId", "mixpanelDistinctId") DO UPDATE
          SET "deviceIdentityId" = EXCLUDED."deviceIdentityId",
              "resolvedBy" = EXCLUDED."resolvedBy",
              "isResolved" = EXCLUDED."isResolved",
              "mixpanelProfile" = EXCLUDED."mixpanelProfile"`,
      [cohortId, projectId, JSON.stringify(members)],
    );
    return resolved;
  }
}
