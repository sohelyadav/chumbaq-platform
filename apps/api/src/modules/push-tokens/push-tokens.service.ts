import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  PushProvider,
  PushTokenEntity,
  TokenDeactivationReason,
  providerRankSql,
} from './entities/push-token.entity';
import { IdentityService } from '../identity/identity.service';
import { RegisterPushTokenDto } from './dto/register-token.dto';

/**
 * Who a reader looks at: the whole project, or listed devices within it.
 *
 * The project is required in both forms. Device ids come from a campaign's
 * stored `targetDeviceIds`, and a campaign saved before ids were checked at
 * creation can name another tenant's devices; filtering by id alone would
 * count and send to them.
 */
export type AudienceScope =
  | { projectId: string }
  | { projectId: string; deviceIdentityIds: string[] };

@Injectable()
export class PushTokensService {
  constructor(
    @InjectRepository(PushTokenEntity)
    private readonly tokenRepository: Repository<PushTokenEntity>,
    private readonly identityService: IdentityService,
  ) {}

  async registerToken(dto: RegisterPushTokenDto): Promise<PushTokenEntity> {
    const identity = await this.identityService.findByFingerprintAndProject(
      dto.deviceFingerprint,
      dto.projectId,
    );

    if (!identity) {
      throw new NotFoundException(
        'Device identity not found. Call identify() first.',
      );
    }

    let existing = await this.tokenRepository.findOne({
      where: { projectId: dto.projectId, token: dto.token },
    });

    if (existing) {
      existing.deviceIdentityId = identity.id;
      existing.platform = dto.platform;
      existing.provider = dto.provider || 'fcm';
      existing.isActive = true;
      existing.lastUsedAt = new Date();
      // A token coming back was never really gone: the app was reinstalled, or
      // the same token re-registered after a provider rejection. Leaving the
      // old record in place would keep counting it as an uninstall forever.
      existing.deactivatedAt = null;
      existing.deactivationReason = null;
      return this.tokenRepository.save(existing);
    }

    const token = this.tokenRepository.create({
      projectId: dto.projectId,
      deviceIdentityId: identity.id,
      token: dto.token,
      platform: dto.platform,
      provider: dto.provider || 'fcm',
      isActive: true,
    });

    return this.tokenRepository.save(token);
  }

  /**
   * The app asked for this token to stop receiving — a logout or an opt-out.
   *
   * Recorded as `app_requested` so it is never counted as an uninstall: the
   * app is still installed, and conflating the two would make every logout
   * look like a lost user.
   */
  async unregisterToken(projectId: string, token: string): Promise<void> {
    await this.tokenRepository.update(
      { projectId, token },
      this.deactivation('app_requested'),
    );
  }

  /**
   * True when this token is registered in the project to a device that said
   * no to push (`push_opt_in = false`). A token the project has never seen
   * is not opted out: there is no device to ask, and the test-send box
   * exists to paste a token from a developer's own phone.
   */
  async isTokenOptedOut(projectId: string, token: string): Promise<boolean> {
    const row = await this.tokenRepository
      .createQueryBuilder('t')
      .innerJoin('device_identities', 'consent', 'consent.id = t.device_identity_id')
      .where('t.project_id = :projectId', { projectId })
      .andWhere('t.token = :token', { token })
      .andWhere('consent.push_opt_in = false')
      .getOne();
    return row !== null;
  }

  /**
   * Every device identity with a reachable token in scope.
   *
   * Distinct identities rather than tokens: an experiment assigns a *person* to
   * an arm, and someone with a phone and a tablet must not land in two
   * different arms and receive both messages.
   */
  async listDeviceIdentityIds(
    scope: AudienceScope,
  ): Promise<string[]> {
    const qb = this.tokenRepository
      .createQueryBuilder('t')
      .select('DISTINCT t.device_identity_id', 'deviceIdentityId')
      .where('t.is_active = true');
    this.applyPushConsent(qb);

    qb.andWhere('t.project_id = :projectId', { projectId: scope.projectId });
    if ('deviceIdentityIds' in scope) {
      if (scope.deviceIdentityIds.length === 0) return [];
      qb.andWhere('t.device_identity_id IN (:...ids)', {
        ids: scope.deviceIdentityIds,
      });
    }

    const rows = await qb.getRawMany<{ deviceIdentityId: string }>();
    return rows.map((row) => row.deviceIdentityId);
  }

