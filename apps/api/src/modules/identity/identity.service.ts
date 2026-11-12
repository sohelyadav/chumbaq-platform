import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import * as geoip from 'geoip-lite';
import { normaliseEmail, normalisePhone } from '../push-notifications/message-channel';
import { DeviceIdentityEntity } from './entities/device-identity.entity';
import { IdentityAliasEntity } from './entities/identity-alias.entity';
import { IdentifyDto, UpdateConsentDto, TrackRevenueDto } from './dto/identify.dto';
import { ErasedSuppressionsService } from '../privacy/erased-suppressions.service';
import { ConsentEventsService } from '../consent/consent-events.service';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { ConsentChannel, ConsentSource } from '../consent/entities/consent-event.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

/**
 * The consent flags, the `consent_events` channel each is recorded under, and
 * whether `true` grants. `doNotTrack` is the one inverted flag: turning it on
 * withdraws consent to tracking.
 */
const CONSENT_FIELDS = [
  { field: 'emailOptIn', channel: 'email', grantedWhen: true },
  { field: 'smsOptIn', channel: 'sms', grantedWhen: true },
  { field: 'whatsappOptIn', channel: 'whatsapp', grantedWhen: true },
  { field: 'pushOptIn', channel: 'push', grantedWhen: true },
  { field: 'gdprConsent', channel: 'gdpr', grantedWhen: true },
  { field: 'doNotTrack', channel: 'tracking', grantedWhen: false },
] as const satisfies ReadonlyArray<{
  field: keyof UpdateConsentDto & keyof DeviceIdentityEntity;
  channel: ConsentChannel;
  grantedWhen: boolean;
}>;

interface PendingConsentChange {
  channel: ConsentChannel;
  granted: boolean;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @InjectRepository(DeviceIdentityEntity)
    private readonly identityRepository: Repository<DeviceIdentityEntity>,
    @InjectRepository(IdentityAliasEntity)
    private readonly aliasRepository: Repository<IdentityAliasEntity>,
    private readonly erasedSuppressions: ErasedSuppressionsService,
    private readonly consentEvents: ConsentEventsService,
    private readonly trackingConsent: TrackingConsentService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * @param clientIp The address the request arrived from, as derived by
   *   `getClientIp`. Never taken from the body: see `IdentifyDto`.
   */
  async identify(
    dto: IdentifyDto,
    clientIp?: string,
  ): Promise<DeviceIdentityEntity> {
    return this.locked((repository, manager) => this.identifyLocked(repository, manager, dto, clientIp));
  }

