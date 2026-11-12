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

    const recorded = rows
      .map((row) => ({
        address: row.address,
        consentSource: consentSourceOfSuppression(channel, row.reason, source, verified),
      }))
      .filter(
        (row): row is { address: string; consentSource: ConsentSource } =>
          !!row.consentSource && channel !== 'push',
      );

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

      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(ChannelSuppressionEntity)
        .values(rows)
        .orIgnore()
        .returning(['address'])
        .execute();

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
    { onlyReason, requester = null }: { onlyReason?: SuppressionReason; requester?: ActivityRequester | null } = {},
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
