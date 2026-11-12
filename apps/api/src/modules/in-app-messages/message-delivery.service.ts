import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual, MoreThanOrEqual, IsNull, Or } from 'typeorm';
import { InAppMessageEntity, UserFilters } from './entities/in-app-message.entity';
import { InAppMessageImpressionEntity } from './entities/in-app-message-impression.entity';
import { PendingMessageEntity } from './entities/pending-message.entity';
import { MessageActionDto } from './dto/message-action.dto';
import { ServeMessageRequestDto } from './dto/serve-message-request.dto';
import { TriggerMessageDto } from './dto/trigger-message.dto';
import { InAppMessagesService } from './in-app-messages.service';
import { IdentityService } from '../identity/identity.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { MixpanelCohortMemberEntity } from '../mixpanel-cohorts/entities/mixpanel-cohort-member.entity';
import { SegmentsService } from '../segments/segments.service';
import { SegmentEvaluationService } from '../segments/segment-evaluation.service';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

/**
 * The event types `applyFrequencyCapping` counts. For a do-not-track person
 * these are the only rows kept, and only with what the cap reads: without
 * them a message capped at one showing would be shown again on every launch.
 */
const CAPPING_EVENT_TYPES = ['impression', 'delivered'];

/**
 * The subset of message fields the audience filter actually reads. `filterByUsers`
 * is generic over this so it keeps returning the caller's concrete type (the real
 * checkMessages path threads full InAppMessageEntity rows through untouched) while
 * still being directly unit-testable against lean fixtures.
 */
export interface FilterableMessage {
  id: string;
  projectId: string;
  userType: string;
  mixpanelCohortId?: string | null;
  segmentId?: string | null;
  userFilters?: UserFilters | null;
}

export interface DeliveredMessage {
  id: string;
  messageType: string;
  title: string;
  body: string | null;
  imageUrl: string | null;
  imagePosition: string;
  buttons: any[] | null;
  theme: any | null;
  dismissOnTapOutside: boolean;
  autoDismissSeconds: number | null;
  triggerDelay: number;
}

@Injectable()
export class MessageDeliveryService {
  private readonly logger = new Logger(MessageDeliveryService.name);