  /**
   * Everything here runs on `manager`, inside `locked()`'s transaction, which
   * holds the row FOR UPDATE: a read or write through any other connection
   * would wait on that lock, or on the pool, for ever. Consent history, the
   * do-not-track lookups and suppression restores all take this manager.
   */
  private async identifyLocked(
    repository: Repository<DeviceIdentityEntity>,
    manager: EntityManager,
    dto: IdentifyDto,
    clientIp?: string,
  ): Promise<DeviceIdentityEntity> {
    let identity = await repository.findOne({
      where: {
        projectId: dto.projectId,
        deviceFingerprint: dto.deviceFingerprint,
      },
      lock: { mode: 'pessimistic_write' },
    });

    const isNew = !identity;

    if (identity) {
      const before = { email: identity.email, phoneE164: identity.phoneE164 };
      // What the SDK may change: see sdkConsent.
      dto = await this.sdkConsent(manager, dto, identity);
      // Read before anything is applied: the history records what changed.
      const consentChanges = this.consentChanges(identity, dto);
      if (dto.doNotTrack != null && dto.doNotTrack !== identity.doNotTrack) {
        identity.doNotTrackSource = 'sdk';
      }

      // Update existing identity
      if (dto.distinctId) identity.distinctId = dto.distinctId;
      if (dto.externalUserId) identity.externalUserId = dto.externalUserId;
      if (dto.traits) {
        identity.traits = { ...(identity.traits || {}), ...dto.traits };
      }
      if (dto.userAgent) identity.userAgent = dto.userAgent;

      // Update profile fields (only if provided)
      this.updateProfileFields(identity, dto);
      this.updateDeviceFields(identity, dto);
      this.updateConsentFields(identity, dto);


      // Applied first, then asked: a call that turns do-not-track on is
      // itself not tracked (and, since the stored row still says so, neither
      // is the one that turns it off). Profile and consent are still stored,
      // since that is what the person told us, not what we observed.
      //
      // Judged on this device's own flag and on a trusted objection for the
      // external id it now claims (a login on a new device of someone the
      // dashboard marked do-not-track), never on other devices' SDK-set
      // flags: see the trust model in tracking-consent.service.ts.
      const tracked =
        !identity.doNotTrack &&
        !(await this.trackingConsent.isDoNotTrack(
          {
            projectId: identity.projectId,
            deviceIdentityId: identity.id,
            externalUserId: identity.externalUserId ?? null,
          },
          manager,
        ));

      if (tracked) {
        if (clientIp) identity.ipAddress = clientIp;

        // Always update latest attribution
        this.updateLatestAttribution(identity, dto);

        // Increment session count
        identity.totalSessions = (identity.totalSessions || 0) + 1;

        // Update geo from IP if not already set or IP changed
        if (clientIp) {
          this.resolveGeo(identity, clientIp);
        }
        identity.lastSeenAt = new Date();
        await this.restoreErasedSuppressions(manager, identity, before);
        return this.persist(manager, identity, consentChanges, 'sdk');
      }

      this.trackingConsent.recordDrop('session');
      // `last_seen_at` is activity, so it stays where it was. It is an
      // UpdateDateColumn, which any save would move, so persist puts it back.
      await this.restoreErasedSuppressions(manager, identity, before);
      return this.persist(manager, identity, consentChanges, 'sdk', { keepLastSeenAt: identity.lastSeenAt });
    }

    dto = await this.sdkConsent(manager, dto, null);

    // A new device starts untracked if it says so, or if a trusted objection
    // covers the external id it claims: see TrackingConsentService.
    const tracked =
      !dto.doNotTrack &&
      !(await this.trackingConsent.isDoNotTrack(
        {
          projectId: dto.projectId,
          distinctId: dto.distinctId ?? null,
          externalUserId: dto.externalUserId ?? null,
        },
        manager,
      ));
    if (!tracked) this.trackingConsent.recordDrop('session');
    const attribution = tracked ? dto : ({} as Partial<IdentifyDto>);

    // Create new identity
    identity = repository.create({
      projectId: dto.projectId,
      deviceFingerprint: dto.deviceFingerprint,
      platform: dto.platform,
      distinctId: dto.distinctId || null,
      externalUserId: dto.externalUserId || null,
      traits: dto.traits || null,
      userAgent: dto.userAgent || null,
      ipAddress: (tracked && clientIp) || null,
      // Profile
      firstName: dto.firstName || null,
      lastName: dto.lastName || null,
      phone: dto.phone || null,
      email: this.reportedEmail(dto) ?? null,
      phoneE164: this.reportedPhone(dto) ?? null,
      avatar: dto.avatar || null,
      locale: dto.locale || null,
      language: dto.language || null,
      // Device
      os: dto.os || null,
      osVersion: dto.osVersion || null,
      browser: dto.browser || null,
      browserVersion: dto.browserVersion || null,
      appVersion: dto.appVersion || null,
      appBuild: dto.appBuild || null,
      manufacturer: dto.manufacturer || null,
      brand: dto.brand || null,
      model: dto.model || null,
      screenHeight: dto.screenHeight || null,
      screenWidth: dto.screenWidth || null,
      carrier: dto.carrier || null,
      // Geo
      timezone: dto.timezone || null,
      // Initial attribution (set once). Not stored for a do-not-track
      // person: where someone came from is behaviour, not profile.
      initialReferrer: attribution.referrer || null,
      initialReferringDomain: attribution.referrer ? this.extractDomain(attribution.referrer) : null,
      initialUtmSource: attribution.utmSource || null,
      initialUtmMedium: attribution.utmMedium || null,
      initialUtmCampaign: attribution.utmCampaign || null,
      initialUtmContent: attribution.utmContent || null,
      initialUtmTerm: attribution.utmTerm || null,
      installSource: attribution.installSource || null,
      installCampaign: attribution.installCampaign || null,
      // Latest attribution (same as initial on first create)
      latestReferrer: attribution.referrer || null,
      latestUtmSource: attribution.utmSource || null,
      latestUtmMedium: attribution.utmMedium || null,
      latestUtmCampaign: attribution.utmCampaign || null,
      // Engagement
      totalSessions: tracked ? 1 : 0,
      totalRevenue: 0,
      // Consent
      emailOptIn: dto.emailOptIn ?? null,
      smsOptIn: dto.smsOptIn ?? null,
      whatsappOptIn: dto.whatsappOptIn ?? null,
      pushOptIn: dto.pushOptIn ?? null,
      gdprConsent: dto.gdprConsent ?? null,
      doNotTrack: dto.doNotTrack || false,
      doNotTrackSource: dto.doNotTrack != null ? 'sdk' : null,
      consentUpdatedAt: this.consentChanges(null, dto).length > 0 ? new Date() : null,
    } as Partial<DeviceIdentityEntity>);

    // Resolve geo for new identity
    if (clientIp && tracked) {
      this.resolveGeo(identity, clientIp);
    }

    await this.restoreErasedSuppressions(manager, identity, { email: null, phoneE164: null });
    return this.persist(manager, identity as DeviceIdentityEntity, this.consentChanges(null, dto), 'sdk');
  }

