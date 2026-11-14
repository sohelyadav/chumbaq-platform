import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { MessageChannel, normaliseAddress } from './message-channel';
import {
  ChannelSuppressionEntity,
  SuppressionReason,
} from './entities/channel-suppression.entity';
import {
  AddressedConsentChannel,
  ConsentEventsService,
} from '../consent/consent-events.service';
import { ConsentSource } from '../consent/entities/consent-event.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import { maskAddress } from '../project-activity/mask-address';
import { ErasedSuppressionsService } from '../privacy/erased-suppressions.service';

/**
 * A team member's suppression change in the activity log: the channel and the
 * address masked (`a***@example.com`, `+91******21`), never the address itself.
 */
function suppressionEntry(
  projectId: string,
  action: 'suppression.added' | 'suppression.removed',
  channel: MessageChannel,
  address: string,
) {
  return { projectId, action, details: { channel, address: maskAddress(address) } };
}

/**
 * Whether adding a suppression is a consent withdrawal worth recording in
 * `consent_events`, and from whom. Null when it is not: a bounce or a dead
 * number says the address does not work, not that its owner said no.
 *
 * `source` is what `suppress` was given: `link`, `dashboard`, or a provider.
 */
export function consentSourceOfSuppression(
  channel: MessageChannel,
  reason: SuppressionReason,
  source: string,
  verified = true,
): ConsentSource | null {
  // Push has no addresses to suppress; its consent is `push_opt_in`.
  if (channel === 'push') return null;
  // Checked before the source: a bounce entered by hand is still a bounce.
  if (reason === 'bounced') return null;
  if (source === 'dashboard') return 'dashboard';
  if (source === 'link') return 'unsubscribe_link';
  // From an unsigned webhook (Brevo for email; Gupshup, or Meta/Interakt with
  // no stored secret, for WhatsApp) the statement is honoured, since it can
  // only add protection, but recorded as unconfirmed: anyone holding the URL
  // could have sent it.
  if (reason === 'complained') return verified ? 'complaint' : 'complaint_unsigned';
  if (reason === 'unsubscribed') {
    // From a provider: a STOP reply for text and WhatsApp (including
    // Twilio's 21610, the carrier's record of one), the provider's own
    // unsubscribe for email. A STOP from an unsigned webhook (Gupshup, or
    // Meta/Interakt without a stored secret) is still honoured, since it can
    // only add protection, but is recorded as unverified.
    if (channel === 'email') return verified ? 'provider_unsubscribe' : 'provider_unsubscribe_unsigned';
    return verified ? 'stop_reply' : 'stop_reply_unsigned';
  }
  return null;
}

@Injectable()
export class SuppressionsService {
  constructor(
    @InjectRepository(ChannelSuppressionEntity)
    private readonly repository: Repository<ChannelSuppressionEntity>,
    private readonly consentEvents: ConsentEventsService,
    private readonly activity: ProjectActivityService,
    private readonly erased: ErasedSuppressionsService,
  ) {}

