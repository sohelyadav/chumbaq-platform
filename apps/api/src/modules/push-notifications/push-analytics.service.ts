import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PushNotificationEventEntity } from './entities/push-notification-event.entity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { IdentityService } from '../identity/identity.service';
import { RecordPushEventDto } from './dto/push-notification.dto';
import { TouchpointsService } from '../touchpoints/touchpoints.service';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { logValue } from '../../common/log-value';

/** Engagement counts for one campaign. */
export interface CampaignEngagement {
  campaignId: string;
  delivered: number;
  impressions: number;
  clicks: number;
  dismissed: number;
  /** Email only: addresses the provider reported as bounced. Zero for push. */
  bounced: number;
  /** Email only: recipients who marked the email as spam. Zero for push. */
  complained: number;
  /**
   * Clicks over devices that actually received the notification, as a
   * percentage. Null when nothing has been reported delivered yet — a CTR of
   * 0% and "we have no delivery data" are different claims, and showing the
   * former for the latter makes a campaign look failed when it is unmeasured.
   */
  clickThroughRate: number | null;
}

const EMPTY_ENGAGEMENT = {
  delivered: 0,
  impressions: 0,
  clicks: 0,
  dismissed: 0,
  bounced: 0,
  complained: 0,
  clickThroughRate: null,
} as const;

@Injectable()
export class PushAnalyticsService {
  private readonly logger = new Logger(PushAnalyticsService.name);

  constructor(
    @InjectRepository(PushNotificationEventEntity)
    private readonly eventRepository: Repository<PushNotificationEventEntity>,
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    private readonly identityService: IdentityService,
    private readonly touchpointsService: TouchpointsService,
    private readonly trackingConsent: TrackingConsentService,
  ) {}

  /**
   * Records one engagement event reported by a device.
   *
   * Ingestion is idempotent: clients retry, and an OS can hand the same
   * notification back on app restart. The unique index on
   * (campaign, device, type) plus ON CONFLICT DO NOTHING means a replay is
   * absorbed rather than inflating the numerator of every rate we report.
   */
  async recordEvent(dto: RecordPushEventDto): Promise<{ recorded: boolean }> {
    const campaign = await this.logRepository.findOne({
      where: { id: dto.campaignId, projectId: dto.projectId },
    });

    // Scoped to the project so an API key cannot attach engagement to another
    // tenant's campaign by guessing an id.
    if (!campaign) {
      throw new NotFoundException('Campaign not found for this project');
    }

    const identity = await this.identityService.findByFingerprintAndProject(
      dto.deviceFingerprint,
      dto.projectId,
    );

    if (!identity) {
      throw new NotFoundException(
        'Device identity not found. Call identify() first.',
      );
    }

    const result = await this.eventRepository
      .createQueryBuilder()
      .insert()
      .into(PushNotificationEventEntity)
      .values({
        projectId: dto.projectId,
        campaignId: dto.campaignId,
        deviceIdentityId: identity.id,
        type: dto.type,
        platform: dto.platform ?? null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        // QueryDeepPartialEntity treats a bare index signature as a nested
        // partial; the cast keeps the jsonb column written as one value.
        metadata: (dto.metadata ?? null) as never,
      })
      .orIgnore()
      .execute();

    const recorded = (result.identifiers?.[0] ?? null) !== null;

    // Only on the first record: a replayed click must not add a second
    // touchpoint, or the attribution model would over-credit push for a
    // conversion purely because a device retried its report.
    //
    // The event row above is kept for a do-not-track device: it is the
    // campaign's own delivery and engagement receipt for a message already
    // sent, reported per campaign. The touchpoint is not: it exists to credit
    // the person's later conversions, which is the profiling they refused.
    if (recorded && dto.type === 'click') {
      if (
        await this.trackingConsent.isDoNotTrack({
          projectId: dto.projectId,
          deviceIdentityId: identity.id,
        })
      ) {
        this.trackingConsent.recordDrop('touchpoint');
      } else {
        await this.recordClickTouchpoint(dto, campaign);
      }
    }

    return { recorded };
  }