  async trackRevenue(dto: TrackRevenueDto): Promise<void> {
    return this.locked((repository, manager) => this.trackRevenueLocked(repository, manager, dto));
  }

  private async trackRevenueLocked(
    repository: Repository<DeviceIdentityEntity>,
    manager: EntityManager,
    dto: TrackRevenueDto,
  ): Promise<void> {
    const identity = await repository.findOne({
      lock: { mode: 'pessimistic_write' },
      where: {
        projectId: dto.projectId,
        deviceFingerprint: dto.deviceFingerprint,
      },
    });

    if (!identity) return;

    // Revenue is behaviour: it feeds LTV and segment rules.
    if (
      identity.doNotTrack ||
      (await this.trackingConsent.isDoNotTrack(
        { projectId: dto.projectId, deviceIdentityId: identity.id },
        manager,
      ))
    ) {
      this.trackingConsent.recordDrop('revenue');
      return;
    }

    identity.totalRevenue = Number(identity.totalRevenue || 0) + dto.amount;
    if (dto.currency) identity.currency = dto.currency;
    identity.lastEventAt = new Date();

    await repository.save(identity);
  }

  /**
   * A team member's consent edit. With a `requester`, written to the project
   * activity log as `person.consent_changed` in the same transaction: the
   * consents that changed and their new values, the person by internal id.
   * Nothing changed, nothing written.
   */
  async updateConsent(
    projectId: string,
    personId: string,
    dto: UpdateConsentDto,
    requester: ActivityRequester | null,
  ): Promise<DeviceIdentityEntity | null> {
    return this.locked((repository, manager) =>
      this.updateConsentLocked(repository, manager, projectId, personId, dto, requester),
    );
  }

  private async updateConsentLocked(
    repository: Repository<DeviceIdentityEntity>,
    manager: EntityManager,
    projectId: string,
    personId: string,
    dto: UpdateConsentDto,
    requester: ActivityRequester | null,
  ): Promise<DeviceIdentityEntity | null> {
    const identity = await repository.findOne({
      lock: { mode: 'pessimistic_write' },
      where: { id: personId, projectId },
    });

    if (!identity) return null;

    const changes = this.consentChanges(identity, dto);
    const changedConsents = this.changedConsentFields(identity, dto);

    // Row-level only. A team member's do-not-track here holds this device
    // (the SDK cannot clear it: see sdkConsent) and never touches
    // `tracking_objections`: the external id on the row is whatever its SDK
    // last claimed, so acting on it would let anyone with an app install
    // aim an objection at someone else, or have support lift theirs. A
    // person-wide objection is its own explicit action that names the
    // external id (PersonObjectionsService).
    this.applyConsentFields(identity, dto);
    if (dto.doNotTrack !== undefined && dto.doNotTrack !== null) identity.doNotTrackSource = 'dashboard';
    identity.consentUpdatedAt = new Date();

    // Only the consent columns, by name: a team member editing consent is not
    // activity, so `last_seen_at` (an UpdateDateColumn) is named with its own
    // value rather than moved, and nothing else read earlier is written back.
    const columns: Partial<DeviceIdentityEntity> = {
      emailOptIn: identity.emailOptIn,
      smsOptIn: identity.smsOptIn,
      whatsappOptIn: identity.whatsappOptIn,
      pushOptIn: identity.pushOptIn,
      gdprConsent: identity.gdprConsent,
      doNotTrack: identity.doNotTrack,
      doNotTrackSource: identity.doNotTrackSource,
      consentUpdatedAt: identity.consentUpdatedAt,
      lastSeenAt: identity.lastSeenAt,
    };
    await manager.update(DeviceIdentityEntity, { id: identity.id, projectId }, columns as never);
    await this.consentEvents.record(
      changes.map((change) => ({
        projectId,
        deviceIdentityId: identity.id,
        channel: change.channel,
        granted: change.granted,
        source: 'dashboard' as const,
      })),
      manager,
    );
    if (requester && Object.keys(changedConsents).length > 0) {
      await recordBy(
        this.activity,
        requester,
        {
          projectId,
          action: 'person.consent_changed',
          target: { type: 'person', id: identity.id, label: null },
          details: { consents: changedConsents },
        },
        manager,
      );
    }
    return identity;
  }