  /**
   * Suppresses addresses. Idempotent: the first reason recorded for an
   * address stands, because a bounce later reported for an address the
   * person already unsubscribed must not rewrite why it was suppressed.
   *
   * With a `requester` (a team member in the dashboard), each address newly
   * suppressed is written to the project activity log as `suppression.added`,
   * masked, in the same transaction; one already suppressed changes nothing
   * and writes nothing. Provider webhooks and unsubscribe links pass none.
   */
  async suppress(
    projectId: string,
    channel: MessageChannel,
    entries: Array<{ address: string; reason: SuppressionReason; detail?: string | null }>,
    source: string,
    { verified = true, requester = null }: { verified?: boolean; requester?: ActivityRequester | null } = {},
  ): Promise<void> {
    const rows = entries
      .map((entry) => ({ ...entry, address: normaliseAddress(channel, entry.address) }))
      .filter((entry): entry is typeof entry & { address: string } => !!entry.address)
      .map((entry) => ({
        projectId,
        channel,
        address: entry.address,
        reason: entry.reason,
        source,
        detail: entry.detail?.slice(0, 2000) ?? null,
      }));
    if (rows.length === 0) return;

    const seen = new Set<string>();
    const recorded = rows
      .map((row) => ({
        address: row.address,
        consentSource: consentSourceOfSuppression(channel, row.reason, source, verified),
      }))
      .filter(
        (row): row is { address: string; consentSource: ConsentSource } =>
          !!row.consentSource && channel !== 'push',
      )
      // One entry per address and source: a webhook body may name an address many times.
      .filter((row) => {
        const key = `${row.consentSource}\u0000${row.address}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    // One transaction: a suppression never lands without its history, nor
    // the reverse. A failure rolls both back, so a retry (providers retry a
    // 5xx) does both again.
    await this.repository.manager.transaction(async (manager) => {
      // Every holder's device row, FOR KEY SHARE, in one statement in id order,
      // before anything else. The history below would otherwise lock them one
      // address at a time through its foreign key checks, in address order,
      // while an erasure locks the same rows FOR UPDATE in id order: with two
      // people's addresses in one call, each could hold a row the other needs.
      // Taken here, in the erasure's order, one simply waits for the other, and
      // a device erased meanwhile is not there for the history to name.
      if (recorded.length > 0) {
        await this.lockHolders(
          manager,
          projectId,
          channel as AddressedConsentChannel,
          recorded.map((row) => row.address),
        );
      }

      // An erased person's address that nobody holds again is kept as a hash, not put
      // back in clear: see ErasedSuppressionsService.hashUnheld. A team member's own
      // entry stays in clear, since they typed it and need to see it.
      const hashed =
        channel === 'push' || source === 'dashboard'
          ? new Set<string>()
          : await this.erased.hashUnheld(manager, projectId, channel, rows);
      const clear = rows.filter((row) => !hashed.has(row.address));

      const inserted = clear.length
        ? await manager
            .createQueryBuilder()
            .insert()
            .into(ChannelSuppressionEntity)
            .values(clear)
            .orIgnore()
            .returning(['address'])
            .execute()
        : { raw: [] };

      if (requester) {
        for (const { address } of (inserted.raw ?? []) as Array<{ address: string }>) {
          await recordBy(this.activity, requester, suppressionEntry(projectId, 'suppression.added', channel, address), manager);
        }
      }

      // Recorded for every withdrawal, including one for an address that was
      // already suppressed: a STOP after a bounce is still the person saying
      // no, and the history is of what people said, not of table changes.
      for (const row of recorded) {
        await this.consentEvents.recordForAddress(
          projectId,
          channel as AddressedConsentChannel,
          row.address,
          false,
          row.consentSource,
          manager,
        );
      }
    });
  }

  /**
   * Why a test send to this address must not go out, or null. A test send is the
   * marketer checking their own inbox or phone, but nothing proves the address is
   * theirs, so the project's suppression list and an explicit opt-out hold here as
   * they do for campaigns (the push test send does the same for an opted-out device).
   */
  async testSendRefusal(projectId: string, channel: AddressedConsentChannel, address: string): Promise<string | null> {
    const normalised = normaliseAddress(channel, address);
    if (!normalised) return null;
    const suppressed = await this.repository.exists({ where: { projectId, channel, address: normalised } });
    if (suppressed) return 'This address is on the project’s suppression list.';
    // Allow-listed, never caller text: the columns are chosen from the channel.
    const column = channel === 'email' ? 'email' : 'phone_e164';
    const optIn = channel === 'email' ? 'email_opt_in' : channel === 'sms' ? 'sms_opt_in' : 'whatsapp_opt_in';
    const optedOut: unknown[] = await this.repository.manager.query(
      `SELECT 1 FROM device_identities WHERE project_id = $1 AND ${column} = $2 AND ${optIn} = false LIMIT 1`,
      [projectId, normalised],
    );
    return optedOut.length > 0 ? 'This person has opted out of these messages.' : null;
  }

  /** Locks the device rows holding any of these addresses, in id order (see `suppress`). */
  private async lockHolders(
    manager: EntityManager,
    projectId: string,
    channel: AddressedConsentChannel,
    addresses: string[],
  ): Promise<void> {
    // Allow-listed, never caller text: the column is chosen from the channel.
    const column = channel === 'email' ? 'email' : 'phone_e164';
    await manager.query(
      `SELECT id FROM device_identities
       WHERE project_id = $1 AND ${column} = ANY($2::text[])
       ORDER BY id
       FOR KEY SHARE`,
      [projectId, addresses],
    );
  }

  list(
    projectId: string,
    channel: MessageChannel,
    limit = 50,
    offset = 0,
  ): Promise<[ChannelSuppressionEntity[], number]> {
    return this.repository.findAndCount({
      where: { projectId, channel },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Lifts a suppression, for someone who asked to be resubscribed.
   *
   * `onlyReason` narrows it: a START reply lifts the STOP it undoes, but must
   * not lift a number suppressed by hand or because it is dead.
   *
   * With a `requester` (a team member in the dashboard), a lifted suppression
   * is written to the project activity log as `suppression.removed`, masked,
   * in the same transaction. An address that was not suppressed writes nothing.
   */
  async remove(
    projectId: string,
    channel: MessageChannel,
    address: string,
    {
      onlyReason,
      requester = null,
      saidAt,
    }: {
      onlyReason?: SuppressionReason;
      requester?: ActivityRequester | null;
      /**
       * When the person said it (a START reply's own time). The suppression is lifted
       * only if no opt-out of the address was made or recorded after that, so a START
       * redelivered or replayed after a later STOP does not undo the STOP.
       */
      saidAt?: Date;
    } = {},
  ): Promise<boolean> {
    const normalised = normaliseAddress(channel, address);
    if (!normalised) return false;
    return this.repository.manager.transaction(async (manager) => {
      // Same reason and order as in `suppress`.
      if (channel !== 'push') await this.lockHolders(manager, projectId, channel, [normalised]);
      const query = manager
        .createQueryBuilder()
        .delete()
        .from(ChannelSuppressionEntity)
        .where('project_id = :projectId', { projectId })
        .andWhere('channel = :channel', { channel })
        .andWhere('address = :address', { address: normalised });
      if (onlyReason) query.andWhere('reason = :reason', { reason: onlyReason });
      if (saidAt && channel !== 'push') {
        // Allow-listed, never caller text: the column is chosen from the channel.
        const column = channel === 'email' ? 'email' : 'phone_e164';
        // created_at is a timestamp without time zone, written by now() in the session's
        // zone, so the reply's instant is put into that zone before comparing.
        query.andWhere(`created_at <= ((:saidAt)::timestamptz AT TIME ZONE current_setting('TimeZone'))`, { saidAt }).andWhere(
          `NOT EXISTS (
            SELECT 1 FROM consent_events ce
            JOIN device_identities d ON d.id = ce.device_identity_id
            WHERE ce.project_id = :projectId
              AND ce.channel = :channel
              AND ce.granted = false
              AND ce.occurred_at > :saidAt
              AND d.project_id = :projectId
              AND d.${column} = :address
          )`,
        );
      }
      const result = await query.returning(['reason']).execute();
      const removedReasons = ((result.raw ?? []) as Array<{ reason: SuppressionReason }>).map(
        (row) => row.reason,
      );
      const removed = (result.affected ?? removedReasons.length) > 0;

      // Lifting a suppression that recorded someone saying no is consent
      // given back. Two callers exist: a START reply, which lifts only an
      // `unsubscribed` row, and a team member in the dashboard, which lifts
      // any. Lifting a bounce says the address works again, not that anyone
      // agreed to anything, so it is not recorded.
      if (channel !== 'push' && removedReasons.some((reason) => reason !== 'bounced')) {
        await this.consentEvents.recordForAddress(
          projectId,
          channel,
          normalised,
          true,
          onlyReason === 'unsubscribed' ? 'start_reply' : 'dashboard',
          manager,
        );
      }
      if (removed && requester) {
        await recordBy(this.activity, requester, suppressionEntry(projectId, 'suppression.removed', channel, normalised), manager);
      }
      return removed;
    });
  }
}