  /**
   * Feeds a push click into the multi-touch attribution model.
   *
   * `push_click` has always been a valid touchpoint type mapped to the `push`
   * channel, but nothing outside the seed script ever produced one — so push
   * was absent from every attribution report despite being a real channel.
   *
   * Failures here are logged and swallowed: attribution is a derived view, and
   * losing a touchpoint is a smaller harm than rejecting the engagement event
   * that the click itself represents.
   */
  private async recordClickTouchpoint(
    dto: RecordPushEventDto,
    campaign: PushNotificationLogEntity,
  ): Promise<void> {
    try {
      await this.touchpointsService.record({
        projectId: dto.projectId,
        deviceFingerprint: dto.deviceFingerprint,
        touchpointType: 'push_click',
        campaign: campaign.title,
        platform: dto.platform,
        metadata: { campaignId: campaign.id },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(
        // Database errors repeat the values they refused, and these came from the SDK.
        `Push click recorded but touchpoint failed for campaign ${campaign.id}: ${logValue(detail)}`,
      );
    }
  }

  /**
   * Engagement for many campaigns in one query.
   *
   * Written as a single grouped aggregate rather than a count per campaign:
   * the notification list renders every campaign on the page, so the per-row
   * form would issue one query per row on every poll.
   */
  async getEngagementFor(
    campaignIds: string[],
  ): Promise<Map<string, CampaignEngagement>> {
    const engagement = new Map<string, CampaignEngagement>();
    if (campaignIds.length === 0) return engagement;

    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .select('event.campaign_id', 'campaignId')
      .addSelect('event.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where({ campaignId: In(campaignIds) })
      .groupBy('event.campaign_id')
      .addGroupBy('event.type')
      .getRawMany<{ campaignId: string; type: string; count: string }>();

    for (const id of campaignIds) {
      engagement.set(id, { campaignId: id, ...EMPTY_ENGAGEMENT });
    }

    for (const row of rows) {
      const entry = engagement.get(row.campaignId);
      if (!entry) continue;
      const count = Number(row.count);
      if (row.type === 'delivered') entry.delivered = count;
      else if (row.type === 'impression') entry.impressions = count;
      else if (row.type === 'click') entry.clicks = count;
      else if (row.type === 'dismissed') entry.dismissed = count;
      else if (row.type === 'bounced') entry.bounced = count;
      else if (row.type === 'complained') entry.complained = count;
    }

    for (const entry of engagement.values()) {
      entry.clickThroughRate =
        entry.delivered > 0
          ? Math.round((entry.clicks / entry.delivered) * 1000) / 10
          : null;
    }

    return engagement;
  }

  /**
   * Per-arm results for an experiment.
   *
   * Reads the arms from the child campaigns rather than the parent's
   * `variants`, so an arm that was skipped for drawing nobody simply is not
   * reported — rather than showing as a zero-recipient row that looks like a
   * delivery failure.
   */
  async getExperimentReport(
    projectId: string,
    campaignId: string,
  ): Promise<{
    isExperiment: boolean;
    controlSize: number;
    arms: Array<{
      variantKey: string;
      campaignId: string;
      recipients: number;
      accepted: number;
      engagement: CampaignEngagement;
    }>;
    /** Null until the evidence can support naming one. */
    leader: string | null;
    verdict: string;
  }> {
    const parent = await this.logRepository.findOne({
      where: { id: campaignId, projectId },
    });
    if (!parent) {
      throw new NotFoundException('Campaign not found for this project');
    }

    const children = await this.logRepository.find({
      where: { parentCampaignId: parent.id },
    });
    const arms = children.filter((child) => child.variantKey !== null);

    if (arms.length === 0) {
      return {
        isExperiment: !!parent.variants,
        controlSize: parent.controlDeviceIds?.length ?? 0,
        arms: [],
        leader: null,
        verdict: parent.variants
          ? 'This experiment has not been split into arms yet.'
          : 'This campaign is not an experiment.',
      };
    }

    // An arm that was split again — by recipient timezone, or by optimised
    // send hour — sends nothing itself: its status becomes `expanded` and
    // every real send lives in its own children. Reading the arm row alone
    // reported 0 accepted and no engagement for every arm of a local-time
    // experiment, so the verdict stayed "not enough data" no matter how the
    // test actually performed.
    const waves = await this.logRepository.find({
      where: { parentCampaignId: In(arms.map((a) => a.id)) },
    });

    // Measured at the leaves. Summing an expanded arm *and* its waves would
    // double every count, since the arm's totals are the audience the waves
    // were split from.
    const measuredByArm = new Map<string, PushNotificationLogEntity[]>(
      arms.map((arm) => {
        const own = waves.filter((w) => w.parentCampaignId === arm.id);
        return [arm.id, own.length > 0 ? own : [arm]];
      }),
    );

    const engagement = await this.getEngagementFor(
      [...measuredByArm.values()].flat().map((c) => c.id),
    );

    const rows = arms.map((arm) => {
      const measured = measuredByArm.get(arm.id)!;
      return {
        variantKey: arm.variantKey!,
        campaignId: arm.id,
        recipients: measured.reduce((sum, c) => sum + c.totalTokens, 0),
        accepted: measured.reduce((sum, c) => sum + c.successCount, 0),
        engagement: this.combineEngagement(
          arm.id,
          measured.map(
            (c) =>
              engagement.get(c.id) ?? { campaignId: c.id, ...EMPTY_ENGAGEMENT },
          ),
        ),
      };
    });

    return {
      isExperiment: true,
      controlSize: parent.controlDeviceIds?.length ?? 0,
      arms: rows,
      ...this.callExperiment(rows),
    };
  }

  /**
   * Every campaign that reached one person, newest first.
   *
   * Answers the question support actually gets — "did this user get it?" — from
   * the events already collected, rather than inferring it from a campaign's
   * aggregate counts.
   *
   * Takes the person's device identities rather than one id, because a person
   * is not a device: someone on a phone and a tablet is two identity rows
   * sharing a distinct id, and a campaign delivered to either reached them.
   * The same campaign therefore collapses to one row here, with the strongest
   * outcome across their devices — a notification opened on the tablet was
   * opened, whatever the phone did with it.
   */
  async getPersonCampaignHistory(
    projectId: string,
    deviceIdentityIds: string[],
    limit = 50,
  ): Promise<
    Array<{
      campaignId: string;
      title: string;
      sentAt: Date | null;
      /** Latest occurrence of each type across this person's devices. */
      delivered: Date | null;
      impression: Date | null;
      clicked: Date | null;
      dismissed: Date | null;
    }>
  > {
    if (deviceIdentityIds.length === 0) return [];

    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .select('event.campaign_id', 'campaignId')
      .addSelect('log.title', 'title')
      .addSelect('log.sent_at', 'sentAt')
      // MAX over each type rather than a row per event: a person's history is
      // one line per campaign, not one per device per interaction.
      .addSelect(
        `MAX(event.occurred_at) FILTER (WHERE event.type = 'delivered')`,
        'delivered',
      )
      .addSelect(
        `MAX(event.occurred_at) FILTER (WHERE event.type = 'impression')`,
        'impression',
      )
      .addSelect(
        `MAX(event.occurred_at) FILTER (WHERE event.type = 'click')`,
        'clicked',
      )
      .addSelect(
        `MAX(event.occurred_at) FILTER (WHERE event.type = 'dismissed')`,
        'dismissed',
      )
      .innerJoin(
        PushNotificationLogEntity,
        'log',
        'log.id = event.campaign_id',
      )
      .where('event.project_id = :projectId', { projectId })
      .andWhere('event.device_identity_id IN (:...deviceIdentityIds)', {
        deviceIdentityIds,
      })
      .groupBy('event.campaign_id')
      .addGroupBy('log.title')
      .addGroupBy('log.sent_at')
      .orderBy('log.sent_at', 'DESC')
      .limit(limit)
      .getRawMany<{
        campaignId: string;
        title: string;
        sentAt: Date | null;
        delivered: Date | null;
        impression: Date | null;
        clicked: Date | null;
        dismissed: Date | null;
      }>();

    return rows.map((row) => ({
      campaignId: row.campaignId,
      title: row.title,
      sentAt: row.sentAt,
      delivered: row.delivered,
      impression: row.impression,
      clicked: row.clicked,
      dismissed: row.dismissed,
    }));
  }

  /**
   * Sums engagement across the campaigns an arm actually sent through.
   *
   * The rate is recomputed from the summed totals rather than averaged: a
   * timezone wave of 10 devices and one of 10,000 do not each contribute half
   * of the arm's click-through rate. `delivered === 0` stays null, because
   * "nothing reported yet" and "0%" are different claims.
   */
  private combineEngagement(
    campaignId: string,
    parts: CampaignEngagement[],
  ): CampaignEngagement {
    const total = parts.reduce(
      (acc, part) => ({
        delivered: acc.delivered + part.delivered,
        impressions: acc.impressions + part.impressions,
        clicks: acc.clicks + part.clicks,
        dismissed: acc.dismissed + part.dismissed,
        bounced: acc.bounced + part.bounced,
        complained: acc.complained + part.complained,
      }),
      { delivered: 0, impressions: 0, clicks: 0, dismissed: 0, bounced: 0, complained: 0 },
    );

    return {
      campaignId,
      ...total,
      clickThroughRate:
        total.delivered > 0
          ? Math.round((total.clicks / total.delivered) * 1000) / 10
          : null,
    };
  }

  /**
   * Names a leader only when the evidence can carry it.
   *
   * Declaring a winner off a handful of clicks is worse than saying nothing:
   * it is the number a marketer will act on, and an experiment that always
   * produces a confident answer is not measuring anything.
   *
   * The bar is deliberately blunt rather than a significance test — enough
   * delivered messages to be meaningful, and a gap wide enough not to be
   * noise. A real test belongs here later; overstating certainty does not.
   */
  private callExperiment(
    rows: Array<{ variantKey: string; engagement: CampaignEngagement }>,
  ): { leader: string | null; verdict: string } {
    const measured = rows.filter((row) => row.engagement.delivered > 0);
    if (measured.length < 2) {
      return {
        leader: null,
        verdict:
          'No results yet. Delivery and clicks are reported by the SDK in your app.',
      };
    }

    const MIN_DELIVERED_PER_ARM = 100;
    if (measured.some((row) => row.engagement.delivered < MIN_DELIVERED_PER_ARM)) {
      return {
        leader: null,
        verdict: `Too early to call — each arm needs at least ${MIN_DELIVERED_PER_ARM} delivered messages.`,
      };
    }

    const sorted = [...measured].sort(
      (a, b) =>
        (b.engagement.clickThroughRate ?? 0) -
        (a.engagement.clickThroughRate ?? 0),
    );
    const best = sorted[0];
    const runnerUp = sorted[1];
    const gap =
      (best.engagement.clickThroughRate ?? 0) -
      (runnerUp.engagement.clickThroughRate ?? 0);

    if (gap < 1) {
      return {
        leader: null,
        verdict: 'No clear difference between the arms.',
      };
    }

    return {
      leader: best.variantKey,
      verdict: `${best.variantKey} is ahead by ${gap.toFixed(1)} percentage points.`,
    };
  }

  /**
   * Past click hours per device, on the recipient's own clock.
   *
   * The conversion to local time happens in SQL, because "the hour they
   * engage" is meaningless in UTC: 19:00 for someone in Tokyo and someone in
   * São Paulo are twelve hours apart in habit terms, and bucketing by UTC
   * would blend them into noise.
   *
   * Devices with no known timezone are read in UTC — the same fallback the
   * rest of the scheduling path uses.
   */
  async clickHoursForDevices(
    projectId: string,
    deviceIdentityIds: string[],
    sinceDays = 90,
  ): Promise<
    Array<{ deviceIdentityId: string; hour: number; clicks: number }>
  > {
    if (deviceIdentityIds.length === 0) return [];

    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .innerJoin('device_identities', 'i', 'i.id = event.device_identity_id')
      .select('event.device_identity_id', 'deviceIdentityId')
      .addSelect(
        `EXTRACT(HOUR FROM (event.occurred_at AT TIME ZONE COALESCE(i.timezone, 'UTC')))`,
        'hour',
      )
      .addSelect('COUNT(*)', 'clicks')
      .where('event.project_id = :projectId', { projectId })
      .andWhere('event.type = :type', { type: 'click' })
      .andWhere('event.device_identity_id IN (:...ids)', {
        ids: deviceIdentityIds,
      })
      .andWhere(`event.occurred_at > NOW() - (:sinceDays || ' days')::interval`, {
        sinceDays,
      })
      .groupBy('event.device_identity_id')
      .addGroupBy(
        `EXTRACT(HOUR FROM (event.occurred_at AT TIME ZONE COALESCE(i.timezone, 'UTC')))`,
      )
      .getRawMany<{ deviceIdentityId: string; hour: string; clicks: string }>();

    return rows.map((row) => ({
      deviceIdentityId: row.deviceIdentityId,
      hour: Number(row.hour),
      clicks: Number(row.clicks),
    }));
  }

  /** Engagement for a single campaign, verified to belong to the project. */
  async getCampaignReport(
    projectId: string,
    campaignId: string,
  ): Promise<CampaignEngagement> {
    const campaign = await this.logRepository.findOne({
      where: { id: campaignId, projectId },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found for this project');
    }

    const engagement = await this.getEngagementFor([campaignId]);
    return (
      engagement.get(campaignId) ?? { campaignId, ...EMPTY_ENGAGEMENT }
    );
  }
}