  /** The consent flags this request changes, by field name, with their new values. */
  private changedConsentFields(current: DeviceIdentityEntity, dto: UpdateConsentDto): Record<string, boolean> {
    const changed: Record<string, boolean> = {};
    for (const { field } of CONSENT_FIELDS) {
      const next = dto[field];
      if (next === undefined || next === null || current[field] === next) continue;
      changed[field] = next;
    }
    return changed;
  }

  /**
   * The request as far as the SDK may change consent. Only `doNotTrack: false`
   * is ever dropped, and only while a trusted decision holds: the dashboard
   * set this row's flag (an app must not undo a team member's decision), or a
   * dashboard objection covers the external id this request claims (the row's
   * own one when it claims none). Dropped means neither written nor recorded,
   * since the effective state does not change. `doNotTrack: true` is always
   * kept: it only adds protection. Judged on the id claimed now, so after a
   * user switch on a shared device the new user's own choice applies.
   */
  private async sdkConsent(
    manager: EntityManager,
    dto: IdentifyDto,
    identity: DeviceIdentityEntity | null,
  ): Promise<IdentifyDto> {
    if (dto.doNotTrack !== false) return dto;
    const dashboardHolds = !!identity && identity.doNotTrack && identity.doNotTrackSource === 'dashboard';
    const claimed = dto.externalUserId || identity?.externalUserId || null;
    const objectionHolds =
      !dashboardHolds && !!claimed && (await this.trackingConsent.hasPersonObjection(dto.projectId, claimed, manager));
    if (!dashboardHolds && !objectionHolds) return dto;
    const { doNotTrack: _ignored, ...rest } = dto;
    return rest as IdentifyDto;
  }

  /**
   * Applies the consent fields a request carries. Null is "no change", the
   * same as absent (lead's call): the DTO accepts it, the SDKs may send it,
   * and writing it would silently clear a choice (`push_opt_in = null`
   * re-enables push) with nothing in the history to say so.
   */
  private applyConsentFields(identity: DeviceIdentityEntity, dto: UpdateConsentDto): boolean {
    let changed = false;
    for (const { field } of CONSENT_FIELDS) {
      const next = dto[field];
      if (next === undefined || next === null) continue;
      (identity as unknown as Record<string, boolean>)[field] = next;
      changed = true;
    }
    return changed;
  }

  /**
   * Which consent flags this request changes, and to what.
   *
   * Only real changes: the SDKs send the same `pushOptIn: true` on every
   * launch, and a history of repeated non-events would bury the ones that
   * matter. For a new identity (`current` null) every field provided is its
   * first recorded choice, including `doNotTrack: false`.
   */
  private consentChanges(
    current: DeviceIdentityEntity | null,
    dto: UpdateConsentDto,
  ): PendingConsentChange[] {
    const changes: PendingConsentChange[] = [];
    for (const { field, channel, grantedWhen } of CONSENT_FIELDS) {
      const next = dto[field];
      if (next === undefined || next === null) continue;
      if (current && current[field] === next) continue;
      changes.push({ channel, granted: next === grantedWhen });
    }
    return changes;
  }

