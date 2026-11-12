import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { PushNotificationLogEntity } from '../../modules/push-notifications/entities/push-notification-log.entity';
import { PushTokensService } from '../../modules/push-tokens/push-tokens.service';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  nextLocalOccurrence,
} from '../../modules/push-notifications/local-send-time';
import { splitAudience } from '../../modules/push-notifications/variant-assignment';
import { shiftOutOfQuietHours } from '../../modules/push-notifications/local-send-time';
import { PushConfigEntity } from '../../modules/push-notifications/entities/push-config.entity';
import { nextOccurrence, nextOccurrenceAfterNow } from '../../modules/push-notifications/recurrence';
import {
  bestHourPerDevice,
  groupBySendHour,
  hourToLocalTime,
} from '../../modules/push-notifications/send-time-optimisation';
import { PushAnalyticsService } from '../../modules/push-notifications/push-analytics.service';
import { EmailAudienceService } from '../../modules/email/email-audience.service';
import { EmailSettingsService } from '../../modules/email/email-settings.service';
import { SmsAudienceService } from '../../modules/sms/sms-audience.service';
import { SmsSettingsService } from '../../modules/sms/sms-settings.service';
import { WhatsAppAudienceService } from '../../modules/whatsapp/whatsapp-audience.service';
import { WhatsAppSettingsService } from '../../modules/whatsapp/whatsapp-settings.service';
import { EmailContent, WhatsAppContent } from '../../modules/push-notifications/message-channel';
import { PushVariant } from '../../modules/push-notifications/variant-assignment';
import {
  CAMPAIGN_MISSED_DURING_SUSPENSION,
  ProjectSuspensionService,
} from '../../modules/projects/project-suspension.service';
import {
  QUEUE_PUSH_CAMPAIGN,
  JOB_DISPATCH_CAMPAIGN,
  PushCampaignJobData,
} from '../queue.constants';

/**
 * Promotes scheduled campaigns onto the delivery queue when their time comes.
 *
 * The schedule lives in Postgres rather than as a BullMQ delayed job so it can
 * be listed, edited and cancelled from the dashboard, and so it survives losing
 * Redis — a campaign scheduled for next month should not depend on a cache
 * staying up for a month.
 */
