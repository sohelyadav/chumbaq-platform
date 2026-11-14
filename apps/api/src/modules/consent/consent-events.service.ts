import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  ConsentChannel,
  ConsentEventEntity,
  ConsentSource,
} from './entities/consent-event.entity';

export interface ConsentChange {
  projectId: string;
  deviceIdentityId: string;
  channel: ConsentChannel;
  granted: boolean;
  source: ConsentSource;
}

/** The channels whose consent can be withdrawn against an address rather than a person. */
export type AddressedConsentChannel = 'email' | 'sms' | 'whatsapp';

/**
 * The only writer of `consent_events`. Append-only: nothing here updates or
 * deletes a row (erasure removes them through the identity's cascade).
 */
@Injectable()
export class ConsentEventsService {
  constructor(
    @InjectRepository(ConsentEventEntity)
    private readonly repository: Repository<ConsentEventEntity>,
  ) {}

  /**
   * Records changes to one or more people's consent.
   *
   * Pass `manager` to write in the same transaction as the change itself, so
   * a flag can never change without its history row, nor the reverse.
   */
  async record(changes: ConsentChange[], manager?: EntityManager): Promise<void> {
    if (changes.length === 0) return;
    const repository = manager ? manager.getRepository(ConsentEventEntity) : this.repository;
    await repository
      .createQueryBuilder()
      .insert()
      .into(ConsentEventEntity)
      .values(changes)
      .execute();
  }

  /**
   * Records a change made against an address (an unsubscribe link, a STOP
   * reply, a suppression added by hand) for every identity in the project
   * holding that address, in one statement.
   *
   * `address` must already be normalised the way the channel's recipient
   * column is (`normaliseAddress`). An address nobody in the project holds
   * records nothing: the `channel_suppressions` row is then the only record,
   * which is right, since there is no person here to prove anything about.
   *
   * Rows are inserted in id order, so the foreign key checks take their
   * share locks on the identities in the order an erasure locks them
   * (`resolvePersonScope`), and the two cannot deadlock on each other.
   *
   * @returns how many rows were written.
   */
  async recordForAddress(
    projectId: string,
    channel: AddressedConsentChannel,
    address: string,
    granted: boolean,
    source: ConsentSource,
    manager?: EntityManager,
  ): Promise<number> {
    // Allow-listed, never caller text: the column is chosen from the channel.
    const column = channel === 'email' ? 'email' : 'phone_e164';
    // Not for a holder whose latest entry for the channel already says the same thing
    // from the same source: providers redeliver, webhook bodies repeat an address, and
    // a repeat would add a row per holder each time while saying nothing new.
    const rows: unknown[] = await (manager ?? this.repository.manager).query(
      `INSERT INTO consent_events (project_id, device_identity_id, channel, granted, source)
       SELECT i.project_id, i.id, $3::varchar, $4::boolean, $5::varchar
       FROM device_identities i
       WHERE i.project_id = $1 AND i.${column} = $2
         AND NOT EXISTS (
           SELECT 1 FROM (
             SELECT ce.granted, ce.source FROM consent_events ce
             WHERE ce.project_id = i.project_id AND ce.device_identity_id = i.id AND ce.channel = $3::varchar
             ORDER BY ce.occurred_at DESC, ce.id DESC
             LIMIT 1
           ) latest
           WHERE latest.granted = $4::boolean AND latest.source = $5::varchar
         )
       ORDER BY i.id
       RETURNING id`,
      [projectId, address, channel, granted, source],
    );
    return rows.length;
  }

  /**
   * Records a whole-person do-not-track decision (made or lifted from the
   * dashboard) against every identity in the project claiming that external
   * id, in one statement on the caller's transaction, in id order (see
   * `recordForAddress`).
   */
  async recordForPerson(
    manager: EntityManager,
    projectId: string,
    externalUserId: string,
    granted: boolean,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO consent_events (project_id, device_identity_id, channel, granted, source)
       SELECT i.project_id, i.id, 'tracking', $3, 'dashboard'
       FROM device_identities i
       WHERE i.project_id = $1 AND i.external_user_id = $2
       ORDER BY i.id`,
      [projectId, externalUserId, granted],
    );
  }
}