  /**
   * Saves an identity together with the history of the consent changes made
   * to it, on the caller's transaction (`locked()`), so neither can exist
   * without the other. Never opens a transaction of its own: one opened while
   * `locked()` holds the row FOR UPDATE would wait on that lock for ever.
   */
  private async persist(
    manager: EntityManager,
    identity: DeviceIdentityEntity,
    changes: PendingConsentChange[],
    source: ConsentSource,
    options: {
      /** Put `last_seen_at` back after the save (an UpdateDateColumn, which any save moves). */
      keepLastSeenAt?: Date;
    } = {},
  ): Promise<DeviceIdentityEntity> {
    const { keepLastSeenAt } = options;
    const saved = await manager.save(DeviceIdentityEntity, identity);
    if (keepLastSeenAt) {
      // Named in the SET, so TypeORM does not add CURRENT_TIMESTAMP for it.
      await manager.update(DeviceIdentityEntity, { id: saved.id }, { lastSeenAt: keepLastSeenAt });
      saved.lastSeenAt = keepLastSeenAt;
    }
    await this.consentEvents.record(
      changes.map((change) => ({
        projectId: saved.projectId,
        deviceIdentityId: saved.id,
        channel: change.channel,
        granted: change.granted,
        source,
      })),
      manager,
    );
    return saved;
  }

  /**
   * Stamps `last_event_at` on the one device row an event named (by its
   * fingerprint), and never on a do-not-track row. It once matched
   * `distinct_id = X OR device_fingerprint = X`, which stamped every row
   * claiming that distinct id, other people's and do-not-track ones included.
   */
  async updateLastEventAt(projectId: string, deviceIdentityId: string): Promise<void> {
    await this.identityRepository
      .createQueryBuilder()
      .update(DeviceIdentityEntity)
      .set({ lastEventAt: new Date() })
      .where('id = :deviceIdentityId', { deviceIdentityId })
      .andWhere('project_id = :projectId', { projectId })
      .andWhere('do_not_track = false')
      .execute();
  }

  async linkDevice(
    params: {
      externalUserId: string;
      deviceFingerprint: string;
      platform: string;
      projectId: string;
      userAgent?: string;
    },
    clientIp?: string,
  ): Promise<DeviceIdentityEntity> {
    return this.identify(
      {
        projectId: params.projectId,
        deviceFingerprint: params.deviceFingerprint,
        platform: params.platform,
        externalUserId: params.externalUserId,
        userAgent: params.userAgent,
      },
      clientIp,
    );
  }

  async getDevicesByUser(
    externalUserId: string,
    projectId: string,
  ): Promise<DeviceIdentityEntity[]> {
    return this.identityRepository.find({
      where: { externalUserId, projectId },
      order: { lastSeenAt: 'DESC' },
    });
  }

  async getDevicesByDistinctId(
    distinctId: string,
    projectId: string,
  ): Promise<DeviceIdentityEntity[]> {
    return this.identityRepository.find({
      where: { distinctId, projectId },
      order: { lastSeenAt: 'DESC' },
    });
  }

  /**
   * Bulk lookup by id, for resolving a page of push tokens to the people
   * behind them. One query rather than one per token: a campaign page is 500.
   */
  async findByIds(ids: string[]): Promise<DeviceIdentityEntity[]> {
    if (ids.length === 0) return [];
    return this.identityRepository.find({ where: { id: In(ids) } });
  }

  /** The subset of `ids` that are identities in `projectId`. */
  async idsInProject(projectId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.identityRepository.find({
      select: { id: true },
      where: { id: In(ids), projectId },
    });
    return rows.map((r) => r.id);
  }

  async findByFingerprintAndProject(
    deviceFingerprint: string,
    projectId: string,
  ): Promise<DeviceIdentityEntity | null> {
    return this.identityRepository.findOne({
      where: { deviceFingerprint, projectId },
    });
  }

  async findByDistinctId(
    distinctId: string,
    projectId: string,
  ): Promise<DeviceIdentityEntity[]> {
    return this.identityRepository.find({
      where: { distinctId, projectId },
    });
  }

