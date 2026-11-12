import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PushNotificationEventEntity } from '../push-notifications/entities/push-notification-event.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { EmailEvent } from './email-webhooks';
import { SuppressionsService } from '../push-notifications/suppressions.service';

/**
 * Records provider delivery events.
 *
 * Into the same events table as push engagement, so an email campaign's
 * report, its experiment read-out and the frequency cap all work without a
 * second code path. Opens are stored as `impression`, which is what an open
 * is: the message was seen.
 */
@Injectable()
export class EmailEventsService {
  private readonly logger = new Logger(EmailEventsService.name);

  constructor(
    @InjectRepository(PushNotificationEventEntity)
    private readonly eventRepository: Repository<PushNotificationEventEntity>,
    @InjectRepository(PushNotificationLogEntity)
    private readonly logRepository: Repository<PushNotificationLogEntity>,
    @InjectRepository(DeviceIdentityEntity)
    private readonly identityRepository: Repository<DeviceIdentityEntity>,
    private readonly suppressions: SuppressionsService,
  ) {}

  /**
   * @param signed whether the provider proved it sent these (Resend's Svix
   *   signature, SES's SNS signature). Brevo does not sign its webhooks, so
   *   for Brevo the secret URL is the only proof, and every event is also
   *   checked against what Chumbaq itself knows: a suppression must be for an
   *   address someone in this project actually has, and engagement must name
   *   a person whose address is the one the event is about. A leaked URL then
   *   cannot be used to suppress arbitrary addresses or inflate a campaign
   *   with made-up people.
   */
  async ingest(
    projectId: string,
    source: string,
    events: EmailEvent[],
    { signed }: { signed: boolean } = { signed: true },
  ): Promise<number> {
    if (events.length === 0) return 0;
    if (!signed) events = await this.corroborate(projectId, events);
    if (events.length === 0) return 0;

    // Suppression first, and regardless of whether the event can be tied to
    // a campaign: a hard bounce from a test send, or from mail sent outside
    // Chumbaq through the same account, still means the inbox is gone.
    await this.suppressions.suppress(
      projectId,
      'email',
      events
        .filter(
          (event) =>
            (event.type === 'bounced' && event.permanent) ||
            event.type === 'complained' ||
            event.type === 'unsubscribed',
        )
        .map((event) => ({
          address: event.address,
          reason:
            event.type === 'complained'
              ? ('complained' as const)
              : event.type === 'unsubscribed'
                ? ('unsubscribed' as const)
                : ('bounced' as const),
          detail: event.detail ?? null,
        })),
      source,
      // Unsigned (Brevo): still honoured, recorded in consent history as
      // unconfirmed (`provider_unsubscribe_unsigned`, `complaint_unsigned`).
      { verified: signed },
    );

    // A tag names a campaign, but only campaigns of this project may be
    // written to: the webhook token identifies the project, the tag does not.
    const campaignIds = [
      ...new Set(events.map((event) => event.campaignId).filter((id): id is string => !!id)),
    ];
    if (campaignIds.length === 0) return 0;

    const owned = new Set(
      (
        await this.logRepository.find({
          where: { id: In(campaignIds), projectId, channel: 'email' },
          select: ['id'],
        })
      ).map((log) => log.id),
    );

    const rows = events
      // An unsubscribe is a suppression only; there is no event type for it.
      .filter((event) => event.type !== 'unsubscribed')
      .filter((event) => event.campaignId && event.identityId && owned.has(event.campaignId))
      .map((event) => ({
        projectId,
        campaignId: event.campaignId!,
        deviceIdentityId: event.identityId!,
        type: event.type,
        platform: 'email',
        occurredAt: event.occurredAt,
        metadata: event.detail ? { detail: event.detail.slice(0, 500) } : null,
      }));

    if (rows.length === 0) return 0;

    // One row per (campaign, person, type), as for push: providers retry
    // webhooks, and an open pixel fires on every view.
    await this.eventRepository
      .createQueryBuilder()
      .insert()
      .into(PushNotificationEventEntity)
      .values(rows as never)
      .orIgnore()
      .execute();

    return rows.length;
  }

  /**
   * Keeps only the unsigned events Chumbaq's own data agrees with.
   *
   * A tagged event survives when the tagged person belongs to this project
   * and holds the address the event is about; its tags are trusted no
   * further than that. An untagged event survives only as a suppression of
   * an address someone in the project has.
   */
  private async corroborate(projectId: string, events: EmailEvent[]): Promise<EmailEvent[]> {
    const addresses = [...new Set(events.map((event) => event.address))];
    const known = await this.identityRepository.find({
      where: { projectId, email: In(addresses) },
      select: ['id', 'email'],
    });
    const emailOf = new Map(known.map((identity) => [identity.id, identity.email]));
    const knownAddresses = new Set(known.map((identity) => identity.email));

    return events.flatMap((event): EmailEvent[] => {
      if (!knownAddresses.has(event.address)) return [];
      if (event.identityId && emailOf.get(event.identityId) === event.address) return [event];
      // The address is real but the tags do not check out: keep what the
      // event says about the inbox, drop what it claims about a campaign.
      return [{ ...event, campaignId: null, identityId: null }];
    });
  }
}
