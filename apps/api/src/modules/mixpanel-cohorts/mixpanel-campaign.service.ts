import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import { PushNotificationsService } from '../push-notifications/push-notifications.service';
import { PushCohortDto } from './dto/push-cohort.dto';
import { MessageDeliveryService } from '../in-app-messages/message-delivery.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { PushConfigEntity } from '../push-notifications/entities/push-config.entity';
import { InAppMessagesService } from '../in-app-messages/in-app-messages.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

const BATCH_SIZE = 500;

/**
 * A cohort send is logged once, as `cohort.push_sent` or `cohort.in_app_triggered`, so
 * the campaigns or triggers it makes underneath write no entry of their own.
 */
const COHORT_BATCH = null;

/**
 * What a cohort push request can truthfully report at the moment it returns.
 *
 * Delivery counts are deliberately absent: the campaigns are handed to the
 * worker, so nothing about their outcome is known yet. Progress and results
 * live on the push notification log rows named here.
 */
export interface CohortPushQueueResult {
  /** Ids of the campaign rows created, in enqueue order. */
  campaignIds: string[];
  /** Distinct devices the campaigns target. */
  devicesTargeted: number;
  /** Active tokens those devices hold, as counted at enqueue time. */
  tokensTargeted: number;
}

@Injectable()
export class MixpanelCampaignService {
  private readonly logger = new Logger(MixpanelCampaignService.name);

  constructor(
    @InjectRepository(MixpanelCohortMemberEntity)
    private readonly memberRepo: Repository<MixpanelCohortMemberEntity>,
    @InjectRepository(PushTokenEntity)
    private readonly pushTokenRepo: Repository<PushTokenEntity>,
    @InjectRepository(DeviceIdentityEntity)
    private readonly identityRepo: Repository<DeviceIdentityEntity>,
    @InjectRepository(MixpanelCohortEntity)
    private readonly cohortRepo: Repository<MixpanelCohortEntity>,
    @InjectRepository(PushConfigEntity)
    private readonly pushConfigRepo: Repository<PushConfigEntity>,
    private readonly pushNotificationsService: PushNotificationsService,
    private readonly messageDeliveryService: MessageDeliveryService,
    private readonly messagesService: InAppMessagesService,
    private readonly trackingConsent: TrackingConsentService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * One entry for the whole request, naming the cohort as it is now. Written after every
   * check that can refuse the request and before the first campaign or pending message
   * is made: a refused request writes nothing, and a failed log write sends nothing.
   */
  private async recordCohortSend(
    action: 'cohort.push_sent' | 'cohort.in_app_triggered',
    projectId: string,
    cohortId: string,
    requester: ActivityRequester,
  ): Promise<void> {
    const cohort = await this.cohortRepo.findOne({
      where: { id: cohortId, projectId },
      select: { id: true, name: true },
    });
    await recordBy(this.activity, requester, {
      projectId,
      action,
      target: { type: 'cohort', id: cohortId, label: cohort?.name ?? null },
    });
  }

  /**
   * The cohort's resolved members a send may target: not do-not-track (a
   * cohort is an audience built from behaviour), and for push not opted out
   * of push either, so the counts reported here match what the send path,
   * which applies the same opt-out to every token, will actually reach.
   */
  private async targetableMembers(
    projectId: string,
    cohortId: string,
    channel: 'push' | 'in_app',
  ): Promise<string[]> {
    const resolvedMembers = await this.memberRepo.find({
      where: { cohortId, projectId, isResolved: true },
      select: ['deviceIdentityId'],
    });
    const ids = resolvedMembers
      .map((m) => m.deviceIdentityId)
      .filter((id): id is string => id !== null);

    const trackable = await this.trackingConsent.withoutDoNotTrack(projectId, ids);
    if (channel !== 'push' || trackable.length === 0) return trackable;

    const optedOut = await this.identityRepo.find({
      where: { projectId, id: In(trackable), pushOptIn: false },
      select: ['id'],
    });
    const excluded = new Set(optedOut.map((identity) => identity.id));
    return trackable.filter((id) => !excluded.has(id));
  }

  async getPushStats(
    projectId: string,
    cohortId: string,
  ): Promise<{
    total: number;
    resolved: number;
    pushEnabled: number;
    unresolved: number;
  }> {
    const [total, resolved, unresolved] = await Promise.all([
      this.memberRepo.count({ where: { cohortId, projectId } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: true } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: false } }),
    ]);