  async updateLastSeen(identityId: string): Promise<void> {
    await this.identityRepository.update(identityId, { lastSeenAt: new Date() });
  }

  async mergeIdentity(
    projectId: string,
    anonymousId: string,
    identifiedId: string,
  ): Promise<void> {
    if (anonymousId === identifiedId) return;

    const existing = await this.aliasRepository.findOne({
      where: { projectId, anonymousId },
    });

    if (!existing) {
      const alias = this.aliasRepository.create({
        projectId,
        anonymousId,
        identifiedId,
      } as Partial<IdentityAliasEntity>);
      await this.aliasRepository.save(alias as IdentityAliasEntity);
    }

    // Update device identities
    await this.identityRepository
      .createQueryBuilder()
      .update(DeviceIdentityEntity)
      // last_seen_at named as itself: an UpdateDateColumn, which TypeORM would
      // otherwise move on every row with that distinct id (which any SDK key
      // can name), stamping activity on devices that did nothing.
      .set({ distinctId: identifiedId, lastSeenAt: () => 'last_seen_at' })
      .where('project_id = :projectId', { projectId })
      .andWhere('distinct_id = :anonymousId', { anonymousId })
      .execute();

    // Update related event tables
    await this.identityRepository.manager.query(
      `UPDATE click_events SET distinct_id = $1 WHERE distinct_id = $2 AND link_id IN (SELECT id FROM links WHERE project_id = $3)`,
      [identifiedId, anonymousId, projectId],
    );

    await this.identityRepository.manager.query(
      `UPDATE conversion_events SET distinct_id = $1 WHERE distinct_id = $2 AND link_id IN (SELECT id FROM links WHERE project_id = $3)`,
      [identifiedId, anonymousId, projectId],
    );

    await this.identityRepository.manager.query(
      `UPDATE user_events SET distinct_id = $1 WHERE distinct_id = $2 AND project_id = $3`,
      [identifiedId, anonymousId, projectId],
    );

    await this.identityRepository.manager.query(
      `UPDATE touchpoints SET distinct_id = $1 WHERE distinct_id = $2 AND project_id = $3`,
      [identifiedId, anonymousId, projectId],
    );

    // Ids only by reference: the two values are a person's identifiers, and
    // logs outlive an erasure (see the person erasure design).
    this.logger.log(`Merged two identities in project ${projectId}`);
  }

  async resolveDistinctId(
    projectId: string,
    distinctId: string,
  ): Promise<string> {
    const alias = await this.aliasRepository.findOne({
      where: { projectId, anonymousId: distinctId },
    });
    return alias ? alias.identifiedId : distinctId;
  }

  // --- Private helpers ---

