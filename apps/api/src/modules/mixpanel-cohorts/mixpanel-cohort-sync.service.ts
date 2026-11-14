import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity, ResolvedBy } from './entities/mixpanel-cohort-member.entity';
import { MixpanelApiService, MixpanelProfile } from './mixpanel-api.service';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';

/** A sync still `syncing` after this long is taken as stranded (as the hourly scheduler does). */
const SYNC_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

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

  async importCohort(
    projectId: string,
    mixpanelCohortId: number,
    opts?: { awaitSync?: boolean },
  ): Promise<MixpanelCohortEntity> {
    // 1. Get decrypted config
    const creds = await this.mixpanelCohortsService.getDecryptedConfig(projectId);
    if (!creds) {
      throw new Error('Mixpanel is not configured for this project');
    }

    // 2. List cohorts from Mixpanel and find the matching one
    const availableCohorts = await this.mixpanelApiService.listCohorts(creds);
    const cohortInfo = availableCohorts.find((c) => c.id === mixpanelCohortId);
    if (!cohortInfo) {
      throw new Error(`Cohort ${mixpanelCohortId} not found in Mixpanel`);
    }

    // 3. Upsert the cohort entity with status='syncing'
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
      if (!claimed.affected) return cohort;
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

    if (opts?.awaitSync) {
      // Scheduled/queued callers (e.g. CohortSyncProcessor) need the sync to
      // actually finish before the job is considered done, so the queue's
      // retry/backoff can engage on real failures.
      await this.runSync(cohort, creds, projectId);
      // runSync writes its outcome with update(), so read it back.
      return (await this.cohortRepo.findOne({ where: { id: cohort.id } })) ?? cohort;
    } else {
      // Run the sync asynchronously so the controller can return immediately.
      this.runSync(cohort, creds, projectId).catch((err) => {
        this.logger.error(
          `Background sync failed for cohort ${cohort.id}: ${err.message}`,
          err.stack,
        );
      });
    }

    return cohort;
  }

  private async runSync(
    cohort: MixpanelCohortEntity,
    creds: { username: string; password: string; mixpanelProjectId: string },
    projectId: string,
  ): Promise<void> {
    try {
      // 4. Fetch all members from Mixpanel
      const rawProfiles = await this.mixpanelApiService.getCohortMembers(
        creds,
        cohort.mixpanelCohortId,
      );

      // Deduplicate by distinct_id to avoid inflated counts when upstream returns duplicates.
      const profilesByDistinctId = new Map<string, MixpanelProfile>();
      for (const profile of rawProfiles) {
        if (!profile.$distinct_id) {
          continue;
        }
        profilesByDistinctId.set(profile.$distinct_id, profile);
      }
      const profiles = Array.from(profilesByDistinctId.values());

      this.logger.log(
        `Syncing ${profiles.length} members for cohort ${cohort.id} (${cohort.name})`,
      );

      // Remove members that no longer exist in Mixpanel cohort.
      const existingMembers =
        (await this.memberRepo.find({
          where: { cohortId: cohort.id },
          select: ['id', 'mixpanelDistinctId'],
        })) ?? [];
      const staleMembers = existingMembers.filter(
        (member) => !profilesByDistinctId.has(member.mixpanelDistinctId),
      );
      if (staleMembers.length > 0) {
        await this.memberRepo.remove(staleMembers);
      }

      // 5. Resolve and upsert each member
      let resolvedCount = 0;
      let unresolvedCount = 0;

      for (const profile of profiles) {
        const member = await this.resolveMember(projectId, cohort.id, profile);
        if (member.isResolved) {
          resolvedCount++;
        } else {
          unresolvedCount++;
        }
      }

      // 6. Update cohort with final status
      // update(), never save(): the cohort may have been deleted while this ran, and
      // save() of the entity loaded before would insert it again.
      await this.cohortRepo.update(
        { id: cohort.id },
        {
          mixpanelUserCount: profiles.length,
          resolvedCount,
          unresolvedCount,
          status: 'synced',
          lastSyncedAt: new Date(),
          errorMessage: null,
        },
      );

      this.logger.log(
        `Cohort ${cohort.id} synced: ${resolvedCount} resolved, ${unresolvedCount} unresolved`,
      );
    } catch (err: unknown) {
      // 7. On error: set status='error', errorMessage
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Sync error for cohort ${cohort.id}: ${errMsg}`, errStack);
      // update(), never save(): a sync that failed because the cohort was deleted
      // under it must not bring the cohort back.
      await this.cohortRepo.update(
        { id: cohort.id },
        { status: 'error', errorMessage: errMsg ?? 'Unknown error during sync' },
      );
    }
  }

  /**
   * The one device row whose `email` trait is this address, or null when none or
   * several are. The trait is whatever the app (or anyone holding its public SDK key)
   * wrote, so with several rows nothing says which is the person's: picking one would
   * let a row that names a stranger's address take their place in the cohort and
   * receive its pushes and in-app messages.
   */
  private async onlyRowWithEmailTrait(projectId: string, email: string): Promise<DeviceIdentityEntity | null> {
    const rows = await this.identityRepo
      .createQueryBuilder('di')
      .where('di.projectId = :projectId', { projectId })
      .andWhere("di.traits->>'email' = :email", { email })
      .orderBy('di.id')
      .take(2)
      .getMany();
    return rows.length === 1 ? rows[0] : null;
  }

  private async resolveMember(
    projectId: string,
    cohortId: string,
    profile: MixpanelProfile,
  ): Promise<MixpanelCohortMemberEntity> {
    const distinctId = profile.$distinct_id;
    let identity: DeviceIdentityEntity | null = null;
    let resolvedBy: ResolvedBy = null;

    // Resolution order 1: externalUserId match
    identity = await this.identityRepo.findOne({
      where: { projectId, externalUserId: distinctId },
    });
    if (identity) {
      resolvedBy = 'external_user_id';
    }

    // Resolution order 2: distinctId match
    if (!identity) {
      identity = await this.identityRepo.findOne({
        where: { projectId, distinctId },
      });
      if (identity) {
        resolvedBy = 'distinct_id';
      }
    }

    // Resolution order 3: email match from Mixpanel profile properties
    if (!identity && profile.$properties.$email) {
      identity = await this.onlyRowWithEmailTrait(projectId, profile.$properties.$email);
      if (identity) {
        resolvedBy = 'email';
      }
    }

    // Upsert the member record
    let member = await this.memberRepo.findOne({
      where: { cohortId, mixpanelDistinctId: distinctId },
    });

    const memberData: Partial<MixpanelCohortMemberEntity> = {
      cohortId,
      projectId,
      mixpanelDistinctId: distinctId,
      isResolved: identity !== null,
      deviceIdentityId: identity?.id ?? null,
      resolvedBy,
      mixpanelProfile: profile.$properties,
    };

    if (member) {
      Object.assign(member, memberData);
      member = await this.memberRepo.save(member);
    } else {
      member = this.memberRepo.create(memberData as MixpanelCohortMemberEntity);
      member = await this.memberRepo.save(member);
    }

    return member;
  }

  async retryUnresolved(cohortId: string): Promise<{ attempted: number; resolved: number }> {
    const unresolvedMembers = await this.memberRepo.find({
      where: { cohortId, isResolved: false },
    });

    this.logger.log(
      `Retrying resolution for ${unresolvedMembers.length} unresolved members in cohort ${cohortId}`,
    );

    let resolvedCount = 0;

    for (const member of unresolvedMembers) {
      const profile: MixpanelProfile = {
        $distinct_id: member.mixpanelDistinctId,
        $properties: member.mixpanelProfile ?? {},
      };

      const updated = await this.resolveMember(member.projectId, cohortId, profile);
      if (updated.isResolved) {
        resolvedCount++;
      }
    }

    // Update cohort counts
    const [resolved, unresolved] = await Promise.all([
      this.memberRepo.count({ where: { cohortId, isResolved: true } }),
      this.memberRepo.count({ where: { cohortId, isResolved: false } }),
    ]);
    // Changes nothing if the cohort was deleted meanwhile (see runSync).
    await this.cohortRepo.update({ id: cohortId }, { resolvedCount: resolved, unresolvedCount: unresolved });

    return { attempted: unresolvedMembers.length, resolved: resolvedCount };
  }
}
