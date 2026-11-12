import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity, ResolvedBy } from './entities/mixpanel-cohort-member.entity';
import { MixpanelApiService, MixpanelProfile } from './mixpanel-api.service';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';

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
      cohort.name = cohortInfo.name;
      cohort.description = cohortInfo.description ?? null;
      cohort.mixpanelUserCount = cohortInfo.count;
      cohort.status = 'syncing';
      cohort.errorMessage = null;
      cohort = await this.cohortRepo.save(cohort);
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
      cohort.mixpanelUserCount = profiles.length;
      cohort.resolvedCount = resolvedCount;
      cohort.unresolvedCount = unresolvedCount;
      cohort.status = 'synced';
      cohort.lastSyncedAt = new Date();
      cohort.errorMessage = null;
      await this.cohortRepo.save(cohort);

      this.logger.log(
        `Cohort ${cohort.id} synced: ${resolvedCount} resolved, ${unresolvedCount} unresolved`,
      );
    } catch (err: unknown) {
      // 7. On error: set status='error', errorMessage
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Sync error for cohort ${cohort.id}: ${errMsg}`, errStack);
      cohort.status = 'error';
      cohort.errorMessage = errMsg ?? 'Unknown error during sync';
      await this.cohortRepo.save(cohort);
    }
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
      identity = await this.identityRepo
        .createQueryBuilder('di')
        .where('di.projectId = :projectId', { projectId })
        .andWhere("di.traits->>'email' = :email", { email: profile.$properties.$email })
        .getOne();
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
    const cohort = await this.cohortRepo.findOne({ where: { id: cohortId } });
    if (cohort) {
      const [resolved, unresolved] = await Promise.all([
        this.memberRepo.count({ where: { cohortId, isResolved: true } }),
        this.memberRepo.count({ where: { cohortId, isResolved: false } }),
      ]);
      cohort.resolvedCount = resolved;
      cohort.unresolvedCount = unresolved;
      await this.cohortRepo.save(cohort);
    }

    return { attempted: unresolvedMembers.length, resolved: resolvedCount };
  }
}