    // The same members sendPushToCohort would reach, so the figure shown
    // before sending is the one the send acts on.
    const deviceIdentityIds = await this.targetableMembers(projectId, cohortId, 'push');

    let pushEnabled = 0;
    if (deviceIdentityIds.length > 0) {
      pushEnabled = await this.pushTokenRepo
        .createQueryBuilder('pt')
        .select('COUNT(DISTINCT pt.deviceIdentityId)', 'count')
        .where('pt.projectId = :projectId', { projectId })
        .andWhere('pt.deviceIdentityId IN (:...ids)', { ids: deviceIdentityIds })
        .andWhere('pt.isActive = true')
        .getRawOne()
        .then((row) => parseInt(row?.count ?? '0', 10));
    }

    return { total, resolved, pushEnabled, unresolved };
  }

  async sendPushToCohort(
    projectId: string,
    cohortId: string,
    dto: PushCohortDto,
    requester: ActivityRequester,
  ): Promise<CohortPushQueueResult> {
    // 1-2. Resolved members this send may target
    const deviceIdentityIds = await this.targetableMembers(projectId, cohortId, 'push');

    if (deviceIdentityIds.length === 0) {
      throw new BadRequestException('No eligible push tokens found for this cohort');
    }

    // 3. Get active push tokens filtered by platform
    const platforms = dto.platforms ?? ['android', 'ios'];
    const pushTokens = await this.pushTokenRepo.find({
      where: {
        projectId,
        deviceIdentityId: In(deviceIdentityIds),
        isActive: true,
        platform: In(platforms),
      },
      select: ['token', 'deviceIdentityId'],
    });

    // 4. Check that we have at least one token
    if (pushTokens.length === 0) {
      throw new BadRequestException('No eligible push tokens found for this cohort');
    }

    // Collect unique device identity IDs that have at least one eligible token
    const eligibleIdentityIds = [...new Set(pushTokens.map((t) => t.deviceIdentityId))];

    this.logger.log(
      `Queueing push for cohort ${cohortId}: ${eligibleIdentityIds.length} devices, ` +
        `${pushTokens.length} tokens, ${Math.ceil(eligibleIdentityIds.length / BATCH_SIZE)} batch(es)`,
    );

    // 5. Build data payload
    const data: Record<string, string> = {
      ...(dto.data ?? {}),
      ...(dto.deepLinkUrl ? { deep_link_url: dto.deepLinkUrl } : {}),
    };

    // 6. Batch device identity IDs into groups of 500 (FCM limit)
    const batches: string[][] = [];
    for (let i = 0; i < eligibleIdentityIds.length; i += BATCH_SIZE) {
      batches.push(eligibleIdentityIds.slice(i, i + BATCH_SIZE));
    }

    // 7. Everything `send` would refuse, checked for every batch before anything is
    // made or logged: push switched on, and someone in the batch it can reach (not
    // opted out, not at the frequency cap), counted by the same code `send` uses. A
    // batch nobody in which can be reached is left out rather than failing the
    // request half-sent; a cohort nobody in which can be reached is refused.
    const config = await this.pushConfigRepo.findOne({ where: { projectId, isActive: true } });
    if (!config) {
      throw new NotFoundException(
        'Push notifications not configured for this project. Call configure first.',
      );
    }
    const reachable: string[][] = [];
    for (const batch of batches) {
      if ((await this.pushNotificationsService.countReachableDevices(projectId, batch)) > 0) {
        reachable.push(batch);
      }
    }
    if (reachable.length === 0) {
      throw new BadRequestException(
        'No reachable push tokens for the target users (none registered, opted out of push, or at the frequency cap)',
      );
    }

    await this.recordCohortSend('cohort.push_sent', projectId, cohortId, requester);

    // 8. Enqueue one campaign per batch and collect their ids
    const campaignIds: string[] = [];

    for (const batch of reachable) {
      const log = await this.pushNotificationsService.send({
        projectId,
        title: dto.title,
        body: dto.body,
        data: Object.keys(data).length > 0 ? data : undefined,
        deviceIdentityIds: batch,
      }, COHORT_BATCH);

      campaignIds.push(log.id);
    }

    // Nothing here can report delivery: send() now returns a freshly queued
    // row whose successCount/failureCount are always 0, and the worker fills
    // them in afterwards. Summing them said "0 success, 0 failure" the instant
    // the enqueue returned, which read as a completed campaign that reached
    // nobody. Report what is actually known — what was queued, and for whom.
    this.logger.log(
      `Queued ${campaignIds.length} push campaign(s) for cohort ${cohortId}: ` +
        `${eligibleIdentityIds.length} device(s), ${pushTokens.length} token(s)`,
    );

    // 9. Return the queued campaigns and their reach (only the batches sent)
    const targeted = new Set(reachable.flat());
    return {
      campaignIds,
      devicesTargeted: targeted.size,
      tokensTargeted: pushTokens.filter((t) => targeted.has(t.deviceIdentityId)).length,
    };
  }

  // ── In-App Message Integration ──

  /**
   * Get IAM eligibility stats for a cohort — how many resolved members
   * can receive in-app messages.
   */
  async getIamStats(
    projectId: string,
    cohortId: string,
  ): Promise<{
    total: number;
    resolved: number;
    iamEligible: number;
    unresolved: number;
  }> {
    const [total, resolved, unresolved] = await Promise.all([
      this.memberRepo.count({ where: { cohortId, projectId } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: true } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: false } }),
    ]);

    // For IAM, any targetable member (as sendIamToCohort applies it) with a
    // known device fingerprint is eligible
    const deviceIdentityIds = await this.targetableMembers(projectId, cohortId, 'in_app');

    let iamEligible = 0;
    if (deviceIdentityIds.length > 0) {
      // Count identities that have a device fingerprint (needed for IAM delivery)
      iamEligible = await this.identityRepo
        .createQueryBuilder('di')
        .where('di.id IN (:...ids)', { ids: deviceIdentityIds })
        .andWhere('di.deviceFingerprint IS NOT NULL')
        .getCount();
    }

    return { total, resolved, iamEligible, unresolved };
  }

  /**
   * Queue in-app messages for all resolved cohort members.
   * Resolves cohort members → device fingerprints → calls MessageDeliveryService.triggerMessage
   */
  async sendIamToCohort(
    projectId: string,
    cohortId: string,
    messageId: string,
    requester: ActivityRequester,
  ): Promise<{ queued: number; eligible: number }> {
    // 1. Resolved members this send may target
    const deviceIdentityIds = await this.targetableMembers(projectId, cohortId, 'in_app');

    if (deviceIdentityIds.length === 0) {
      this.logger.warn(`No resolved members in cohort ${cohortId} for IAM trigger`);
      return { queued: 0, eligible: 0 };
    }

    // 2. Resolve device identity IDs to device fingerprints
    const identities = await this.identityRepo
      .createQueryBuilder('di')
      .select(['di.id', 'di.deviceFingerprint'])
      .where('di.id IN (:...ids)', { ids: deviceIdentityIds })
      .andWhere('di.deviceFingerprint IS NOT NULL')
      .getMany();

    const deviceFingerprints = identities
      .map((i) => i.deviceFingerprint)
      .filter((fp): fp is string => fp !== null && fp !== undefined);

    if (deviceFingerprints.length === 0) {
      this.logger.warn(`No device fingerprints found for cohort ${cohortId}`);
      return { queued: 0, eligible: 0 };
    }

    this.logger.log(
      `Triggering IAM ${messageId} for cohort ${cohortId}: ` +
        `${deviceFingerprints.length} eligible devices out of ${deviceIdentityIds.length} targetable members`,
    );

    // The message must be this project's (404 otherwise) before anything is logged;
    // `triggerMessage` checks it again, and refuses nothing else for a cohort.
    await this.messagesService.findOne(messageId, projectId);

    await this.recordCohortSend('cohort.in_app_triggered', projectId, cohortId, requester);

    // 3. Use the existing MessageDeliveryService trigger mechanism
    const result = await this.messageDeliveryService.triggerMessage(
      projectId,
      { messageId, targetType: 'cohort', deviceFingerprints },
      COHORT_BATCH,
    );

    return { queued: result.queued, eligible: deviceFingerprints.length };
  }
}