@Injectable()
export class PushCampaignScheduleScheduler {
  private readonly logger = new Logger(PushCampaignScheduleScheduler.name);

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(PushConfigEntity)
    private readonly configRepository: Repository<PushConfigEntity>,
    @InjectQueue(QUEUE_PUSH_CAMPAIGN)
    private readonly pushQueue: Queue<PushCampaignJobData>,
    private readonly pushTokensService: PushTokensService,
    private readonly pushAnalytics: PushAnalyticsService,
    private readonly emailAudience: EmailAudienceService,
    private readonly emailSettings: EmailSettingsService,
    private readonly smsAudience: SmsAudienceService,
    private readonly smsSettings: SmsSettingsService,
    private readonly whatsappAudience: WhatsAppAudienceService,
    private readonly whatsappSettings: WhatsAppSettingsService,
    private readonly suspension: ProjectSuspensionService,
  ) {}

  /**
   * The people a parent campaign is split across, from the right channel.
   *
   * Push splits over identities holding a live token; email and SMS over
   * one identity per reachable address. Asking push for an email campaign's
   * audience would assign arms and waves to people who cannot receive it and
   * leave out people who can.
   */
  private async audienceOf(parent: PushNotificationLogEntity): Promise<string[]> {
    if (parent.channel === 'email') {
      return this.emailAudience.listRecipientIds(await this.addressScope(parent));
    }
    if (parent.channel === 'sms') {
      return this.smsAudience.listRecipientIds(await this.addressScope(parent));
    }
    if (parent.channel === 'whatsapp') {
      return this.whatsappAudience.listRecipientIds(await this.addressScope(parent));
    }
    return this.pushTokensService.listDeviceIdentityIds(
      parent.targetType === 'project'
        ? { projectId: parent.projectId }
        : {
            projectId: parent.projectId,
            deviceIdentityIds: parent.targetDeviceIds ?? [],
          },
    );
  }

  private async audienceByTimezone(
    parent: PushNotificationLogEntity,
  ): Promise<Map<string, string[]>> {
    if (parent.channel === 'email') {
      return this.emailAudience.groupByTimezone(
        await this.addressScope(parent),
        DEFAULT_TIMEZONE,
      );
    }
    if (parent.channel === 'sms') {
      return this.smsAudience.groupByTimezone(
        await this.addressScope(parent),
        DEFAULT_TIMEZONE,
      );
    }
    if (parent.channel === 'whatsapp') {
      return this.whatsappAudience.groupByTimezone(
        await this.addressScope(parent),
        DEFAULT_TIMEZONE,
      );
    }
    return this.pushTokensService.groupDeviceIdentitiesByTimezone(
      parent.targetType === 'project'
        ? { projectId: parent.projectId }
        : {
            projectId: parent.projectId,
            deviceIdentityIds: parent.targetDeviceIds ?? [],
          },
      DEFAULT_TIMEZONE,
    );
  }

  /** The audience scope of an email or SMS parent, under its channel's consent policy. */
  private async addressScope(parent: PushNotificationLogEntity) {
    const settings =
      parent.channel === 'sms'
        ? await this.smsSettings.find(parent.projectId)
        : parent.channel === 'whatsapp'
          ? await this.whatsappSettings.find(parent.projectId)
          : await this.emailSettings.find(parent.projectId);
    return {
      projectId: parent.projectId,
      deviceIdentityIds:
        parent.targetType === 'project' ? null : (parent.targetDeviceIds ?? []),
      requireOptIn: settings?.requireOptIn ?? true,
    };
  }

  /**
   * One arm's email: the arm's subject, and its HTML, text and preheader
   * where it has its own, the campaign's otherwise.
   */
  private variantEmail(
    parent: PushNotificationLogEntity,
    variant: PushVariant,
  ): EmailContent | null {
    if (parent.channel !== 'email' || !parent.emailContent) return null;
    return {
      subject: variant.title,
      html: variant.html ?? parent.emailContent.html,
      text: variant.body ?? parent.emailContent.text ?? null,
      preheader: variant.preheader ?? parent.emailContent.preheader ?? null,
    };
  }

  /** One arm's WhatsApp message: the arm's own template and values, or the campaign's. */
  private variantWhatsApp(
    parent: PushNotificationLogEntity,
    variant: PushVariant,
  ): WhatsAppContent | null {
    if (parent.channel !== 'whatsapp') return null;
    return variant.whatsapp ?? parent.whatsappContent ?? null;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    // First, so no sweep below ever sees a suspended tenant's due campaign. If
    // this read fails the tick fails with it and nothing is promoted; every due
    // row is still there for the next minute. A suspension landing after this
    // line is caught by the processor before anything is sent.
    await this.retireDueCampaignsOfSuspendedTenants();

    // Order matters: an experiment splits into variant children first, and
    // those children inherit deliverInRecipientTimezone, so the timezone sweep
    // below can split each arm by zone on the same pass.
    // Recurring first: an occurrence spawned this tick can then be split by
    // variant and by timezone on the same pass.
    const spawned = await this.spawnRecurringOccurrences();
    if (spawned > 0) {
      this.logger.log(`Spawned ${spawned} recurring campaign occurrence(s)`);
    }

    const split = await this.expandVariantCampaigns();
    if (split > 0) {
      this.logger.log(`Split ${split} campaign(s) into experiment variants`);
    }

    const expanded = await this.expandLocalTimeCampaigns();
    if (expanded > 0) {
      this.logger.log(`Expanded ${expanded} campaign(s) into per-timezone sends`);
    }

    const promoted = await this.promoteDueCampaigns();
    if (promoted > 0) {
      this.logger.log(`Promoted ${promoted} scheduled campaign(s) to the queue`);
    }
  }

  /**
   * Stops a suspended tenant's campaigns coming due, without sending them.
   *
   * Merely skipping them would leave them due, so reactivation would fire every
   * one at once, possibly days late and with nobody watching. So a campaign whose
   * moment passes during a suspension is ended there and then:
   *
   * - A one-off goes to `cancelled` with a reason on it, the same terminal state
   *   as a marketer cancelling it, counters untouched. It covers experiment and
   *   local-time parents too, since none of them has split yet, and each wave of
   *   one that split before the suspension.
   * - A recurring template stays `scheduled` and moves to its next occurrence,
   *   losing this period, as a failed spawn already does. So the series carries
   *   on by itself after reactivation.
   *
   * Campaigns due after the suspension ends are never touched and fire on time.
   */
  async retireDueCampaignsOfSuspendedTenants(): Promise<number> {
    const suspended = [...(await this.suspension.suspendedProjectIds())];
    if (suspended.length === 0) return 0;

    const now = new Date();

    const cancelled = await this.logRepository.update(
      {
        status: 'scheduled',
        projectId: In(suspended),
        recurrence: IsNull(),
        scheduledAt: LessThanOrEqual(now),
      },
      {
        status: 'cancelled',
        errorMessage: CAMPAIGN_MISSED_DURING_SUSPENSION,
        completedAt: now,
      },
    );

    const templates = await this.logRepository.find({
      where: {
        status: 'scheduled',
        projectId: In(suspended),
        recurrence: Not(IsNull()),
        scheduledAt: LessThanOrEqual(now),
      },
    });

    for (const template of templates) {
      const firesAt = template.scheduledAt!;
      // Past now, not just one step on: a step still in the past would leave it due, and
      // the spawn sweep later in this tick would send an occurrence for this tenant.
      const next = nextOccurrenceAfterNow(template.recurrence!, firesAt, now);
      await this.logRepository.update(
        { id: template.id, scheduledAt: firesAt },
        next === null
          ? { status: 'expanded', completedAt: now }
          : { scheduledAt: next },
      );
    }

    return (cancelled.affected ?? 0) + templates.length;
  }

  /**
   * Spawns one occurrence of each due recurring campaign.
   *
   * The recurring row is a template that stays `scheduled` indefinitely, so it
   * cannot be claimed by flipping its status the way a one-off is. Instead the
   * claim is optimistic on the timestamp: advance `scheduled_at` to the next
   * occurrence only if it still holds the value we read. Two instances racing
   * means one matches zero rows and does nothing, so a period can never
   * produce two sends.
   */
  async spawnRecurringOccurrences(): Promise<number> {
    const due = await this.logRepository.find({
      where: {
        status: 'scheduled',
        recurrence: Not(IsNull()),
        scheduledAt: LessThanOrEqual(new Date()),
      },
    });

    let spawned = 0;

    for (const template of due) {
      const firesAt = template.scheduledAt!;
      const next = nextOccurrence(template.recurrence!, firesAt);

      if (next === null) {
        // The series has run past its end date. Terminal, so the sweep stops
        // looking at it.
        await this.logRepository.update(
          { id: template.id, scheduledAt: firesAt },
          { status: 'expanded', completedAt: new Date() },
        );
        continue;
      }

      const claim = await this.logRepository.update(
        { id: template.id, scheduledAt: firesAt },
        { scheduledAt: next },
      );
      if (!claim.affected) continue;

      try {
        await this.createOccurrence(template, firesAt);
        spawned += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown error';
        // The schedule has already moved on, so this period is simply lost
        // rather than retried — repeating it later would send a "daily" push
        // at the wrong time, which is worse than skipping one.
        this.logger.error(
          `Could not spawn occurrence of recurring campaign ${template.id}: ${detail}`,
        );
      }
    }

    return spawned;
  }

  private async createOccurrence(
    template: PushNotificationLogEntity,
    firesAt: Date,
  ): Promise<void> {
    const occurrence = this.logRepository.create({
      projectId: template.projectId,
      channel: template.channel,
      emailContent: template.emailContent,
      whatsappContent: template.whatsappContent,
      parentCampaignId: template.id,
      title: template.title,
      body: template.body,
      data: template.data,
      imageUrl: template.imageUrl,
      deepLinkUrl: template.deepLinkUrl,
      silent: template.silent,
      deliveryOptions: template.deliveryOptions,
      // An occurrence is the only thing a recurring campaign ever sends — the
      // template itself never goes out. Anything not copied here is dropped
      // from every send in the series, not merely from one of them.
      actions: template.actions,
      iosCategory: template.iosCategory,
      carousel: template.carousel,
      timer: template.timer,
      translations: template.translations,
      sendTimeOptimised: template.sendTimeOptimised,
      targetType: template.targetType,
      targetDeviceIds: template.targetDeviceIds,
      segmentId: template.segmentId,
      // Carried so a recurring campaign can also be an experiment or be
      // delivered in local time — the later sweeps pick the occurrence up.
      variants: template.variants,
      controlPercentage: template.controlPercentage,
      deliverInRecipientTimezone: template.deliverInRecipientTimezone,
      localSendTime: template.localSendTime,
      // The occurrence itself never recurs, or it would fork the series.
      recurrence: null,
      totalTokens: template.totalTokens,
      processedTokens: 0,
      successCount: 0,
      failureCount: 0,
      scheduledAt: firesAt,
      status: 'scheduled',
    } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity;

    await this.logRepository.save(occurrence);
    this.logger.log(
      `Recurring campaign ${template.id} spawned occurrence ${occurrence.id}`,
    );
  }

  /**
   * Splits an experiment into one ordinary campaign per arm.
   *
   * Each child carries that arm's own copy and a disjoint slice of the
   * audience, so every existing guarantee applies to it unchanged — and a
   * child that also inherits `deliverInRecipientTimezone` is split again by
   * the timezone sweep, giving variants x timezones with no extra machinery.
   *
   * The control slice gets no child at all. Sending nothing is the point; it
   * is recorded on the parent so the report has something to measure against.
   */
  async expandVariantCampaigns(): Promise<number> {
    const claimed = await this.logRepository
      .createQueryBuilder()
      .update(PushNotificationLogEntity)
      .set({ status: 'expanded', completedAt: new Date() })
      .where('status = :status', { status: 'scheduled' })
      .andWhere('variants IS NOT NULL')
      .andWhere('recurrence IS NULL')
      .andWhere('scheduled_at <= :now', { now: new Date() })
      .returning('*')
      .execute();

    const parents = (claimed.raw ?? []) as Array<Record<string, unknown>>;
    let split = 0;

    for (const raw of parents) {
      const parent = this.hydrate(raw);
      try {
        await this.createVariantChildren(parent);
        split += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Could not split experiment ${parent.id} into variants: ${detail}`,
        );
        await this.logRepository
          .update(
            { id: parent.id },
            {
              status: 'failed',
              errorMessage: `Could not split this experiment into variants: ${detail}`,
            },
          )
          .catch(() => undefined);
      }
    }

    return split;
  }

  private async createVariantChildren(
    parent: PushNotificationLogEntity,
  ): Promise<void> {
    const variants = parent.variants ?? [];
    const audience = await this.audienceOf(parent);

    const { control, byVariant } = splitAudience(
      parent.id,
      audience,
      variants,
      parent.controlPercentage ?? 0,
    );

    // Recorded even when empty, so the report can distinguish "no control
    // group was configured" from "the control group drew nobody".
    await this.logRepository.update(
      { id: parent.id },
      { controlDeviceIds: control },
    );

    const children = variants
      .filter((variant) => (byVariant.get(variant.key) ?? []).length > 0)
      .map((variant) => {
        const deviceIdentityIds = byVariant.get(variant.key)!;
        return this.logRepository.create({
          projectId: parent.projectId,
          channel: parent.channel,
          emailContent: this.variantEmail(parent, variant),
          whatsappContent: this.variantWhatsApp(parent, variant),
          parentCampaignId: parent.id,
          variantKey: variant.key,
          // The arm's own copy. Downstream, this child is just a campaign.
          title: variant.title,
          body: variant.body ?? parent.body,
          imageUrl: variant.imageUrl ?? parent.imageUrl,
          deepLinkUrl: variant.deepLinkUrl ?? parent.deepLinkUrl,
          // The arm's own languages, never the parent's: a campaign-level
          // translation would overwrite the copy this arm is testing.
          translations: variant.translations ?? null,
          data: parent.data,
          silent: parent.silent,
          deliveryOptions: parent.deliveryOptions,
          // Buttons are campaign-level furniture, not part of what an arm is
          // testing, so every arm carries the same set.
          actions: parent.actions,
          iosCategory: parent.iosCategory,
          carousel: parent.carousel,
          timer: parent.timer,
          sendTimeOptimised: parent.sendTimeOptimised,
          // Inherited so an experiment can also be delivered in local time —
          // the timezone sweep splits each arm again.
          deliverInRecipientTimezone: parent.deliverInRecipientTimezone,
          localSendTime: parent.localSendTime,
          targetType: 'devices',
          targetDeviceIds: deviceIdentityIds,
          segmentId: parent.segmentId,
          totalTokens: deviceIdentityIds.length,
          processedTokens: 0,
          successCount: 0,
          failureCount: 0,
          scheduledAt: parent.scheduledAt ?? new Date(),
          status: 'scheduled',
        } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity;
      });

    if (children.length === 0) {
      this.logger.warn(
        `Experiment ${parent.id} produced no arms — its audience had no reachable devices`,
      );
      return;
    }

    await this.logRepository.save(children);
    this.logger.log(
      `Experiment ${parent.id} split into ${children.length} arm(s), ${control.length} held back as control`,
    );
  }

  /** Rebuilds an entity from a RETURNING * row. */
  private hydrate(raw: Record<string, unknown>): PushNotificationLogEntity {
    return this.logRepository.create(
      this.logRepository.metadata.columns.reduce((acc, column) => {
        acc[column.propertyName] = raw[column.databaseName];
        return acc;
      }, {} as Record<string, unknown>),
    ) as PushNotificationLogEntity;
  }

  /**
   * Splits a "deliver at 09:00 in the recipient's own timezone" campaign into
   * one ordinary child campaign per timezone.
   *
   * Children are plain campaigns with an explicit device list and their own
   * scheduledAt, so every existing guarantee — the keyset cursor, checkpoint
   * resume, reconciliation, frequency capping — applies to each of them
   * unchanged. The alternative, teaching the cursor about timezones, would
   * have meant one campaign staying open for a full day re-scanning for
   * newly-eligible devices.
   *
   * The parent is claimed the same way a promotion is, so two API instances
   * cannot both expand it and send everything twice.
   */
  async expandLocalTimeCampaigns(): Promise<number> {
    const claimed = await this.logRepository
      .createQueryBuilder()
      .update(PushNotificationLogEntity)
      .set({ status: 'expanded', completedAt: new Date() })
      .where('status = :status', { status: 'scheduled' })
      .andWhere('deliver_in_recipient_timezone = true')
      // An experiment parent is split into arms first. Guarded here as well as
      // by ordering, so a future reshuffle of handleTick cannot make a parent
      // skip its variants and send one message to everyone.
      .andWhere('variants IS NULL')
      // A recurring template is never sent itself; it spawns occurrences.
      .andWhere('recurrence IS NULL')
      .andWhere('scheduled_at <= :now', { now: new Date() })
      .returning('*')
      .execute();

    const parents = (claimed.raw ?? []) as Array<Record<string, unknown>>;
    let expanded = 0;

    for (const raw of parents) {
      const parent = this.hydrate(raw);

      try {
        await this.createTimezoneChildren(parent);
        expanded += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Could not expand campaign ${parent.id} into per-timezone sends: ${detail}`,
        );
        await this.logRepository
          .update(
            { id: parent.id },
            {
              status: 'failed',
              errorMessage: `Could not split this campaign by timezone: ${detail}`,
            },
          )
          .catch(() => undefined);
      }
    }

    return expanded;
  }

  private async createTimezoneChildren(
    parent: PushNotificationLogEntity,
  ): Promise<void> {
    const localSendTime = parent.localSendTime ?? '09:00';

    const grouped = await this.audienceByTimezone(parent);

    // Quiet hours are expressed on the recipient's clock, so they can only be
    // applied once a campaign has a single known zone per wave — which is
    // exactly what this split produces.
    const config = await this.configRepository.findOne({
      where: { projectId: parent.projectId },
    });

    // For an optimised campaign each zone splits again by the hour its
    // recipients actually engage, so one wave becomes several.
    const bestHours = parent.sendTimeOptimised
      ? bestHourPerDevice(
          await this.pushAnalytics.clickHoursForDevices(
            parent.projectId,
            [...grouped.values()].flat(),
          ),
        )
      : new Map<string, number | null>();

    const now = new Date();
    const children: PushNotificationLogEntity[] = [];

    for (const [timezone, deviceIdentityIds] of grouped) {
      // A device can report any string as its timezone. An unrecognised one
      // falls back rather than throwing, which would strand the whole campaign
      // because of one bad row.
      const zone = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;

      const waves = parent.sendTimeOptimised
        ? [...groupBySendHour(deviceIdentityIds, bestHours)].map(
            ([hour, ids]) => ({ time: hourToLocalTime(hour), ids }),
          )
        : [{ time: localSendTime, ids: deviceIdentityIds }];

      for (const wave of waves) children.push(
        this.logRepository.create({
          projectId: parent.projectId,
          channel: parent.channel,
          emailContent: parent.emailContent,
          whatsappContent: parent.whatsappContent,
          parentCampaignId: parent.id,
          title: parent.title,
          body: parent.body,
          data: parent.data,
          imageUrl: parent.imageUrl,
          deepLinkUrl: parent.deepLinkUrl,
          silent: parent.silent,
          deliveryOptions: parent.deliveryOptions,
          actions: parent.actions,
          iosCategory: parent.iosCategory,
          translations: parent.translations,
          carousel: parent.carousel,
          timer: parent.timer,
          // Carried so a wave split off an experiment arm stays attributable
          // to that arm. `sendTimeOptimised` deliberately is not: this wave's
          // hour is already resolved, and re-flagging it would ask the sweep
          // to split an already-split campaign again.
          variantKey: parent.variantKey,
          // Always an explicit device list: the parent's own audience has
          // already been split, so a child must never re-resolve it.
          targetType: 'devices',
          targetDeviceIds: wave.ids,
          segmentId: parent.segmentId,
          totalTokens: wave.ids.length,
          processedTokens: 0,
          successCount: 0,
          failureCount: 0,
          scheduledAt: shiftOutOfQuietHours(
            nextLocalOccurrence(wave.time, zone, now),
            zone,
            config?.quietHoursStart ?? null,
            config?.quietHoursEnd ?? null,
          ),
          status: 'scheduled',
        } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity,
      );
    }

    if (children.length === 0) {
      this.logger.warn(
        `Campaign ${parent.id} expanded to no timezones — its audience had no reachable devices`,
      );
      return;
    }

    await this.logRepository.save(children);
    this.logger.log(
      `Campaign ${parent.id} split into ${children.length} timezone wave(s)`,
    );
  }

  /**
   * Claims due campaigns and enqueues them.
   *
   * The claim is a single conditional UPDATE, so concurrent API instances
   * cannot both promote the same campaign — whichever loses the race matches
   * zero rows.
   *
   * Claim happens *before* the enqueue, and the order matters. `jobId` dedup
   * looks like it would make the reverse order safe, but `removeOnComplete`
   * evicts finished jobs, so a re-add after eviction creates a genuinely new
   * job rather than being deduplicated. Claiming first means the worst case is
   * a campaign stuck in `queued` with no job — which the reconciliation sweep
   * surfaces as a failure — instead of one campaign sent to the whole audience
   * twice.
   */
  async promoteDueCampaigns(): Promise<number> {
    const claimed = await this.logRepository
      .createQueryBuilder()
      .update(PushNotificationLogEntity)
      .set({ status: 'queued' })
      .where('status = :status', { status: 'scheduled' })
      .andWhere('scheduled_at <= :now', { now: new Date() })
      // Parents are expanded into children, never sent themselves — sending
      // one would deliver at a single instant to the whole audience, which is
      // the exact opposite of what was asked for.
      .andWhere('deliver_in_recipient_timezone = false')
      // Sending an experiment parent directly would deliver one arm's copy to
      // the whole audience and record no variant at all.
      .andWhere('variants IS NULL')
      // A recurring template is never sent itself; it spawns occurrences.
      .andWhere('recurrence IS NULL')
      .returning(['id', 'projectId'])
      .execute();

    const rows = (claimed.raw ?? []) as Array<{
      id: string;
      project_id?: string;
      projectId?: string;
    }>;

    let promoted = 0;

    for (const row of rows) {
      const projectId = row.projectId ?? row.project_id;
      if (!projectId) continue;

      try {
        await this.pushQueue.add(
          JOB_DISPATCH_CAMPAIGN,
          { logId: row.id, projectId },
          { jobId: row.id },
        );
        promoted += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Failed to enqueue scheduled campaign ${row.id}: ${detail}. Returning it to scheduled so the next tick retries.`,
        );
        // Hand it back rather than leaving it stranded in `queued` with no job.
        // If this write also fails the reconciliation sweep still catches it.
        await this.logRepository
          .update({ id: row.id, status: 'queued' }, { status: 'scheduled' })
          .catch(() => undefined);
      }
    }

    return promoted;
  }
}