  constructor(
    @InjectRepository(InAppMessageEntity)
    private readonly messageRepo: Repository<InAppMessageEntity>,
    @InjectRepository(InAppMessageImpressionEntity)
    private readonly impressionRepo: Repository<InAppMessageImpressionEntity>,
    @InjectRepository(PendingMessageEntity)
    private readonly pendingRepo: Repository<PendingMessageEntity>,
    @InjectRepository(MixpanelCohortMemberEntity)
    private readonly cohortMemberRepo: Repository<MixpanelCohortMemberEntity>,
    private readonly messagesService: InAppMessagesService,
    private readonly identityService: IdentityService,
    private readonly segmentsService: SegmentsService,
    private readonly segmentEvaluation: SegmentEvaluationService,
    private readonly suspension: ProjectSuspensionService,
    private readonly trackingConsent: TrackingConsentService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * Core delivery engine — evaluates which messages should be shown to this user.
   * Called by the SDK via POST /api/messages/check
   */
  async checkMessages(dto: ServeMessageRequestDto): Promise<{ messages: DeliveredMessage[] }> {
    const now = new Date();
    const { projectId, deviceFingerprint, distinctId, context } = dto;

    // The ordinary "nothing to show", never an error: the SDKs treat a 4xx as
    // terminal. Returned before the pending queue is read, so triggered messages
    // are neither delivered nor expired here; they keep their own expiry.
    if (await this.suspension.isSuspended(projectId)) {
      return { messages: [] };
    }

    // 1. Check for pending triggered messages first
    const pendingMessages = await this.getPendingMessages(projectId, deviceFingerprint);

    // 2. Get all active campaign messages for this project
    const activeCampaigns = await this.getActiveCampaigns(projectId, now);

    // 3. Filter by trigger matching
    const triggerMatched = this.filterByTrigger(activeCampaigns, context);

    // Segment membership needs the resolved identity (externalUserId / deviceIdentityId).
    // Resolved only when a segment-targeted message is actually in play — most requests
    // never touch a segment, and the cohort branch below resolves its own identity.
    let externalUserId: string | null = null;
    let deviceIdentityId: string | null = null;
    if (triggerMatched.some((msg) => msg.userType === 'segment')) {
      const identity = await this.identityService.findByFingerprintAndProject(
        deviceFingerprint,
        projectId,
      );
      externalUserId = identity?.externalUserId ?? null;
      deviceIdentityId = identity?.id ?? null;
    }

    // 4. Filter by users
    const userMatched = await this.filterByUsers(triggerMatched, {
      deviceFingerprint,
      distinctId,
      platform: context.platform,
      country: context.country,
      appVersion: context.appVersion,
      externalUserId,
      deviceIdentityId,
    });

    // 5. Apply frequency capping
    const cappingApplied = await this.applyFrequencyCapping(
      userMatched,
      deviceFingerprint,
    );

    // 6. Combine pending + campaign messages, sort by priority
    const allEligible = [...pendingMessages, ...cappingApplied];
    allEligible.sort((a, b) => b.priority - a.priority);

    // 7. Take top 3 messages max (don't overwhelm the user)
    const toDeliver = allEligible.slice(0, 3);

    // 8. Map to delivery format
    const messages: DeliveredMessage[] = toDeliver.map((msg) => ({
      id: msg.id,
      messageType: msg.messageType,
      title: msg.title,
      body: msg.body,
      imageUrl: msg.imageUrl,
      imagePosition: msg.imagePosition,
      buttons: msg.buttons,
      theme: msg.theme,
      dismissOnTapOutside: msg.dismissOnTapOutside,
      autoDismissSeconds: msg.autoDismissSeconds,
      triggerDelay: msg.triggerDelaySeconds,
    }));

    return { messages };
  }

  /**
   * Record a message event (impression, click, dismiss, etc.)
   */
  async recordEvent(
    dto: MessageActionDto,
    context?: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    // Resolve device identity
    let deviceIdentityId: string | null = null;
    if (dto.deviceFingerprint) {
      const identity = await this.identityService.findByFingerprintAndProject(
        dto.deviceFingerprint,
        dto.projectId,
      );
      if (identity) {
        deviceIdentityId = identity.id;
      }
    }

    const doNotTrack = await this.trackingConsent.isDoNotTrack({
      projectId: dto.projectId,
      deviceIdentityId,
      deviceFingerprint: dto.deviceFingerprint,
      distinctId: dto.distinctId ?? null,
    });

    // A messageId that does not exist used to reach the insert and come back
    // as a raw 500 QueryFailedError naming the foreign key constraint. Two
    // things wrong with that: it leaks a schema detail, and 5xx is the wrong
    // class — a client queue retries a 5xx with backoff forever, where a 404
    // is terminal and the event is dropped. A stale id after a campaign is
    // deleted is the realistic way in.
    //
    // Scoped by project as well as existence, so one project's API key cannot
    // write impressions against another project's message. The API key is
    // already checked against `dto.projectId` in the controller; this is what
    // checks the *message* against it.
    //
    // Existence and ownership only — **status is deliberately not checked**,
    // and this is a decision rather than an accident of `findOne`'s default.
    // A message already on a user's screen when its campaign is paused,
    // completed or archived can still legitimately be dismissed, tapped or
    // auto-dismissed, and those events arrive after the status changed.
    // Refusing them would silently under-count every campaign at exactly the
    // moment it stopped — losing the last impressions of every campaign ever
    // run — and the events are honest reports about a message the server did
    // serve. Over-counting is not the risk: a campaign that was never active
    // was never served, so there is nothing to report against it.
    await this.messagesService.findOne(dto.messageId, dto.projectId);

    // A do-not-track person's taps and dismissals are not stored per person.
    // What is kept is only what stops the same message being shown again:
    // the showing itself, keyed by the device the cap reads, without the
    // person, address or browser. The message's aggregate counters below are
    // still updated, since they say how a message did, not who did what.
    const storeRow = !doNotTrack || CAPPING_EVENT_TYPES.includes(dto.eventType);
    // Counted only when nothing is stored; a stripped impression is kept.
    if (!storeRow) this.trackingConsent.recordDrop('in_app_event');

    if (storeRow) {
      const impression = this.impressionRepo.create({
        messageId: dto.messageId,
        projectId: dto.projectId,
        deviceIdentityId: doNotTrack ? null : deviceIdentityId,
        distinctId: doNotTrack ? null : dto.distinctId || null,
        deviceFingerprint: dto.deviceFingerprint,
        eventType: dto.eventType,
        buttonId: doNotTrack ? null : dto.buttonId || null,
        ipAddress: doNotTrack ? null : context?.ipAddress || null,
        userAgent: doNotTrack ? null : context?.userAgent || null,
      });

      await this.impressionRepo.save(impression);
    }

    // Update denormalized counters (fire-and-forget)
    switch (dto.eventType) {
      case 'impression':
        this.messagesService.incrementCounter(dto.messageId, 'totalImpressions').catch(() => {});
        break;
      case 'click':
      case 'cta_click':
        this.messagesService.incrementCounter(dto.messageId, 'totalClicks').catch(() => {});
        break;
      case 'dismiss':
        this.messagesService.incrementCounter(dto.messageId, 'totalDismissals').catch(() => {});
        break;
    }

    // If this is a delivery of a pending message, mark it as delivered
    if (dto.eventType === 'delivered' || dto.eventType === 'impression') {
      await this.pendingRepo.update(
        {
          messageId: dto.messageId,
          deviceFingerprint: dto.deviceFingerprint,
          status: 'pending',
        },
        { status: 'delivered' },
      );
    }
  }

  /**
   * Server-push trigger: queues the message for specific users.
   *
   * A dashboard request (`requester`) with anyone to queue for writes `in_app.triggered`
   * first, before any pending row, so a failed log write queues nothing; one with nobody
   * to queue for changes nothing and writes nothing. A cohort trigger passes `null` and
   * writes its own entry.
   */
  async triggerMessage(
    projectId: string,
    dto: TriggerMessageDto,
    requester: ActivityRequester | null,
  ): Promise<{ queued: number }> {
    const message = await this.messagesService.findOne(dto.messageId, projectId);

    let deviceFingerprints: string[] = [];

    if (dto.targetType === 'all') {
      // Get all known device fingerprints for this project
      const identities = await this.messageRepo.manager
        .getRepository(DeviceIdentityEntity)
        .createQueryBuilder('di')
        .select('DISTINCT di.device_fingerprint', 'deviceFingerprint')
        .where('di.project_id = :projectId', { projectId })
        .getRawMany();
      deviceFingerprints = identities.map((i: { deviceFingerprint: string }) => i.deviceFingerprint);
    } else if (dto.targetType === 'users') {
      deviceFingerprints = dto.deviceFingerprints || [];
      // Also resolve distinctIds to fingerprints
      if (dto.distinctIds && dto.distinctIds.length > 0) {
        for (const did of dto.distinctIds) {
          const identities = await this.identityService.findByDistinctId(did, projectId);
          deviceFingerprints.push(...identities.map((i) => i.deviceFingerprint));
        }
      }
    } else if (dto.targetType === 'cohort') {
      // Cohort resolution is handled by MixpanelCampaignService — it calls
      // this method with resolved fingerprints. If called directly from here,
      // throw an error directing to the cohort-specific endpoint.
      if (!dto.deviceFingerprints || dto.deviceFingerprints.length === 0) {
        return { queued: 0 };
      }
      deviceFingerprints = dto.deviceFingerprints;
    }

    // De-duplicate
    const unique = [...new Set(deviceFingerprints)];

    if (unique.length === 0) {
      return { queued: 0 };
    }

    if (requester) {
      await recordBy(this.activity, requester, {
        projectId,
        action: 'in_app.triggered',
        target: { type: 'in_app_message', id: message.id, label: message.name },
      });
    }

    // Set expiry — 24 hours from now
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Batch insert pending messages
    const BATCH_SIZE = 500;
    let queued = 0;

    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      const entities = batch.map((fp) =>
        this.pendingRepo.create({
          messageId: message.id,
          projectId,
          deviceFingerprint: fp,
          status: 'pending',
          expiresAt,
        }),
      );
      await this.pendingRepo.save(entities);
      queued += entities.length;
    }

    this.logger.log(
      `Triggered in-app message ${message.id} for ${queued} devices in project ${projectId}`,
    );

    return { queued };
  }

