import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushNotificationEventEntity } from './entities/push-notification-event.entity';
import {
  PushNotificationLogEntity,
  NotificationStatus,
} from './entities/push-notification-log.entity';
import { MAX_FAILURE_DETAILS } from '../../queue/queue.constants';
import { logValue } from '../../common/log-value';

export interface BatchOutcome {
  successCount: number;
  failureCount: number;
  failures: Array<{ token: string; error: string }>;
  lastTokenId: string;
  processedInBatch: number;
}

/**
 * The live column plus the batch's failures, in order, at most
 * `MAX_FAILURE_DETAILS`. A new entry is kept only while its token is still
 * held in the campaign's project, by a device's email or number or by a push
 * token: a batch that started before a person erasure must not write the
 * erased address back after the erasure scrubbed it. FOR KEY SHARE makes the
 * check wait for an erasure holding those rows and then see them gone: under
 * READ COMMITTED a plain EXISTS would read the statement's snapshot, from
 * before the erasure committed.
 */
export const APPEND_FAILURE_DETAILS = `(SELECT COALESCE(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
  FROM (SELECT entry, position
        FROM (SELECT entry, position FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(failure_details) = 'array' THEN failure_details ELSE '[]'::jsonb END)
                WITH ORDINALITY AS existing(entry, position)
              UNION ALL
              SELECT entry, 1000000 + position FROM jsonb_array_elements(CAST(:newFailures AS jsonb))
                WITH ORDINALITY AS incoming(entry, position)
              WHERE EXISTS (SELECT 1 FROM device_identities d
                            WHERE d.project_id = push_notification_logs.project_id
                              AND (d.email = incoming.entry->>'token' OR d.phone_e164 = incoming.entry->>'token')
                            FOR KEY SHARE)
                 OR EXISTS (SELECT 1 FROM push_tokens t
                            WHERE t.project_id = push_notification_logs.project_id
                              AND t.token = incoming.entry->>'token'
                            FOR KEY SHARE)) AS appended
        ORDER BY position
        LIMIT :maxFailures) AS kept)`;

@Injectable()
export class PushCampaignStateService {
  private readonly logger = new Logger(PushCampaignStateService.name);

  constructor(
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(PushNotificationEventEntity)
    private readonly eventRepository: Repository<PushNotificationEventEntity>,
  ) {}

  async markSending(logId: string): Promise<void> {
    await this.logRepository.update(logId, { status: 'sending' });
  }

  /**
   * Applies one batch's outcome to the log row.
   *
   * `successCount`, `failureCount`, and `processedTokens` are written as an
   * atomic SQL increment (`success_count = success_count + :successDelta`,
   * etc.) rather than a value computed in TypeScript from a prior read. That
   * makes the counters safe under concurrent delivery of the same campaign —
   * e.g. a BullMQ stalled-job reclaim replaying a batch, or a second worker
   * replica — with no lost-update risk on the exact counts `finalize()`
   * depends on to pick `sent` / `failed` / `partial`.
   *
   * `failureDetails` is appended in SQL too (existing entries first, then the
   * batch's, capped at `MAX_FAILURE_DETAILS`), never read here and written
   * back: a person erasure scrubs entries carrying the person's address from
   * this column, and a batch that had read the column before the scrub would
   * otherwise write the address back after it. New entries whose address is
   * no longer held in the project are dropped for the same reason.
   */
  /**
   * Records that a campaign was sent to these devices.
   *
   * The only per-recipient record of who a campaign reached, and what
   * frequency capping counts. Written in one bulk insert per page, and
   * `orIgnore` makes it idempotent against the unique
   * (campaign, device, type) index — so a resumed campaign re-walking a page
   * cannot double-count someone's frequency budget.
   *
   * Failures are logged and swallowed: losing a cap record is a smaller harm
   * than failing a page that FCM has already accepted, which would re-send to
   * everyone on it.
   */
  async recordSentRecipients(
    log: PushNotificationLogEntity,
    deviceIdentityIds: string[],
  ): Promise<void> {
    if (deviceIdentityIds.length === 0) return;

    const occurredAt = new Date();
    try {
      await this.eventRepository
        .createQueryBuilder()
        .insert()
        .into(PushNotificationEventEntity)
        .values(
          deviceIdentityIds.map((deviceIdentityId) => ({
            projectId: log.projectId,
            campaignId: log.id,
            deviceIdentityId,
            type: 'sent' as const,
            occurredAt,
            platform: null,
            metadata: null as never,
          })),
        )
        .orIgnore()
        .execute();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(
        `Could not record sent recipients for campaign ${log.id}: ${logValue(detail)}`,
      );
    }
  }

