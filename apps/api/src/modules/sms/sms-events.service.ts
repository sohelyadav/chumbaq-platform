import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushNotificationEventEntity } from '../push-notifications/entities/push-notification-event.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { SmsEvent } from './twilio-webhooks';

/**
 * Records SMS delivery reports and opt-out replies.
 *
 * Into the shared events table, as email does, so a campaign's report and
 * its experiment read-out need no SMS-specific code. A failed delivery is
 * stored as `bounced`, which is what it is for a text.
 */
@Injectable()
export class SmsEventsService {
  constructor(
    @InjectRepository(PushNotificationEventEntity)
    private readonly eventRepository: Repository<PushNotificationEventEntity>,
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    private readonly suppressions: SuppressionsService,
  ) {}

  async ingest(projectId: string, source: string, event: SmsEvent): Promise<number> {
    // Suppression first, and whether or not the report names a campaign: a
    // dead number found by a test send is just as dead for the next campaign.
    if (event.type === 'unsubscribed' || (event.type === 'bounced' && event.permanent)) {
      await this.suppressions.suppress(
        projectId,
        'sms',
        [
          {
            address: event.address,
            reason: event.type === 'unsubscribed' ? 'unsubscribed' : 'bounced',
            detail: event.detail ?? null,
          },
        ],
        source,
      );
    }

    if (event.type === 'unsubscribed' || !event.campaignId || !event.identityId) return 0;

    // The callback URL is Chumbaq's and Twilio signed it, but the campaign
    // must still belong to the project the token found: the token, not the
    // query string, is what identifies the project.
    const owned = await this.logRepository.exists({
      where: { id: event.campaignId, projectId, channel: 'sms' },
    });
    if (!owned) return 0;

    await this.eventRepository
      .createQueryBuilder()
      .insert()
      .into(PushNotificationEventEntity)
      .values({
        projectId,
        campaignId: event.campaignId,
        deviceIdentityId: event.identityId,
        type: event.type,
        platform: 'sms',
        occurredAt: event.occurredAt,
        metadata: event.detail ? { detail: event.detail.slice(0, 500) } : null,
      } as never)
      .orIgnore()
      .execute();
    return 1;
  }

  /** A STOP or START reply. */
  async keyword(
    projectId: string,
    source: string,
    action: 'opt_out' | 'opt_in',
    address: string,
  ): Promise<void> {
    if (action === 'opt_out') {
      await this.suppressions.suppress(
        projectId,
        'sms',
        [{ address, reason: 'unsubscribed', detail: 'Replied STOP' }],
        source,
      );
      return;
    }
    await this.suppressions.remove(projectId, 'sms', address, { onlyReason: 'unsubscribed' });
  }
}