  /**
   * Load-then-save of an identity, under a row lock in one transaction. A
   * person erasure locks the same rows FOR UPDATE and deletes them, so a call
   * that waited on it finds no row and takes the create path (or does
   * nothing), built from its own request only. Without the lock, `save()` of
   * a row read before the erasure would INSERT it again with every field the
   * erasure removed.
   */
  private locked<T>(
    work: (repository: Repository<DeviceIdentityEntity>, manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.identityRepository.manager.transaction((manager) =>
      work(manager.getRepository(DeviceIdentityEntity), manager),
    );
  }

  /**
   * An address arriving here may belong to a person erased earlier whose
   * suppression survives only as a hash; this turns it back into a clear
   * suppression before the address is stored, so no send can reach it in
   * between. This method is the only writer of `email` and `phone_e164`, which
   * is what makes that sufficient: any new writer must do the same. Only new
   * or changed addresses are looked up, so a repeat identify costs nothing.
   */
  private async restoreErasedSuppressions(
    manager: EntityManager,
    identity: Partial<DeviceIdentityEntity>,
    before: { email: string | null; phoneE164: string | null },
  ): Promise<void> {
    const email = identity.email && identity.email !== before.email ? identity.email : null;
    const phoneE164 =
      identity.phoneE164 && identity.phoneE164 !== before.phoneE164 ? identity.phoneE164 : null;
    if (!email && !phoneE164) return;
    await this.erasedSuppressions.restore(identity.projectId as string, { email, phoneE164 }, manager);
  }


  /**
   * The address this identify call reports, normalised, or undefined when it
   * reports none.
   *
   * The explicit field wins over traits. A value that is present but not an
   * address is ignored rather than clearing a good one: a trait carrying a
   * display name by mistake must not make someone unreachable.
   */
  private reportedEmail(dto: IdentifyDto): string | undefined {
    const traits = dto.traits ?? {};
    for (const candidate of [dto.email, traits['$email'], traits['email']]) {
      const email = normaliseEmail(candidate);
      if (email) return email;
    }
    return undefined;
  }

  /**
   * The SMS number this identify call reports, in E.164, or undefined.
   *
   * Same precedence and same rule as email: a value that does not parse —
   * a national number with no country code — never clears a good one.
   */
  private reportedPhone(dto: IdentifyDto): string | undefined {
    const traits = dto.traits ?? {};
    for (const candidate of [dto.phone, traits['$phone'], traits['phone']]) {
      const phone = normalisePhone(candidate);
      if (phone) return phone;
    }
    return undefined;
  }

  private updateProfileFields(identity: DeviceIdentityEntity, dto: IdentifyDto): void {
    const email = this.reportedEmail(dto);
    if (email) identity.email = email;
    const phoneE164 = this.reportedPhone(dto);
    if (phoneE164) identity.phoneE164 = phoneE164;
    if (dto.firstName) identity.firstName = dto.firstName;
    if (dto.lastName) identity.lastName = dto.lastName;
    if (dto.phone) identity.phone = dto.phone;
    if (dto.avatar) identity.avatar = dto.avatar;
    if (dto.locale) identity.locale = dto.locale;
    if (dto.language) identity.language = dto.language;
  }

  private updateDeviceFields(identity: DeviceIdentityEntity, dto: IdentifyDto): void {
    if (dto.os) identity.os = dto.os;
    if (dto.osVersion) identity.osVersion = dto.osVersion;
    if (dto.browser) identity.browser = dto.browser;
    if (dto.browserVersion) identity.browserVersion = dto.browserVersion;
    if (dto.appVersion) identity.appVersion = dto.appVersion;
    if (dto.appBuild) identity.appBuild = dto.appBuild;
    if (dto.manufacturer) identity.manufacturer = dto.manufacturer;
    if (dto.brand) identity.brand = dto.brand;
    if (dto.model) identity.model = dto.model;
    if (dto.screenHeight) identity.screenHeight = dto.screenHeight;
    if (dto.screenWidth) identity.screenWidth = dto.screenWidth;
    if (dto.carrier) identity.carrier = dto.carrier;
    if (dto.timezone) identity.timezone = dto.timezone;
  }

  private updateConsentFields(identity: DeviceIdentityEntity, dto: IdentifyDto): void {
    if (this.applyConsentFields(identity, dto)) identity.consentUpdatedAt = new Date();
  }

  private updateLatestAttribution(identity: DeviceIdentityEntity, dto: IdentifyDto): void {
    if (dto.referrer) identity.latestReferrer = dto.referrer;
    if (dto.utmSource) identity.latestUtmSource = dto.utmSource;
    if (dto.utmMedium) identity.latestUtmMedium = dto.utmMedium;
    if (dto.utmCampaign) identity.latestUtmCampaign = dto.utmCampaign;
  }

  private resolveGeo(identity: DeviceIdentityEntity, ip: string): void {
    try {
      const isLocal = !ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
      const geo = isLocal ? null : geoip.lookup(ip);
      if (geo) {
        if (geo.country) identity.country = geo.country;
        if (geo.country) identity.countryCode = geo.country;
        if (geo.city) identity.city = geo.city;
        if (geo.region) identity.region = geo.region;
        if (geo.ll) {
          identity.latitude = geo.ll[0];
          identity.longitude = geo.ll[1];
        }
      } else if (isLocal) {
        identity.country = identity.country || 'India';
        identity.countryCode = identity.countryCode || 'IN';
        identity.city = identity.city || 'Mumbai';
        identity.region = identity.region || 'MH';
      }
    } catch (err) {
      this.logger.warn(`GeoIP lookup failed for ${ip}: ${err}`);
    }
  }

  private extractDomain(url: string): string | null {
    try {
      if (!url || url === '') return null;
      if (!url.startsWith('http')) url = 'https://' + url;
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
}