  // ── Private Helpers ──

  private async getPendingMessages(
    projectId: string,
    deviceFingerprint: string,
  ): Promise<InAppMessageEntity[]> {
    const now = new Date();

    const pending = await this.pendingRepo.find({
      where: {
        projectId,
        deviceFingerprint,
        status: 'pending',
      },
      relations: ['message'],
      order: { createdAt: 'DESC' },
      take: 5,
    });

    // Filter out expired
    const valid = pending.filter((p) => p.expiresAt > now);

    // Expire old ones (fire-and-forget)
    const expired = pending.filter((p) => p.expiresAt <= now);
    if (expired.length > 0) {
      this.pendingRepo
        .update(
          { id: In(expired.map((e) => e.id)) },
          { status: 'expired' },
        )
        .catch(() => {});
    }

    return valid.map((p) => p.message).filter(Boolean);
  }

  private async getActiveCampaigns(
    projectId: string,
    now: Date,
  ): Promise<InAppMessageEntity[]> {
    return this.messageRepo.find({
      where: {
        projectId,
        status: 'active',
        startsAt: Or(IsNull(), LessThanOrEqual(now)),
        endsAt: Or(IsNull(), MoreThanOrEqual(now)),
      },
      order: { priority: 'DESC' },
    });
  }

  private filterByTrigger(
    messages: InAppMessageEntity[],
    context: ServeMessageRequestDto['context'],
  ): InAppMessageEntity[] {
    return messages.filter((msg) => {
      switch (msg.triggerType) {
        case 'on_app_open':
          // Always matches — the SDK calls check on app open
          return true;

        case 'on_event':
          return context.event && msg.triggerEvent === context.event;

        case 'on_screen':
          return context.screen && msg.triggerScreen === context.screen;

        case 'immediate':
          // Immediate messages are delivered via the pending queue
          return false;

        case 'scheduled':
          // Scheduled means time-gated; the date filter in getActiveCampaigns handles it
          return true;

        default:
          return false;
      }
    });
  }