  /**
   * Groups a campaign's reachable devices by the recipient's timezone.
   *
   * Joins identities to tokens so a device that never registered for push is
   * not counted into a wave that would then have nobody to send to. Devices
   * with no known timezone are grouped under the fallback rather than dropped
   * — losing them would silently shrink the audience.
   */
  async groupDeviceIdentitiesByTimezone(
    scope: AudienceScope,
    fallbackTimezone: string,
  ): Promise<Map<string, string[]>> {
    const qb = this.tokenRepository
      .createQueryBuilder('t')
      .innerJoin('device_identities', 'i', 'i.id = t.device_identity_id')
      .select('COALESCE(i.timezone, :fallback)', 'timezone')
      .addSelect('t.device_identity_id', 'deviceIdentityId')
      .where('t.is_active = true')
      .setParameter('fallback', fallbackTimezone)
      .groupBy('COALESCE(i.timezone, :fallback)')
      .addGroupBy('t.device_identity_id');
    this.applyPushConsent(qb);

    qb.andWhere('t.project_id = :projectId', { projectId: scope.projectId });
    if ('deviceIdentityIds' in scope) {
      if (scope.deviceIdentityIds.length === 0) return new Map();
      qb.andWhere('t.device_identity_id IN (:...ids)', {
        ids: scope.deviceIdentityIds,
      });
    }

    const rows = await qb.getRawMany<{
      timezone: string;
      deviceIdentityId: string;
    }>();

    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.timezone) ?? [];
      bucket.push(row.deviceIdentityId);
      grouped.set(row.timezone, bucket);
    }
    return grouped;
  }

  /**
   * Counts reachable tokens, honouring the same frequency cap the page readers
   * apply. The preview a user sees before sending has to come from the same
   * predicate that decides who is actually sent to, or it is a plausible lie.
   */
  async countActiveTokensByProject(
    projectId: string,
    frequencyCap?: number | null,
  ): Promise<number> {
    const qb = this.tokenRepository
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .andWhere('t.is_active = true');

    this.applyPushConsent(qb);
    this.applyFrequencyCap(qb, frequencyCap, null);
    return qb.getCount();
  }

  /**
   * Like every device-id reader here, scoped to the project as well as the
   * ids. A campaign's `targetDeviceIds` is stored, and a scheduled or
   * recurring campaign saved before ids were checked at creation can still
   * name another tenant's devices; the project filter is what keeps those
   * from being counted or sent to.
   */
  async countTokensByDeviceIdentityIds(
    projectId: string,
    deviceIdentityIds: string[],
    frequencyCap?: number | null,
  ): Promise<number> {
    if (deviceIdentityIds.length === 0) return 0;

    const qb = this.tokenRepository
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .andWhere('t.device_identity_id IN (:...ids)', { ids: deviceIdentityIds })
      .andWhere('t.is_active = true');

    this.applyPushConsent(qb);
    this.applyFrequencyCap(qb, frequencyCap, null);
    return qb.getCount();
  }

  /**
   * Excludes devices that have already been sent `cap` campaigns in the last
   * rolling 24 hours.
   *
   * Counts distinct campaigns rather than rows: a campaign that reaches a
   * person on three of their devices is one message from their point of view,
   * and should cost them one slot, not three. The current campaign is excluded
   * from its own count so a resumed walk does not start capping against
   * itself part-way through.
   */
  /**
   * Restricts a page to one token per device — the highest-ranked channel that
   * device is reachable on.
   *
   * Without this a device holding both an FCM token and a vendor token gets
   * two notifications for one campaign. The frequency cap does not catch it:
   * that counts campaigns per device, not sends.
   *
   * Written as a property of the row itself rather than a `DISTINCT ON`,
   * because delivery pages by keyset on `t.id` and checkpoints the cursor so a
   * crashed campaign resumes mid-audience. `DISTINCT ON` reorders the result
   * set and the cursor stops meaning anything; deduplicating within a page is
   * no better, since a device's two tokens can land in different pages and the
   * second page cannot remember the first. A row that can judge its own
   * eligibility composes with both.
   *
   * The id tiebreak is load-bearing. Two tokens of the same provider on one
   * device — a stale row the provider has not rejected yet — would otherwise
   * both qualify, which is the same bug in a narrower form.
   */
  private applyBestTokenPerDevice(
    qb: SelectQueryBuilder<PushTokenEntity>,
    deliverable?: PushProvider[],
  ): void {
    const rank = providerRankSql('better.provider');
    const ownRank = providerRankSql('t.provider');

    // Restricted to channels the project can actually send on, in both halves,
    // and each half matters for a different reason.
    //
    // On the outer query: a device may hold a token for a channel this project
    // has no credentials for — an iOS app registering with APNs while the
    // project is set up only for FCM. Selecting it would fail the whole
    // campaign at the point credentials are read, not merely skip one device.
    //
    // On the subquery: an unconfigured channel must not outrank a configured
    // one either, or a Mi Push token nobody can send through would suppress
    // the FCM token that actually works and leave the device unreachable.
    if (deliverable) {
      // An empty list means nothing is deliverable, and `IN ()` is invalid SQL.
      if (deliverable.length === 0) {
        qb.andWhere('1 = 0');
        return;
      }
      qb.andWhere('t.provider IN (:...deliverable)', { deliverable });
    }

    const betterIsDeliverable = deliverable
      ? `AND better.provider IN (:...deliverable)`
      : '';

    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM push_tokens better
        WHERE better.device_identity_id = t.device_identity_id
          AND better.project_id = t.project_id
          AND better.is_active = true
          ${betterIsDeliverable}
          AND (
            ${rank} < ${ownRank}
            OR (${rank} = ${ownRank} AND better.id < t.id)
          )
      )`,
      deliverable ? { deliverable } : {},
    );
  }

  /**
   * Leaves out every token whose device identity has said no to push.
   *
   * Explicit `false` only. Null means the app never told us, and for push the
   * operating system's notification permission is the consent that governs
   * delivery: a token exists only because the person granted it, and the OS
   * stops showing notifications the moment they revoke it. `push_opt_in`
   * adds the in-app choice on top ("no marketing notifications"), which the
   * OS cannot see. Per device, like the permission it refines: each install
   * reports its own flag, and a person with a phone and a tablet can turn
   * notifications off on one. A token belongs to exactly one identity, so an
   * anonymous device's own flag governs its tokens until it is identified,
   * and afterwards still does, since identify updates the same row.
   *
   * Applied by every reader that selects or counts recipients, so the
   * scheduler, the worker, journeys, experiments and the preview cannot
   * disagree about who is reachable (DPDP Act s.6(6)).
   */
  private applyPushConsent(qb: SelectQueryBuilder<PushTokenEntity>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM device_identities consent
        WHERE consent.id = t.device_identity_id
          AND consent.push_opt_in = false
      )`,
    );
  }

  private applyFrequencyCap(
    qb: SelectQueryBuilder<PushTokenEntity>,
    cap: number | null | undefined,
    currentCampaignId: string | null,
  ): void {
    if (cap === null || cap === undefined) return;

    qb.andWhere(
      `(
        SELECT COUNT(DISTINCT e.campaign_id)
        FROM push_notification_events e
        WHERE e.device_identity_id = t.device_identity_id
          AND e.type = 'sent'
          AND e.occurred_at > NOW() - INTERVAL '24 hours'
          AND (:currentCampaignId::uuid IS NULL OR e.campaign_id <> :currentCampaignId::uuid)
      ) < :cap`,
      { cap, currentCampaignId },
    );
  }

  /**
   * Keyset pagination over active tokens. Ordering by primary key and seeking
   * past `afterId` stays correct while the caller marks tokens inactive
   * mid-walk, which an OFFSET window would not.
   */
  async getActiveTokensPage(
    projectId: string,
    afterId: string | null,
    limit: number,
    frequencyCap?: number | null,
    currentCampaignId: string | null = null,
    deliverable?: PushProvider[],
  ): Promise<PushTokenEntity[]> {
    const qb = this.tokenRepository
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .andWhere('t.is_active = true')
      .orderBy('t.id', 'ASC')
      .limit(limit);

    this.applyBestTokenPerDevice(qb, deliverable);
    this.applyPushConsent(qb);
    this.applyFrequencyCap(qb, frequencyCap, currentCampaignId);

    if (afterId) {
      qb.andWhere('t.id > :afterId', { afterId });
    }

    return qb.getMany();
  }

  async getTokensByDeviceIdentityIdsPage(
    projectId: string,
    deviceIdentityIds: string[],
    afterId: string | null,
    limit: number,
    frequencyCap?: number | null,
    currentCampaignId: string | null = null,
    deliverable?: PushProvider[],
  ): Promise<PushTokenEntity[]> {
    if (deviceIdentityIds.length === 0) return [];

    const qb = this.tokenRepository
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .andWhere('t.device_identity_id IN (:...ids)', { ids: deviceIdentityIds })
      .andWhere('t.is_active = true')
      .orderBy('t.id', 'ASC')
      .limit(limit);

    this.applyBestTokenPerDevice(qb, deliverable);
    this.applyPushConsent(qb);
    this.applyFrequencyCap(qb, frequencyCap, currentCampaignId);

    if (afterId) {
      qb.andWhere('t.id > :afterId', { afterId });
    }

    return qb.getMany();
  }

  async markTokenInvalid(token: string): Promise<void> {
    await this.tokenRepository.update(
      { token },
      this.deactivation('provider_rejected'),
    );
  }

  /**
   * Deactivates a set of tokens within one project, in a single statement.
   *
   * Both properties are load-bearing for the campaign worker. Batching replaces
   * one awaited UPDATE per failed token — up to 500 of them, serially, before
   * each checkpoint. Scoping by project makes the composite unique index on
   * (project_id, token) usable, which a bare `WHERE token = ?` cannot be, and
   * stops one project's FCM response from deactivating the same token value in
   * every other project.
   */
  async markTokensInvalid(projectId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.tokenRepository.update(
      { projectId, token: In(tokens) },
      this.deactivation('provider_rejected'),
    );
  }

  /**
   * Reachability losses for a project over a window.
   *
   * Deliberately not called an uninstall count. A provider returns
   * UNREGISTERED for an uninstall, for cleared app storage, and for a rotated
   * token alike, and never says which — so the raw number is a *signal*, and
   * reporting it as a fact would overstate what the data supports.
   *
   * `likelyUninstalls` is the narrower claim worth acting on: a rejected token
   * whose device holds no live token now. If the device had simply rotated its
   * token or reinstalled, a newer active row would exist for that identity, so
   * excluding those removes the largest known source of false positives. It is
   * still a lower bound on churn, not a census.
   *
   * `appRequested` is separate and never folded in: a logout is not a lost
   * user, and counting it as one would make every sign-out look like churn.
   */
  async getReachabilityLosses(
    projectId: string,
    sinceDays = 30,
  ): Promise<{
    activeTokens: number;
    providerRejected: number;
    likelyUninstalls: number;
    appRequested: number;
    sinceDays: number;
    daily: Array<{ date: string; likelyUninstalls: number }>;
  }> {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - sinceDays);

    // A device that holds any live token is still reachable, so a rejection
    // on one of its older tokens was a rotation rather than a loss.
    const stillReachable = `
      NOT EXISTS (
        SELECT 1 FROM push_tokens live
        WHERE live.device_identity_id = t.device_identity_id
          AND live.project_id = t.project_id
          AND live.is_active = true
      )`;

    const [totals, daily, activeTokens] = await Promise.all([
      this.tokenRepository
        .createQueryBuilder('t')
        .select(
          `COUNT(*) FILTER (WHERE t.deactivation_reason = 'provider_rejected')`,
          'providerRejected',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE t.deactivation_reason = 'app_requested')`,
          'appRequested',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE t.deactivation_reason = 'provider_rejected' AND ${stillReachable})`,
          'likelyUninstalls',
        )
        .where('t.project_id = :projectId', { projectId })
        .andWhere('t.deactivated_at >= :since', { since })
        .getRawOne<{
          providerRejected: string;
          appRequested: string;
          likelyUninstalls: string;
        }>(),

      this.tokenRepository
        .createQueryBuilder('t')
        .select(`to_char(t.deactivated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`, 'date')
        .addSelect('COUNT(*)', 'count')
        .where('t.project_id = :projectId', { projectId })
        .andWhere('t.deactivated_at >= :since', { since })
        .andWhere(`t.deactivation_reason = 'provider_rejected'`)
        .andWhere(stillReachable)
        .groupBy('date')
        .orderBy('date', 'ASC')
        .getRawMany<{ date: string; count: string }>(),

      this.tokenRepository.count({ where: { projectId, isActive: true } }),
    ]);

    return {
      activeTokens,
      providerRejected: Number(totals?.providerRejected ?? 0),
      likelyUninstalls: Number(totals?.likelyUninstalls ?? 0),
      appRequested: Number(totals?.appRequested ?? 0),
      sinceDays,
      daily: daily.map((row) => ({
        date: row.date,
        likelyUninstalls: Number(row.count),
      })),
    };
  }

  /**
   * The one shape a deactivation takes, so a new call site cannot flip
   * `isActive` while forgetting to say when or why — which is how the
   * uninstall figures would quietly drift from the token table.
   */
  private deactivation(reason: TokenDeactivationReason): QueryDeepPartialEntity<PushTokenEntity> {
    return {
      isActive: false,
      deactivatedAt: new Date(),
      deactivationReason: reason,
    };
  }
}