  /** A missing row (a deleted campaign) matches nothing, so this is a no-op for it. */
  async recordBatch(logId: string, outcome: BatchOutcome): Promise<void> {
    await this.logRepository
      .createQueryBuilder()
      .update(PushNotificationLogEntity)
      .set({
        successCount: () => 'success_count + :successDelta',
        failureCount: () => 'failure_count + :failureDelta',
        processedTokens: () => 'processed_tokens + :processedDelta',
        lastTokenId: outcome.lastTokenId,
        failureDetails: () => APPEND_FAILURE_DETAILS,
      })
      .where('id = :id', { id: logId })
      .setParameters({
        successDelta: outcome.successCount,
        failureDelta: outcome.failureCount,
        processedDelta: outcome.processedInBatch,
        newFailures: JSON.stringify(outcome.failures.slice(0, MAX_FAILURE_DETAILS)),
        maxFailures: MAX_FAILURE_DETAILS,
      })
      .execute();
  }

  /**
   * Derives the campaign's terminal status from the counters, which are the
   * only honest record of what happened.
   *
   * The zero/zero case is real, not defensive: every target token can be
   * deactivated between enqueue and dispatch, which empties page 1, ends the
   * walk immediately, and leaves `failureCount === 0` — so a campaign that
   * reached nobody would otherwise be reported `sent` with 0/N delivered.
   */
  async finalize(logId: string): Promise<NotificationStatus> {
    const log = await this.logRepository.findOne({ where: { id: logId } });
    if (!log) {
      throw new Error(`Push campaign log ${logId} not found`);
    }

    let status: NotificationStatus;
    let errorMessage: string | undefined;

    if (log.successCount === 0 && log.failureCount === 0) {
      status = 'failed';
      errorMessage = this.nothingDeliveredReason(log);
    } else if (log.successCount === 0) {
      status = 'failed';
    } else if (log.failureCount === 0) {
      status = 'sent';
    } else {
      status = 'partial';
    }

    await this.logRepository.update(logId, {
      status,
      completedAt: new Date(),
      ...(errorMessage ? { errorMessage } : {}),
    });

    return status;
  }

  /**
   * Why a campaign delivered nothing.
   *
   * This used to be one sentence blaming expired tokens, which is the wrong
   * place to send an operator whose token table is full. A project with no
   * configured channel — or whose devices are registered only on channels it
   * holds no credentials for — empties the first page for a completely
   * different reason, and "no active push tokens remained" then reads as a
   * confident, checkable, wrong statement. Observed against a project with 26
   * active FCM tokens and no credentials.
   *
   * `totalTokens` is the audience counted when the campaign was written,
   * before any credential restriction applies, so an audience that was
   * non-empty and processed nothing means the tokens were there and none of
   * them were sendable. That distinction is the whole value of the message.
   */
  private nothingDeliveredReason(log: PushNotificationLogEntity): string {
    if (log.channel === 'email') {
      return (
        'Nothing was delivered: by the time this campaign ran, nobody in its audience ' +
        'could be emailed. People may have unsubscribed, bounced, withdrawn consent or ' +
        'reached the frequency cap since it was created.'
      );
    }
    if (log.channel === 'whatsapp') {
      return (
        'Nothing was delivered: by the time this campaign ran, nobody in its audience ' +
        'could be messaged on WhatsApp. People may have opted out, withdrawn consent, ' +
        'turned out not to be on WhatsApp, or reached the frequency cap since it was created.'
      );
    }
    if (log.channel === 'sms') {
      return (
        'Nothing was delivered: by the time this campaign ran, nobody in its audience ' +
        'could be texted. People may have replied STOP, withdrawn consent, had their ' +
        'number fail, or reached the frequency cap since it was created.'
      );
    }
    if (log.totalTokens > 0 && log.processedTokens === 0) {
      return (
        `Nothing was delivered: this campaign had ${log.totalTokens} target token(s), ` +
        'but none of them could be sent through a configured channel. Check that ' +
        'credentials exist for the channels those devices are registered on.'
      );
    }
    return 'Nothing was delivered: no active push tokens remained for this campaign at dispatch time.';
  }

  /**
   * Ends a campaign that could not run to completion — bad credentials,
   * exhausted retries, or a reconciliation sweep finding it abandoned.
   *
   * The status still comes from the counters rather than from the fact that we
   * are on an error path: a campaign that delivered 900 of 1000 before dying is
   * `partial`, and `errorMessage` is what explains the missing 100. Only a
   * campaign that delivered nothing is `failed`.
   */
  async markFailed(logId: string, message: string): Promise<NotificationStatus> {
    const log = await this.logRepository.findOne({ where: { id: logId } });
    const status: NotificationStatus =
      (log?.successCount ?? 0) > 0 ? 'partial' : 'failed';

    await this.logRepository.update(logId, {
      status,
      errorMessage: message.slice(0, 2000),
      completedAt: new Date(),
    });

    return status;
  }
}