  async filterByUsers<T extends FilterableMessage>(
    messages: T[],
    user: {
      deviceFingerprint: string;
      distinctId?: string;
      platform?: string;
      country?: string;
      appVersion?: string;
      externalUserId?: string | null;
      deviceIdentityId?: string | null;
    },
  ): Promise<T[]> {
    const result: T[] = [];

    for (const msg of messages) {
      // Check user type
      if (msg.userType === 'all') {
        // Check user filters (platform, country, etc.)
        if (this.matchesUserFilters(msg, user)) {
          result.push(msg);
        }
        continue;
      }

      if (msg.userType === 'cohort') {
        // Check cohort membership by resolving the device fingerprint -> identity -> member
        if (msg.mixpanelCohortId) {
          const isInCohort = await this.checkCohortMembership(
            msg.mixpanelCohortId,
            user.deviceFingerprint,
            msg.projectId,
          );
          if (isInCohort && this.matchesUserFilters(msg, user)) {
            result.push(msg);
          }
        }
        continue;
      }

      if (msg.userType === 'segment') {
        // Withhold on any doubt. A message whose audience cannot be resolved
        // must not fall through to "everyone" — which is what this branch did
        // before segments existed.
        if (!msg.segmentId) continue;

        // No identity resolved at all (e.g. a device that has never registered
        // one) — there is no valid person key to evaluate against.
        if (!user.externalUserId && !user.deviceIdentityId) {
          this.logger.warn(`No identity resolved for segment-targeted message ${msg.id}`);
          continue;
        }

        const personKey = user.externalUserId ?? `device:${user.deviceIdentityId}`;
        try {
          const segment = await this.segmentsService.findOne(msg.projectId, msg.segmentId);
          if (await this.segmentEvaluation.isMember(segment, personKey)) {
            if (this.matchesUserFilters(msg, user)) result.push(msg);
          }
        } catch {
          // Deleted segment, or an evaluation timeout. Withhold, do not throw:
          // one broken message must not fail the whole delivery request.
          this.logger.warn(`Segment ${msg.segmentId} unresolvable for message ${msg.id}`);
        }
        continue;
      }

      // 'specific_users' — user filters handle these
      if (this.matchesUserFilters(msg, user)) {
        result.push(msg);
      }
    }

    return result;
  }

