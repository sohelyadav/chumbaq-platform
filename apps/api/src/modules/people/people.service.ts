import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { UserEventEntity } from '../events/entities/user-event.entity';

export interface PersonSummary {
  id: string;
  distinctId: string;
  externalUserId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  avatar: string | null;
  platform: string;
  os: string | null;
  browser: string | null;
  country: string | null;
  city: string | null;
  deviceCount: number;
  lastSeenAt: string;
  firstSeenAt: string;
  pushEnabled: boolean;
  totalEvents: number;
  totalSessions: number;
  totalRevenue: number;
  status: 'active' | 'inactive';
  initialUtmSource: string | null;
  initialUtmCampaign: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PeopleService {
  constructor(
    @InjectRepository(DeviceIdentityEntity)
    private readonly identityRepository: Repository<DeviceIdentityEntity>,
    @InjectRepository(UserEventEntity)
    private readonly eventRepository: Repository<UserEventEntity>,
  ) {}

  async listPeople(
    projectId: string,
    opts: {
      search?: string;
      page?: number;
      limit?: number;
      status?: 'active' | 'inactive';
      pushEnabled?: boolean;
      country?: string;
      platform?: string;
      hasRevenue?: boolean;
    },
  ): Promise<{ data: PersonSummary[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
    const page = opts.page || 1;
    const limit = opts.limit || 20;
    const offset = (page - 1) * limit;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const qb = this.identityRepository
      .createQueryBuilder('di')
      .select('di.id', 'id')
      .addSelect("COALESCE(di.distinct_id, di.device_fingerprint)", 'distinctId')
      .addSelect('di.external_user_id', 'externalUserId')
      .addSelect("COALESCE(di.first_name || ' ' || di.last_name, di.traits->>'$name', di.traits->>'name', di.external_user_id, di.distinct_id, di.device_fingerprint)", 'displayName')
      .addSelect("COALESCE(di.traits->>'$email', di.traits->>'email')", 'email')
      .addSelect('di.phone', 'phone')
      .addSelect('di.avatar', 'avatar')
      .addSelect('di.platform', 'platform')
      .addSelect('di.os', 'os')
      .addSelect('di.browser', 'browser')
      .addSelect('di.country', 'country')
      .addSelect('di.city', 'city')
      .addSelect('di.first_seen_at', 'firstSeenAt')
      .addSelect('di.last_seen_at', 'lastSeenAt')
      .addSelect('di.total_sessions', 'totalSessions')
      .addSelect('di.total_revenue', 'totalRevenue')
      .addSelect('di.initial_utm_source', 'initialUtmSource')
      .addSelect('di.initial_utm_campaign', 'initialUtmCampaign')
      .addSelect(
        `CASE WHEN di.last_seen_at >= :thirtyDaysAgo THEN 'active' ELSE 'inactive' END`,
        'status',
      )
      .addSelect(
        `(SELECT COUNT(*)::int FROM push_tokens pt WHERE pt.device_identity_id = di.id AND pt.is_active = true) > 0`,
        'pushEnabled',
      )
      .addSelect(
        `(SELECT COUNT(*)::int FROM user_events ue WHERE ue.distinct_id = COALESCE(di.distinct_id, di.device_fingerprint) AND ue.project_id = di.project_id)`,
        'totalEvents',
      )
      // Real device count: how many devices share the same distinctId
      .addSelect(
        `CASE WHEN di.distinct_id IS NOT NULL THEN (SELECT COUNT(*)::int FROM device_identities d2 WHERE d2.distinct_id = di.distinct_id AND d2.project_id = di.project_id) ELSE 1 END`,
        'deviceCount',
      )
      .where('di.project_id = :projectId', { projectId })
      .setParameter('thirtyDaysAgo', thirtyDaysAgo);

    if (opts.search) {
      qb.andWhere(
        `(di.distinct_id ILIKE :search OR di.external_user_id ILIKE :search OR di.device_fingerprint ILIKE :search OR di.first_name ILIKE :search OR di.last_name ILIKE :search OR di.traits->>'$name' ILIKE :search OR di.traits->>'name' ILIKE :search OR di.traits->>'$email' ILIKE :search OR di.traits->>'email' ILIKE :search OR di.phone ILIKE :search)`,
        { search: `%${opts.search}%` },
      );
    }

    if (opts.status === 'active') {
      qb.andWhere('di.last_seen_at >= :thirtyDaysAgo');
    } else if (opts.status === 'inactive') {
      qb.andWhere('di.last_seen_at < :thirtyDaysAgo');
    }

    if (opts.pushEnabled === true) {
      qb.andWhere(
        `(SELECT COUNT(*) FROM push_tokens pt WHERE pt.device_identity_id = di.id AND pt.is_active = true) > 0`,
      );
    } else if (opts.pushEnabled === false) {
      qb.andWhere(
        `(SELECT COUNT(*) FROM push_tokens pt WHERE pt.device_identity_id = di.id AND pt.is_active = true) = 0`,
      );
    }

    if (opts.country) {
      qb.andWhere('di.country = :country', { country: opts.country });
    }

    if (opts.platform) {
      qb.andWhere('di.platform = :platform', { platform: opts.platform });
    }

    if (opts.hasRevenue === true) {
      qb.andWhere('di.total_revenue > 0');
    }

    const totalQb = qb.clone();
    const totalResult = await totalQb.select('COUNT(*)', 'count').getRawOne();
    const total = parseInt(totalResult?.count || '0', 10);

    const data = await qb
      .orderBy('di.last_seen_at', 'DESC')
      .offset(offset)
      .limit(limit)
      .getRawMany();

    return {
      data: data.map((d) => ({
        id: d.id,
        distinctId: d.distinctId,
        externalUserId: d.externalUserId,
        displayName: (d.displayName || d.distinctId || 'Anonymous').trim(),
        email: d.email,
        phone: d.phone,
        avatar: d.avatar,
        platform: d.platform,
        os: d.os,
        browser: d.browser,
        country: d.country,
        city: d.city,
        deviceCount: parseInt(d.deviceCount || '1', 10),
        lastSeenAt: d.lastSeenAt,
        firstSeenAt: d.firstSeenAt,
        pushEnabled: d.pushEnabled === true || d.pushEnabled === 't',
        totalEvents: parseInt(d.totalEvents || '0', 10),
        totalSessions: parseInt(d.totalSessions || '0', 10),
        totalRevenue: parseFloat(d.totalRevenue || '0'),
        status: d.status,
        initialUtmSource: d.initialUtmSource,
        initialUtmCampaign: d.initialUtmCampaign,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getPeopleStats(projectId: string): Promise<{
    total: number;
    active30d: number;
    pushEnabled: number;
    newThisWeek: number;
    identified: number;
    withRevenue: number;
    totalRevenue: number;
    topCountries: { country: string; count: number }[];
    topPlatforms: { platform: string; count: number }[];
  }> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [total, active30d, pushEnabled, newThisWeek, identified, revenueStats, topCountries, topPlatforms] = await Promise.all([
      this.identityRepository.count({ where: { projectId } }),

      this.identityRepository
        .createQueryBuilder('di')
        .where('di.project_id = :projectId', { projectId })
        .andWhere('di.last_seen_at >= :since', { since: thirtyDaysAgo })
        .getCount(),

      this.identityRepository
        .createQueryBuilder('di')
        .where('di.project_id = :projectId', { projectId })
        .andWhere(
          `(SELECT COUNT(*) FROM push_tokens pt WHERE pt.device_identity_id = di.id AND pt.is_active = true) > 0`,
        )
        .getCount(),

      this.identityRepository
        .createQueryBuilder('di')
        .where('di.project_id = :projectId', { projectId })
        .andWhere('di.first_seen_at >= :since', { since: sevenDaysAgo })
        .getCount(),

      this.identityRepository
        .createQueryBuilder('di')
        .where('di.project_id = :projectId', { projectId })
        .andWhere('di.external_user_id IS NOT NULL')
        .getCount(),

      this.identityRepository
        .createQueryBuilder('di')
        .select('COUNT(CASE WHEN di.total_revenue > 0 THEN 1 END)::int', 'withRevenue')
        .addSelect('COALESCE(SUM(di.total_revenue), 0)', 'totalRevenue')
        .where('di.project_id = :projectId', { projectId })
        .getRawOne(),

      this.identityRepository
        .createQueryBuilder('di')
        .select('di.country', 'country')
        .addSelect('COUNT(*)::int', 'count')
        .where('di.project_id = :projectId', { projectId })
        .andWhere('di.country IS NOT NULL')
        .groupBy('di.country')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany(),

      this.identityRepository
        .createQueryBuilder('di')
        .select('di.platform', 'platform')
        .addSelect('COUNT(*)::int', 'count')
        .where('di.project_id = :projectId', { projectId })
        .groupBy('di.platform')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      total,
      active30d,
      pushEnabled,
      newThisWeek,
      identified: identified,
      withRevenue: parseInt(revenueStats?.withRevenue || '0', 10),
      totalRevenue: parseFloat(revenueStats?.totalRevenue || '0'),
      topCountries,
      topPlatforms,
    };
  }

  async getPersonDetail(projectId: string, personId: string) {
    const identity = await this.identityRepository.findOne({
      where: { id: personId, projectId },
    });

    if (!identity) return null;

    const distinctId = identity.distinctId || identity.deviceFingerprint;

    const [recentEvents, eventCounts, pushTokens, devices] = await Promise.all([
      this.eventRepository
        .createQueryBuilder('event')
        .where('event.project_id = :projectId', { projectId })
        .andWhere('event.distinct_id = :distinctId', { distinctId })
        .orderBy('event.timestamp', 'DESC')
        .take(50)
        .getMany(),

      this.eventRepository
        .createQueryBuilder('event')
        .select('event.event_name', 'eventName')
        .addSelect('COUNT(*)::int', 'count')
        .where('event.project_id = :projectId', { projectId })
        .andWhere('event.distinct_id = :distinctId', { distinctId })
        .groupBy('event.event_name')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.identityRepository.manager
        .createQueryBuilder()
        .select('*')
        .from('push_tokens', 'pt')
        .where('pt.device_identity_id = :personId', { personId })
        .getRawMany(),

      // Get all devices for this user (multi-device)
      identity.distinctId
        ? this.identityRepository.find({
            where: { distinctId: identity.distinctId, projectId },
            order: { lastSeenAt: 'DESC' },
          })
        : Promise.resolve([identity]),
    ]);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const daysSinceFirstSeen = Math.floor((now.getTime() - identity.firstSeenAt.getTime()) / (24 * 60 * 60 * 1000));
    const daysSinceLastSeen = Math.floor((now.getTime() - identity.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000));

    return {
      id: identity.id,
      distinctId,
      externalUserId: identity.externalUserId,
      displayName:
        [identity.firstName, identity.lastName].filter(Boolean).join(' ') ||
        (identity.traits as any)?.['$name'] ||
        (identity.traits as any)?.['name'] ||
        identity.externalUserId ||
        distinctId,
      // Profile
      firstName: identity.firstName,
      lastName: identity.lastName,
      email: (identity.traits as any)?.['$email'] || (identity.traits as any)?.['email'] || null,
      phone: identity.phone,
      avatar: identity.avatar,
      locale: identity.locale,
      language: identity.language,
      // Device
      platform: identity.platform,
      os: identity.os,
      osVersion: identity.osVersion,
      browser: identity.browser,
      browserVersion: identity.browserVersion,
      appVersion: identity.appVersion,
      appBuild: identity.appBuild,
      manufacturer: identity.manufacturer,
      brand: identity.brand,
      model: identity.model,
      screenHeight: identity.screenHeight,
      screenWidth: identity.screenWidth,
      carrier: identity.carrier,
      // Geo
      country: identity.country,
      countryCode: identity.countryCode,
      region: identity.region,
      city: identity.city,
      timezone: identity.timezone,
      latitude: identity.latitude,
      longitude: identity.longitude,
      // Attribution
      initialReferrer: identity.initialReferrer,
      initialReferringDomain: identity.initialReferringDomain,
      initialUtmSource: identity.initialUtmSource,
      initialUtmMedium: identity.initialUtmMedium,
      initialUtmCampaign: identity.initialUtmCampaign,
      initialUtmContent: identity.initialUtmContent,
      initialUtmTerm: identity.initialUtmTerm,
      installSource: identity.installSource,
      installCampaign: identity.installCampaign,
      latestReferrer: identity.latestReferrer,
      latestUtmSource: identity.latestUtmSource,
      latestUtmMedium: identity.latestUtmMedium,
      latestUtmCampaign: identity.latestUtmCampaign,
      // Engagement
      totalSessions: identity.totalSessions || 0,
      totalRevenue: Number(identity.totalRevenue) || 0,
      currency: identity.currency,
      lastEventAt: identity.lastEventAt,
      daysSinceFirstSeen,
      daysSinceLastSeen,
      // Consent
      emailOptIn: identity.emailOptIn,
      smsOptIn: identity.smsOptIn,
      whatsappOptIn: identity.whatsappOptIn,
      pushOptIn: identity.pushOptIn,
      gdprConsent: identity.gdprConsent,
      doNotTrack: identity.doNotTrack,
      consentUpdatedAt: identity.consentUpdatedAt,
      // Custom traits
      traits: identity.traits || {},
      // Timestamps
      firstSeenAt: identity.firstSeenAt,
      lastSeenAt: identity.lastSeenAt,
      status: identity.lastSeenAt >= thirtyDaysAgo ? 'active' : 'inactive',
      // Related data
      pushEnabled: pushTokens.some((pt: any) => pt.is_active),
      pushTokens,
      devices: devices.map((d) => ({
        id: d.id,
        deviceFingerprint: d.deviceFingerprint,
        platform: d.platform,
        os: d.os,
        osVersion: d.osVersion,
        browser: d.browser,
        model: d.model,
        lastSeenAt: d.lastSeenAt,
      })),
      deviceCount: devices.length,
      recentEvents,
      eventCounts,
    };
  }

  async getPersonEvents(
    projectId: string,
    personId: string,
    opts: { page?: number; limit?: number; eventName?: string },
  ) {
    const identity = await this.identityRepository.findOne({
      where: { id: personId, projectId },
    });
    if (!identity) return { data: [], total: 0 };

    const distinctId = identity.distinctId || identity.deviceFingerprint;
    const page = opts.page || 1;
    const limit = opts.limit || 50;

    const qb = this.eventRepository
      .createQueryBuilder('event')
      .where('event.project_id = :projectId', { projectId })
      .andWhere('event.distinct_id = :distinctId', { distinctId });

    if (opts.eventName) {
      qb.andWhere('event.event_name = :eventName', { eventName: opts.eventName });
    }

    const [data, total] = await qb
      .orderBy('event.timestamp', 'DESC')
      .take(limit)
      .skip((page - 1) * limit)
      .getManyAndCount();

    return { data, total };
  }

  /**
   * Merges traits in one statement against the live row, never a load and
   * save: a person erasure can delete the row in between, and `save()` of the
   * row read earlier would INSERT it again with everything the erasure
   * removed. No row (unknown, or erased meanwhile) answers null, a 404.
   */
  async updatePersonTraits(
    projectId: string,
    personId: string,
    traits: Record<string, unknown>,
  ) {
    if (!traits || typeof traits !== 'object' || Array.isArray(traits)) {
      throw new BadRequestException('Traits must be an object');
    }
    // The route takes any string; only a UUID can name a row (and $2::uuid must not 500).
    if (!UUID.test(personId)) return null;
    const updated: unknown = await this.identityRepository.query(
      `UPDATE device_identities
       SET traits = COALESCE(traits, '{}'::jsonb) || $3::jsonb
       WHERE id = $2::uuid AND project_id = $1
       RETURNING id`,
      [projectId, personId, JSON.stringify(traits)],
    );
    const rows = Array.isArray(updated) && Array.isArray(updated[0]) ? updated[0] : updated;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return this.identityRepository.findOne({ where: { id: personId, projectId } });
  }

}
