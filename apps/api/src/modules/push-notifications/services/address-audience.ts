import { Repository, SelectQueryBuilder } from 'typeorm';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';
import { MessageChannel } from '../message-channel';

/**
 * Who a campaign on an addressed channel (email, SMS) may reach.
 *
 * `deviceIdentityIds` null means the whole project; an array (even an empty
 * one) means exactly those identities. The two are kept distinct on purpose:
 * the push worker once let a narrowed audience fall through to the whole
 * project, and an empty list here must reach nobody.
 */
export interface AddressAudienceScope {
  projectId: string;
  deviceIdentityIds: string[] | null;
  /** From the channel's settings: only explicit opt-ins, or everyone not opted out. */
  requireOptIn: boolean;
}

/**
 * Where a channel's addresses and consent live on `device_identities`.
 * Constants chosen in code, never input: they are written into SQL.
 */
export interface AddressColumns {
  channel: Exclude<MessageChannel, 'push'>;
  /** Normalised address column: `email`, `phone_e164`. */
  address: 'email' | 'phone_e164';
  /** Nullable consent flag: `email_opt_in`, `sms_opt_in`, `whatsapp_opt_in`. */
  consent: 'email_opt_in' | 'sms_opt_in' | 'whatsapp_opt_in';
}

/**
 * The addressed-channel counterpart of the push token readers.
 *
 * Every question the scheduler and worker ask about a push audience — how
 * many, which people for an experiment split, grouped by timezone, the next
 * page to deliver — has an answer here built on one eligibility predicate, so
 * the number a marketer previews is produced by the same SQL that decides who
 * is sent to.
 *
 * Eligible means: the identity has an address, the address is not
 * suppressed, consent satisfies the project's policy, and — for the
 * deduplication that makes one inbox or one phone get one message — no
 * lower-id identity in the same scope is eligible for the same address.
 */
export abstract class AddressAudience {
  protected abstract readonly columns: AddressColumns;

  constructor(protected readonly identityRepository: Repository<DeviceIdentityEntity>) {}

  /** Recipients a send would reach, under the frequency cap. */
  async count(scope: AddressAudienceScope, frequencyCap: number | null): Promise<number> {
    const qb = this.eligible(scope);
    if (!qb) return 0;
    this.applyFrequencyCap(qb, frequencyCap, null);
    return qb.getCount();
  }

  /**
   * One identity per reachable address, for splitting an experiment.
   *
   * An arm is then made of these representatives, so a person with two
   * devices cannot land in two arms and receive both versions.
   */
  async listRecipientIds(scope: AddressAudienceScope): Promise<string[]> {
    const qb = this.eligible(scope);
    if (!qb) return [];
    const rows = await qb.select('i.id', 'id').getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }

  /**
   * Reachable representatives grouped by their timezone. Identities with no
   * known timezone fall under the fallback rather than being dropped.
   */
  async groupByTimezone(
    scope: AddressAudienceScope,
    fallbackTimezone: string,
  ): Promise<Map<string, string[]>> {
    const qb = this.eligible(scope);
    if (!qb) return new Map();

    const rows = await qb
      .select('i.id', 'id')
      .addSelect('COALESCE(i.timezone, :fallback)', 'timezone')
      .setParameter('fallback', fallbackTimezone)
      .getRawMany<{ id: string; timezone: string }>();

    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.timezone) ?? [];
      bucket.push(row.id);
      grouped.set(row.timezone, bucket);
    }
    return grouped;
  }

  /**
   * The next page of recipients, by keyset on identity id.
   *
   * Same resumability contract as the token walk: ordering by primary key and
   * seeking past the checkpoint stays correct while suppressions are added
   * mid-campaign, which an offset would not.
   */
  async page(
    scope: AddressAudienceScope,
    afterId: string | null,
    limit: number,
    frequencyCap: number | null,
    currentCampaignId: string,
  ): Promise<DeviceIdentityEntity[]> {
    const qb = this.eligible(scope);
    if (!qb) return [];

    this.applyFrequencyCap(qb, frequencyCap, currentCampaignId);
    if (afterId) qb.andWhere('i.id > :afterId', { afterId });

    return qb.orderBy('i.id', 'ASC').limit(limit).getMany();
  }

  /**
   * The shared predicate. Returns null for a scope that can reach nobody,
   * because `IN ()` is not valid SQL and "no ids" must not mean "no filter".
   */
  private eligible(
    scope: AddressAudienceScope,
  ): SelectQueryBuilder<DeviceIdentityEntity> | null {
    const ids = scope.deviceIdentityIds;
    if (ids !== null && ids.length === 0) return null;

    const { channel, address, consent: optIn } = this.columns;
    const consent = (alias: string) =>
      scope.requireOptIn
        ? `${alias}.${optIn} = true`
        : `${alias}.${optIn} IS DISTINCT FROM false`;
    const inScope = (alias: string) =>
      ids === null ? '' : `AND ${alias}.id = ANY(:ids::uuid[])`;

    const qb = this.identityRepository
      .createQueryBuilder('i')
      .where('i.project_id = :projectId', { projectId: scope.projectId })
      .andWhere(`i.${address} IS NOT NULL`)
      .andWhere(consent('i'))
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM channel_suppressions s
          WHERE s.project_id = i.project_id
            AND s.channel = :channel
            AND s.address = i.${address}
        )`,
        { channel },
      )
      // One message per address. The better row must itself be eligible and in
      // scope: an opted-out or out-of-audience twin with a lower id would
      // otherwise suppress the one identity that should receive it, leaving
      // the address unreached.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM device_identities b
          WHERE b.project_id = i.project_id
            AND b.${address} = i.${address}
            AND b.id < i.id
            AND ${consent('b')}
            ${inScope('b')}
        )`,
      );

    if (ids !== null) {
      qb.andWhere('i.id = ANY(:ids::uuid[])', { ids });
    }

    return qb;
  }

  /**
   * Excludes people already sent `cap` campaigns in the last 24 hours, on
   * any channel.
   *
   * The same count the push token readers apply, over the same `sent`
   * events. Email and SMS write those events against the identity they
   * delivered to, so one cap covers every channel: someone who got two pushes
   * today does not also get a third message by email or text.
   */
  private applyFrequencyCap(
    qb: SelectQueryBuilder<DeviceIdentityEntity>,
    cap: number | null,
    currentCampaignId: string | null,
  ): void {
    if (cap === null || cap === undefined) return;

    qb.andWhere(
      `(
        SELECT COUNT(DISTINCT e.campaign_id)
        FROM push_notification_events e
        WHERE e.device_identity_id = i.id
          AND e.type = 'sent'
          AND e.occurred_at > NOW() - INTERVAL '24 hours'
          AND (:currentCampaignId::uuid IS NULL OR e.campaign_id <> :currentCampaignId::uuid)
      ) < :cap`,
      { cap, currentCampaignId },
    );
  }
}