  private matchesUserFilters(
    msg: { userFilters?: UserFilters | null },
    user: { platform?: string; country?: string; appVersion?: string },
  ): boolean {
    const filters = msg.userFilters;
    if (!filters) return true;

    if (filters.platforms && filters.platforms.length > 0) {
      if (!user.platform || !filters.platforms.includes(user.platform)) {
        return false;
      }
    }

    if (filters.countries && filters.countries.length > 0) {
      if (!user.country || !filters.countries.includes(user.country)) {
        return false;
      }
    }

    if (filters.appVersions && filters.appVersions.length > 0) {
      if (!user.appVersion || !filters.appVersions.includes(user.appVersion)) {
        return false;
      }
    }

    return true;
  }

  private async applyFrequencyCapping(
    messages: InAppMessageEntity[],
    deviceFingerprint: string,
  ): Promise<InAppMessageEntity[]> {
    if (messages.length === 0) return [];

    const messageIds = messages.map((m) => m.id);

    // Get impression counts per message for this user
    const impressionCounts = await this.impressionRepo
      .createQueryBuilder('imp')
      .select('imp.message_id', 'messageId')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('MAX(imp.created_at)', 'lastShown')
      .where('imp.message_id IN (:...ids)', { ids: messageIds })
      .andWhere('imp.device_fingerprint = :fp', { fp: deviceFingerprint })
      .andWhere('imp.event_type IN (:...types)', { types: CAPPING_EVENT_TYPES })
      .groupBy('imp.message_id')
      .getRawMany();

    const countMap = new Map<string, { count: number; lastShown: Date }>();
    for (const row of impressionCounts) {
      countMap.set(row.messageId, {
        count: parseInt(row.count, 10),
        lastShown: new Date(row.lastShown),
      });
    }

    const now = Date.now();

    return messages.filter((msg) => {
      const stats = countMap.get(msg.id);

      // No previous impressions — eligible
      if (!stats) return true;

      // Check max impressions per user
      if (msg.maxImpressionsPerUser && stats.count >= msg.maxImpressionsPerUser) {
        return false;
      }

      // Check cooldown (min interval between shows)
      if (msg.minIntervalSeconds) {
        const timeSinceLast = (now - stats.lastShown.getTime()) / 1000;
        if (timeSinceLast < msg.minIntervalSeconds) {
          return false;
        }
      }

      // Check global total cap
      if (msg.maxImpressionsTotal && msg.totalImpressions >= msg.maxImpressionsTotal) {
        return false;
      }

      return true;
    });
  }

  /**
   * Check if a device (by fingerprint) is a resolved member of a Mixpanel cohort.
   * Resolution path: deviceFingerprint → DeviceIdentity → MixpanelCohortMember
   */
  private async checkCohortMembership(
    cohortId: string,
    deviceFingerprint: string,
    projectId: string,
  ): Promise<boolean> {
    // 1. Resolve device fingerprint to identity
    const identity = await this.identityService.findByFingerprintAndProject(
      deviceFingerprint,
      projectId,
    );

    if (!identity) {
      return false;
    }

    // A cohort is an audience built from behaviour (the tenant's Mixpanel),
    // and a do-not-track person must not be picked by one. Segments handle
    // the same rule inside their SQL; cohorts are only membership rows.
    if (
      await this.trackingConsent.isDoNotTrack({ projectId, deviceIdentityId: identity.id })
    ) {
      return false;
    }

    // 2. Check if this identity is a resolved member of the cohort
    const member = await this.cohortMemberRepo.findOne({
      where: {
        cohortId,
        projectId,
        deviceIdentityId: identity.id,
        isResolved: true,
      },
    });

    return member !== null;
  }
}
