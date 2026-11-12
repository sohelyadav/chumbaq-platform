import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PushNotificationEventEntity } from '../push-notifications/entities/push-notification-event.entity';
import { PushNotificationLogEntity } from '../push-notifications/entities/push-notification-log.entity';
import { SuppressionsService } from '../push-notifications/suppressions.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { WhatsAppEvent } from './providers/whatsapp-provider';

/**
 * Opt-out and opt-in keywords. WhatsApp has no carrier-level STOP the way
 * SMS does, so these are Chumbaq's to honour: a person who writes STOP to a
 * business and keeps getting marketing reports it, and reports cut the
 * sender's quality rating and messaging limit.
 */
const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT']);
const START_KEYWORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'OPTIN', 'OPT IN']);

export function keywordOf(text: string): 'opt_out' | 'opt_in' | null {
  const word = text
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  if (STOP_KEYWORDS.has(word)) return 'opt_out';
  if (START_KEYWORDS.has(word)) return 'opt_in';
  return null;
}

/**
 * Records WhatsApp delivery reports and acts on replies.
 *
 * Into the shared events table, so a campaign's report and its experiment
 * read-out work unchanged: delivered is `delivered`, read is `impression`
 * (it was seen), failed is `bounced`.
 */
@Injectable()
export class WhatsAppEventsService {
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
   * @param suppressingErrors the provider's codes meaning the person will
   *   not take WhatsApp marketing from this business.
   * @param signed false for a provider that does not sign its webhooks
   *   (Gupshup): every event is then checked against the project's own
   *   people, as Brevo's are, so a leaked URL cannot suppress arbitrary
   *   numbers or invent engagement.
   * @param attributeByRecency for a provider whose reports cannot carry the
   *   campaign (Gupshup): a report is credited to the latest WhatsApp
   *   campaign sent to that number in the past week.
   */
  async ingest(
    projectId: string,
    source: string,
    events: WhatsAppEvent[],
    suppressingErrors: ReadonlyMap<string, 'unsubscribed' | 'bounced'>,
    { signed, attributeByRecency = false }: { signed: boolean; attributeByRecency?: boolean },
  ): Promise<number> {
    if (events.length === 0) return 0;
    if (!signed) events = await this.corroborate(projectId, events);
    if (attributeByRecency) events = await this.attribute(projectId, events);
    if (events.length === 0) return 0;

    // Replies: STOP suppresses, START lifts a STOP and nothing else — and
    // only when the provider signed it.
    for (const event of events) {
      if (event.kind !== 'inbound') continue;
      const keyword = keywordOf(event.text);
      if (keyword === 'opt_out') {
        await this.suppressions.suppress(
          projectId,
          'whatsapp',
          [{ address: event.address, reason: 'unsubscribed', detail: `Replied "${event.text.slice(0, 40)}"` }],
          source,
          // Recorded as `stop_reply_unsigned` in consent history when unsigned.
          { verified: signed },
        );
      } else if (keyword === 'opt_in' && signed) {
        // Only a provider-signed START may lift a STOP. An unsigned event
        // can come from anyone who learned the webhook URL, and must never
        // re-subscribe someone who opted out; it may only add protection.
        await this.suppressions.remove(projectId, 'whatsapp', event.address, { onlyReason: 'unsubscribed' });
      }
    }

    const statuses = events.filter(
      (event): event is Extract<WhatsAppEvent, { kind: 'status' }> => event.kind === 'status',
    );

    const suppress = statuses.flatMap((event) => {
      const reason = event.errorCode ? suppressingErrors.get(event.errorCode) : undefined;
      return event.status === 'failed' && reason
        ? [{ address: event.address, reason, detail: event.detail ?? `Error ${event.errorCode}` }]
        : [];
    });
    if (suppress.length > 0) {
      await this.suppressions.suppress(projectId, 'whatsapp', suppress, source, { verified: signed });
    }

    const campaignIds = [
      ...new Set(statuses.map((event) => event.campaignId).filter((id): id is string => !!id)),
    ];
    if (campaignIds.length === 0) return 0;

    // The webhook token identifies the project; the campaign id in a
    // report does not, so only this project's campaigns are written to.
    const owned = new Set(
      (
        await this.logRepository.find({
          where: { id: In(campaignIds), projectId, channel: 'whatsapp' },
          select: ['id'],
        })
      ).map((log) => log.id),
    );

    const rows = statuses
      .filter((event) => event.campaignId && event.identityId && owned.has(event.campaignId))
      .map((event) => ({
        projectId,
        campaignId: event.campaignId!,
        deviceIdentityId: event.identityId!,
        type:
          event.status === 'read'
            ? ('impression' as const)
            : event.status === 'failed'
              ? ('bounced' as const)
              : ('delivered' as const),
        platform: 'whatsapp',
        occurredAt: event.occurredAt,
        metadata: event.detail || event.errorCode
          ? { detail: String(event.detail ?? event.errorCode).slice(0, 500) }
          : null,
      }));
    if (rows.length === 0) return 0;

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
   * Credits untagged reports to the most recent WhatsApp campaign sent to
   * that number within seven days.
   *
   * An approximation, used only where the provider gives no other way: two
   * WhatsApp campaigns to one person inside a report's lifetime could be
   * confused. The frequency cap makes that rare, and an unattributed report
   * would otherwise be lost entirely.
   */
  private async attribute(projectId: string, events: WhatsAppEvent[]): Promise<WhatsAppEvent[]> {
    const untagged = events.filter(
      (event) => event.kind === 'status' && !event.campaignId,
    );
    if (untagged.length === 0) return events;

    const numbers = [...new Set(untagged.map((event) => event.address))];
    const rows: Array<{ address: string; campaign_id: string; identity_id: string }> =
      await this.eventRepository.query(
        `SELECT DISTINCT ON (i.phone_e164)
                i.phone_e164 AS address, e.campaign_id, e.device_identity_id AS identity_id
         FROM push_notification_events e
         JOIN device_identities i ON i.id = e.device_identity_id
         JOIN push_notification_logs l ON l.id = e.campaign_id
         WHERE e.project_id = $1
           AND e.type = 'sent'
           AND l.channel = 'whatsapp'
           AND e.occurred_at > NOW() - INTERVAL '7 days'
           AND i.phone_e164 = ANY($2::text[])
         ORDER BY i.phone_e164, e.occurred_at DESC`,
        [projectId, numbers],
      );
    const latest = new Map(rows.map((row) => [row.address, row]));

    return events.map((event) => {
      if (event.kind !== 'status' || event.campaignId) return event;
      const match = latest.get(event.address);
      return match
        ? { ...event, campaignId: match.campaign_id, identityId: match.identity_id }
        : event;
    });
  }

  /** Keeps only unsigned events whose number belongs to someone in the project. */
  private async corroborate(projectId: string, events: WhatsAppEvent[]): Promise<WhatsAppEvent[]> {
    const numbers = [...new Set(events.map((event) => event.address))];
    const known = await this.identityRepository.find({
      where: { projectId, phoneE164: In(numbers) },
      select: ['id', 'phoneE164'],
    });
    const numberOf = new Map(known.map((identity) => [identity.id, identity.phoneE164]));
    const knownNumbers = new Set(known.map((identity) => identity.phoneE164));

    return events.flatMap((event): WhatsAppEvent[] => {
      if (!knownNumbers.has(event.address)) return [];
      if (event.kind === 'inbound') return [event];
      if (event.identityId && numberOf.get(event.identityId) === event.address) return [event];
      return [{ ...event, campaignId: null, identityId: null }];
    });
  }
}
