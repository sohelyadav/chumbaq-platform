import { Injectable, NotFoundException, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as geoip from 'geoip-lite';
import { ClickEventEntity } from './entities/click-event.entity';
import { ConversionEventEntity } from '../conversions/entities/conversion-event.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { LinksService } from '../links/links.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

/**
 * Redirect types a deferred install can still follow from. See the note on
 * `isDeferred` in `recordClick` for why `app_deeplink` has to be in this list
 * and was not.
 */
export const DEFERRED_CAPABLE_REDIRECTS = [
  'app_deeplink',
  'app_store',
  'play_store',
];

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(ClickEventEntity)
    private readonly clickEventRepository: Repository<ClickEventEntity>,
    @InjectRepository(ConversionEventEntity)
    private readonly conversionEventRepository: Repository<ConversionEventEntity>,
    private readonly linksService: LinksService,
    private readonly trackingConsent: TrackingConsentService,
    private readonly projectAccess: ProjectAccessService,
    @Optional() @Inject(WebhooksService) private readonly webhooksService?: WebhooksService,
  ) {}

  async recordClick(params: {
    linkId: string;
    ipAddress?: string;
    userAgent?: string;
    referrer?: string;
    platform: string;
    deviceType: string;
    os?: string;
    osVersion?: string;
    browser?: string;
    browserVersion?: string;
    redirectType: string;
    deviceFingerprint?: string;
  }): Promise<ClickEventEntity> {
    let country: string | null = null;
    let countryCode: string | null = null;
    let city: string | null = null;
    let region: string | null = null;
    let latitude: number | null = null;
    let longitude: number | null = null;

    if (params.ipAddress) {
      try {
        const ip = params.ipAddress;
        const isLocal = !ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
        const geo = isLocal ? null : geoip.lookup(ip);
        if (geo) {
          country = geo.country || null;
          countryCode = geo.country || null;
          city = geo.city || null;
          region = geo.region || null;
          if (geo.ll) {
            latitude = geo.ll[0];
            longitude = geo.ll[1];
          }
        } else if (isLocal) {
          country = 'India';
          countryCode = 'IN';
          city = 'Mumbai';
          region = 'MH';
          latitude = 19.076;
          longitude = 72.8777;
        }
      } catch (err) {
        this.logger.warn(`GeoIP lookup failed for ${params.ipAddress}: ${err}`);
      }
    }

    // Resolve device identity if fingerprint provided
    let deviceIdentityId: string | null = null;
    let distinctId: string | null = null;

    if (params.deviceFingerprint) {
      try {
        const link = await this.linksService.findOne(params.linkId);
        const identity = await this.clickEventRepository.manager
          .createQueryBuilder()
          .select('di.id', 'id')
          .addSelect('di.distinct_id', 'distinctId')
          .from('device_identities', 'di')
          .where('di.project_id = :projectId', { projectId: link.projectId })
          .andWhere('di.device_fingerprint = :fp', { fp: params.deviceFingerprint })
          .getRawOne();

        // A do-not-track device's click is still a click on the link (the
        // tenant's link report counts it), but is not tied to the person: no
        // device, no distinct id, so it joins no profile, journey or
        // attribution.
        if (identity) {
          const dnt = await this.trackingConsent.isDoNotTrack({
            projectId: link.projectId,
            deviceIdentityId: identity.id,
          });
          if (dnt) {
            this.trackingConsent.recordDrop('click_device_link');
          } else {
            deviceIdentityId = identity.id;
            distinctId = identity.distinctId || null;
          }
        }
      } catch {
        // Don't fail click recording if identity resolution fails
      }
    }

    const clickEvent = this.clickEventRepository.create({
      linkId: params.linkId,
      ipAddress: params.ipAddress || null,
      userAgent: params.userAgent || null,
      referrer: params.referrer || null,
      platform: params.platform,
      deviceType: params.deviceType,
      os: params.os || null,
      osVersion: params.osVersion || null,
      browser: params.browser || null,
      browserVersion: params.browserVersion || null,
      country,
      countryCode,
      city,
      region,
      latitude,
      longitude,
      redirectType: params.redirectType,
      // Marks a click that could still become a deferred install.
      //
      // This was `redirectType === 'app_store' || 'play_store'`, and the
      // redirect controller never writes either value — it records the
      // deep-link *attempt*, because at redirect time nobody knows whether
      // the app is installed; the interstitial falls back to the store in the
      // browser ~1.5s later. Those two values reach this table only from
      // `seed.ts`, so `is_deferred` was **always false** on real traffic.
      //
      // `app_deeplink` is what a mobile click that may fall through to the
      // store actually carries, so it belongs here. The two store values stay
      // — they are semantically deferred too, and a future controller that
      // learns the real outcome should keep working. `web_fallback` is
      // excluded: that is the desktop path, where there is no app to install.
      //
      // **Not backfilled.** Rows written before this change cannot be
      // reclassified — the information was never recorded — so deferred-install
      // figures either side of this boundary are not comparable: the earlier
      // ones are structurally zero rather than genuinely zero. A time series
      // crossing it will step, and that step is this change, not a change in
      // user behaviour.
      isDeferred: DEFERRED_CAPABLE_REDIRECTS.includes(params.redirectType),
      matched: false,
      deviceIdentityId,
      distinctId,
    } as Partial<ClickEventEntity>);

    const saved = await this.clickEventRepository.save(clickEvent as ClickEventEntity);

    // Fire webhook for click event
    if (this.webhooksService) {
      try {
        const link = await this.linksService.findOne(params.linkId);
        this.webhooksService.fireWebhook(link.projectId, 'click', {
          linkId: params.linkId,
          clickId: saved.id,
          platform: params.platform,
          deviceType: params.deviceType,
          country,
          referrer: params.referrer,
        }).catch((err) => this.logger.warn(`Webhook fire failed: ${err}`));
      } catch {
        // Don't fail click recording if webhook fails
      }
    }

    return saved;
  }

  async getSummary(linkId: string): Promise<{
    totalClicks: number;
    uniqueVisitors: number;
    appOpens: number;
    storeRedirects: number;
    matchedInstalls: number;
    conversionsByType: { eventType: string; count: number }[];
    conversionRate: number;
  }> {
    const totalClicks = await this.clickEventRepository.count({
      where: { linkId },
    });

    const uniqueResult = await this.clickEventRepository
      .createQueryBuilder('click')
      .select('COUNT(DISTINCT click.ip_address)', 'count')
      .where('click.link_id = :linkId', { linkId })
      .getRawOne();
    const uniqueVisitors = parseInt(uniqueResult?.count || '0', 10);

    const appOpens = await this.clickEventRepository.count({
      where: { linkId, redirectType: 'app_deeplink' },
    });

    // `storeRedirects` and `appOpens` cannot be separated from click data,
    // and this filter is **deliberately left keyed on values the redirect
    // controller never writes**, which is why it reads zero on real traffic.
    //
    // The controller records the deep-link *attempt* (`app_deeplink`) because
    // at redirect time nobody knows whether the app is installed — the
    // interstitial falls back to the store in the browser ~1.5s later, and
    // never tells the server which way it went. So `app_store` / `play_store`
    // arrive only from `seed.ts`.
    //
    // Adding `app_deeplink` here looks like the fix and is not: `appOpens`
    // above already counts exactly those rows, so the two funnel stages would
    // become identical on every real link, counting each click twice and
    // showing a funnel with no drop-off. A plausible wrong number is worse
    // than a zero that is legible as broken. Making this real needs the
    // interstitial to report its outcome, or the stage retired — not a wider
    // filter.
    const storeRedirects = await this.clickEventRepository
      .createQueryBuilder('click')
      .where('click.link_id = :linkId', { linkId })
      .andWhere('click.redirect_type IN (:...types)', {
        types: ['app_store', 'play_store'],
      })
      .getCount();

    const matchedInstalls = await this.clickEventRepository.count({
      where: { linkId, matched: true },
    });

    const conversionsByType = await this.conversionEventRepository
      .createQueryBuilder('conv')
      .select('conv.event_type', 'eventType')
      .addSelect('COUNT(*)::int', 'count')
      .where('conv.link_id = :linkId', { linkId })
      .groupBy('conv.event_type')
      .getRawMany();

    const signupConversion = conversionsByType.find(
      (c) => c.eventType === 'signup',
    );
    const signupCount = signupConversion ? Number(signupConversion.count) : 0;
    const conversionRate =
      totalClicks > 0 ? signupCount / totalClicks : 0;

    return {
      totalClicks,
      uniqueVisitors,
      appOpens,
      storeRedirects,
      matchedInstalls,
      conversionsByType,
      conversionRate,
    };
  }

  async getTimeseries(
    linkId: string,
    start: Date,
    end: Date,
    granularity: 'hour' | 'day' | 'week' = 'day',
  ): Promise<{ date: string; clicks: number }[]> {
    const allowedGranularities = ['hour', 'day', 'week'] as const;
    const gran = allowedGranularities.includes(granularity) ? granularity : 'day';

    const result = await this.clickEventRepository
      .createQueryBuilder('click')
      .select(`DATE_TRUNC('${gran}', click.clicked_at)`, 'date')
      .addSelect('COUNT(*)::int', 'clicks')
      .where('click.link_id = :linkId', { linkId })
      .andWhere('click.clicked_at >= :start', { start })
      .andWhere('click.clicked_at <= :end', { end })
      .groupBy(`DATE_TRUNC('${gran}', click.clicked_at)`)
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({
      date: r.date,
      clicks: Number(r.clicks),
    }));
  }

  async getDeviceBreakdown(linkId: string): Promise<{
    deviceTypes: { name: string; count: number }[];
    operatingSystems: { name: string; count: number }[];
    browsers: { name: string; count: number }[];
  }> {
    const [deviceTypes, operatingSystems, browsers] = await Promise.all([
      this.clickEventRepository
        .createQueryBuilder('click')
        .select('click.device_type', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('click.link_id = :linkId', { linkId })
        .groupBy('click.device_type')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.clickEventRepository
        .createQueryBuilder('click')
        .select('click.os', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('click.link_id = :linkId', { linkId })
        .andWhere('click.os IS NOT NULL')
        .groupBy('click.os')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.clickEventRepository
        .createQueryBuilder('click')
        .select('click.browser', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('click.link_id = :linkId', { linkId })
        .andWhere('click.browser IS NOT NULL')
        .groupBy('click.browser')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      deviceTypes: deviceTypes.map((d) => ({ name: d.name, count: Number(d.count) })),
      operatingSystems: operatingSystems.map((d) => ({ name: d.name, count: Number(d.count) })),
      browsers: browsers.map((d) => ({ name: d.name, count: Number(d.count) })),
    };
  }

  async getGeoBreakdown(linkId: string): Promise<{
    countries: { name: string; code: string; count: number }[];
    cities: { name: string; region: string; country: string; count: number }[];
    points: { lat: number; lng: number; city: string; country: string; count: number }[];
  }> {
    const [countries, cities, points] = await Promise.all([
      this.clickEventRepository
        .createQueryBuilder('click')
        .select('click.country', 'name')
        .addSelect('click.country_code', 'code')
        .addSelect('COUNT(*)::int', 'count')
        .where('click.link_id = :linkId', { linkId })
        .andWhere('click.country IS NOT NULL')
        .groupBy('click.country')
        .addGroupBy('click.country_code')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.clickEventRepository
        .createQueryBuilder('click')
        .select('click.city', 'name')
        .addSelect('click.region', 'region')
        .addSelect('click.country', 'country')
        .addSelect('COUNT(*)::int', 'count')
        .where('click.link_id = :linkId', { linkId })
        .andWhere('click.city IS NOT NULL')
        .groupBy('click.city')
        .addGroupBy('click.region')
        .addGroupBy('click.country')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.clickEventRepository
        .createQueryBuilder('click')
        .select('click.latitude', 'lat')
        .addSelect('click.longitude', 'lng')
        .addSelect('click.city', 'city')
        .addSelect('click.country', 'country')
        .addSelect('COUNT(*)::int', 'count')
        .where('click.link_id = :linkId', { linkId })
        .andWhere('click.latitude IS NOT NULL')
        .andWhere('click.longitude IS NOT NULL')
        .groupBy('click.latitude')
        .addGroupBy('click.longitude')
        .addGroupBy('click.city')
        .addGroupBy('click.country')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      countries: countries.map((c) => ({
        name: c.name,
        code: c.code,
        count: Number(c.count),
      })),
      cities: cities.map((c) => ({
        name: c.name,
        region: c.region,
        country: c.country,
        count: Number(c.count),
      })),
      points: points.map((p) => ({
        lat: Number(p.lat),
        lng: Number(p.lng),
        city: p.city || '',
        country: p.country || '',
        count: Number(p.count),
      })),
    };
  }

  async getReferrers(
    linkId: string,
  ): Promise<{ referrer: string; count: number }[]> {
    const result = await this.clickEventRepository
      .createQueryBuilder('click')
      .select('click.referrer', 'referrer')
      .addSelect('COUNT(*)::int', 'count')
      .where('click.link_id = :linkId', { linkId })
      .andWhere('click.referrer IS NOT NULL')
      .andWhere("click.referrer != ''")
      .groupBy('click.referrer')
      .orderBy('count', 'DESC')
      .getRawMany();

    return result.map((r) => ({
      referrer: r.referrer,
      count: Number(r.count),
    }));
  }

  async exportClicksAsCsv(
    linkId: string,
    start?: Date,
    end?: Date,
  ): Promise<string> {
    const qb = this.clickEventRepository
      .createQueryBuilder('click')
      .where('click.link_id = :linkId', { linkId })
      .orderBy('click.clicked_at', 'DESC');

    if (start) {
      qb.andWhere('click.clicked_at >= :start', { start });
    }
    if (end) {
      qb.andWhere('click.clicked_at <= :end', { end });
    }

    const clicks = await qb.getMany();

    const header = 'id,clicked_at,ip_address,platform,device_type,os,browser,country,city,referrer,redirect_type';
    const rows = clicks.map((c) =>
      [
        c.id,
        c.clickedAt?.toISOString() || '',
        c.ipAddress || '',
        c.platform || '',
        c.deviceType || '',
        c.os || '',
        c.browser || '',
        c.country || '',
        c.city || '',
        `"${(c.referrer || '').replace(/"/g, '""')}"`,
        c.redirectType || '',
      ].join(','),
    );

    return [header, ...rows].join('\n');
  }

  /**
   * Totals across the projects the caller can see: every project they are a member of,
   * or in a view-as session only the ones the viewed account owns.
   */
  async getDashboardStats(user: AuthenticatedUser): Promise<{
    totalLinks: number;
    clicks24h: number;
    clicks7d: number;
    clicks30d: number;
    totalConversions: number;
    topLinks: {
      id: string;
      title: string;
      shortCode: string;
      clicks: number;
    }[];
  }> {
    const now = new Date();
    const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ago30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const visible = this.projectAccess.memberProjectsQuery(user);
    const visibleWhere = `p.id IN (${visible.sql})`;

    // Total links in the caller's visible projects
    const totalLinksResult = await this.clickEventRepository.manager
      .createQueryBuilder()
      .select('COUNT(*)::int', 'count')
      .from('links', 'l')
      .innerJoin('projects', 'p', 'l.project_id = p.id')
      .where(visibleWhere, visible.params)
      .getRawOne();
    const totalLinks = parseInt(totalLinksResult?.count || '0', 10);

    // Clicks in time windows
    const clicksQuery = (since: Date) =>
      this.clickEventRepository.manager
        .createQueryBuilder()
        .select('COUNT(*)::int', 'count')
        .from('click_events', 'ce')
        .innerJoin('links', 'l', 'ce.link_id = l.id')
        .innerJoin('projects', 'p', 'l.project_id = p.id')
        .where(visibleWhere, visible.params)
        .andWhere('ce.clicked_at >= :since', { since })
        .getRawOne();

    const [clicks24hResult, clicks7dResult, clicks30dResult] =
      await Promise.all([
        clicksQuery(ago24h),
        clicksQuery(ago7d),
        clicksQuery(ago30d),
      ]);

    const clicks24h = parseInt(clicks24hResult?.count || '0', 10);
    const clicks7d = parseInt(clicks7dResult?.count || '0', 10);
    const clicks30d = parseInt(clicks30dResult?.count || '0', 10);

    // Total conversions
    const totalConversionsResult = await this.conversionEventRepository.manager
      .createQueryBuilder()
      .select('COUNT(*)::int', 'count')
      .from('conversion_events', 'conv')
      .innerJoin('links', 'l', 'conv.link_id = l.id')
      .innerJoin('projects', 'p', 'l.project_id = p.id')
      .where(visibleWhere, visible.params)
      .getRawOne();
    const totalConversions = parseInt(
      totalConversionsResult?.count || '0',
      10,
    );

    // Top 5 links by clicks
    const topLinks = await this.clickEventRepository.manager
      .createQueryBuilder()
      .select('l.id', 'id')
      .addSelect('l.title', 'title')
      .addSelect('l.short_code', 'shortCode')
      .addSelect('COUNT(ce.id)::int', 'clicks')
      .from('links', 'l')
      .innerJoin('projects', 'p', 'l.project_id = p.id')
      .leftJoin('click_events', 'ce', 'ce.link_id = l.id')
      .where(visibleWhere, visible.params)
      .groupBy('l.id')
      .addGroupBy('l.title')
      .addGroupBy('l.short_code')
      .orderBy('clicks', 'DESC')
      .limit(5)
      .getRawMany();

    return {
      totalLinks,
      clicks24h,
      clicks7d,
      clicks30d,
      totalConversions,
      topLinks: topLinks.map((l) => ({
        id: l.id,
        title: l.title,
        shortCode: l.shortCode,
        clicks: Number(l.clicks),
      })),
    };
  }

  async getProjectAnalyticsSummary(projectId: string): Promise<{
    totalClicks: number;
    uniqueVisitors: number;
    appOpens: number;
    storeRedirects: number;
    matchedInstalls: number;
    conversionsByType: { eventType: string; count: number }[];
    conversionRate: number;
  }> {
    const totalClicks = await this.clickEventRepository
      .createQueryBuilder('click')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .getCount();

    const uniqueResult = await this.clickEventRepository
      .createQueryBuilder('click')
      .select('COUNT(DISTINCT click.ip_address)', 'count')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .getRawOne();
    const uniqueVisitors = parseInt(uniqueResult?.count || '0', 10);

    const appOpens = await this.clickEventRepository
      .createQueryBuilder('click')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .andWhere('click.redirect_type = :type', { type: 'app_deeplink' })
      .getCount();

    // Same as the per-link funnel above: left keyed on values that never
    // occur on real traffic, because widening it would duplicate `appOpens`
    // rather than measure anything. See the note there.
    const storeRedirects = await this.clickEventRepository
      .createQueryBuilder('click')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .andWhere('click.redirect_type IN (:...types)', { types: ['app_store', 'play_store'] })
      .getCount();

    const matchedInstalls = await this.clickEventRepository
      .createQueryBuilder('click')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .andWhere('click.matched = :matched', { matched: true })
      .getCount();

    const conversionsByType = await this.conversionEventRepository
      .createQueryBuilder('conv')
      .select('conv.event_type', 'eventType')
      .addSelect('COUNT(*)::int', 'count')
      .innerJoin('links', 'l', 'conv.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .groupBy('conv.event_type')
      .getRawMany();

    const signupConversion = conversionsByType.find((c) => c.eventType === 'signup');
    const signupCount = signupConversion ? Number(signupConversion.count) : 0;
    const conversionRate = totalClicks > 0 ? signupCount / totalClicks : 0;

    return { totalClicks, uniqueVisitors, appOpens, storeRedirects, matchedInstalls, conversionsByType, conversionRate };
  }

  async getProjectTimeseries(
    projectId: string,
    start: Date,
    end: Date,
    granularity: 'hour' | 'day' | 'week' = 'day',
  ): Promise<{ date: string; clicks: number }[]> {
    const allowedGranularities = ['hour', 'day', 'week'] as const;
    const gran = allowedGranularities.includes(granularity) ? granularity : 'day';

    const result = await this.clickEventRepository
      .createQueryBuilder('click')
      .select(`DATE_TRUNC('${gran}', click.clicked_at)`, 'date')
      .addSelect('COUNT(*)::int', 'clicks')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .andWhere('click.clicked_at >= :start', { start })
      .andWhere('click.clicked_at <= :end', { end })
      .groupBy(`DATE_TRUNC('${gran}', click.clicked_at)`)
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({ date: r.date, clicks: Number(r.clicks) }));
  }

  async getProjectDeviceBreakdown(projectId: string): Promise<{
    deviceTypes: { name: string; count: number }[];
    operatingSystems: { name: string; count: number }[];
    browsers: { name: string; count: number }[];
  }> {
    const baseQb = () =>
      this.clickEventRepository
        .createQueryBuilder('click')
        .innerJoin('links', 'l', 'click.link_id = l.id')
        .where('l.project_id = :projectId', { projectId });

    const [deviceTypes, operatingSystems, browsers] = await Promise.all([
      baseQb()
        .select('click.device_type', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy('click.device_type')
        .orderBy('count', 'DESC')
        .getRawMany(),

      baseQb()
        .select('click.os', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .andWhere('click.os IS NOT NULL')
        .groupBy('click.os')
        .orderBy('count', 'DESC')
        .getRawMany(),

      baseQb()
        .select('click.browser', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .andWhere('click.browser IS NOT NULL')
        .groupBy('click.browser')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      deviceTypes: deviceTypes.map((d) => ({ name: d.name, count: Number(d.count) })),
      operatingSystems: operatingSystems.map((d) => ({ name: d.name, count: Number(d.count) })),
      browsers: browsers.map((d) => ({ name: d.name, count: Number(d.count) })),
    };
  }

  async getProjectGeoBreakdown(projectId: string): Promise<{
    countries: { name: string; code: string; count: number }[];
    cities: { name: string; region: string; country: string; count: number }[];
    points: { lat: number; lng: number; city: string; country: string; count: number }[];
  }> {
    const baseQb = () =>
      this.clickEventRepository
        .createQueryBuilder('click')
        .innerJoin('links', 'l', 'click.link_id = l.id')
        .where('l.project_id = :projectId', { projectId });

    const [countries, cities, points] = await Promise.all([
      baseQb()
        .select('click.country', 'name')
        .addSelect('click.country_code', 'code')
        .addSelect('COUNT(*)::int', 'count')
        .andWhere('click.country IS NOT NULL')
        .groupBy('click.country')
        .addGroupBy('click.country_code')
        .orderBy('count', 'DESC')
        .getRawMany(),

      baseQb()
        .select('click.city', 'name')
        .addSelect('click.region', 'region')
        .addSelect('click.country', 'country')
        .addSelect('COUNT(*)::int', 'count')
        .andWhere('click.city IS NOT NULL')
        .groupBy('click.city')
        .addGroupBy('click.region')
        .addGroupBy('click.country')
        .orderBy('count', 'DESC')
        .getRawMany(),

      baseQb()
        .select('click.latitude', 'lat')
        .addSelect('click.longitude', 'lng')
        .addSelect('click.city', 'city')
        .addSelect('click.country', 'country')
        .addSelect('COUNT(*)::int', 'count')
        .andWhere('click.latitude IS NOT NULL')
        .andWhere('click.longitude IS NOT NULL')
        .groupBy('click.latitude')
        .addGroupBy('click.longitude')
        .addGroupBy('click.city')
        .addGroupBy('click.country')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      countries: countries.map((c) => ({ name: c.name, code: c.code, count: Number(c.count) })),
      cities: cities.map((c) => ({ name: c.name, region: c.region, country: c.country, count: Number(c.count) })),
      points: points.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), city: p.city || '', country: p.country || '', count: Number(p.count) })),
    };
  }

  async getProjectReferrers(projectId: string): Promise<{ referrer: string; count: number }[]> {
    const result = await this.clickEventRepository
      .createQueryBuilder('click')
      .select('click.referrer', 'referrer')
      .addSelect('COUNT(*)::int', 'count')
      .innerJoin('links', 'l', 'click.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .andWhere('click.referrer IS NOT NULL')
      .andWhere("click.referrer != ''")
      .groupBy('click.referrer')
      .orderBy('count', 'DESC')
      .getRawMany();

    return result.map((r) => ({ referrer: r.referrer, count: Number(r.count) }));
  }

  async getProjectDashboardStats(projectId: string): Promise<{
    totalLinks: number;
    clicks24h: number;
    clicks7d: number;
    clicks30d: number;
    totalConversions: number;
    topLinks: {
      id: string;
      title: string;
      shortCode: string;
      clicks: number;
    }[];
  }> {
    const now = new Date();
    const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const ago30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const totalLinksResult = await this.clickEventRepository.manager
      .createQueryBuilder()
      .select('COUNT(*)::int', 'count')
      .from('links', 'l')
      .where('l.project_id = :projectId', { projectId })
      .getRawOne();
    const totalLinks = parseInt(totalLinksResult?.count || '0', 10);

    const clicksQuery = (since: Date) =>
      this.clickEventRepository.manager
        .createQueryBuilder()
        .select('COUNT(*)::int', 'count')
        .from('click_events', 'ce')
        .innerJoin('links', 'l', 'ce.link_id = l.id')
        .where('l.project_id = :projectId', { projectId })
        .andWhere('ce.clicked_at >= :since', { since })
        .getRawOne();

    const [clicks24hResult, clicks7dResult, clicks30dResult] =
      await Promise.all([
        clicksQuery(ago24h),
        clicksQuery(ago7d),
        clicksQuery(ago30d),
      ]);

    const clicks24h = parseInt(clicks24hResult?.count || '0', 10);
    const clicks7d = parseInt(clicks7dResult?.count || '0', 10);
    const clicks30d = parseInt(clicks30dResult?.count || '0', 10);

    const totalConversionsResult = await this.conversionEventRepository.manager
      .createQueryBuilder()
      .select('COUNT(*)::int', 'count')
      .from('conversion_events', 'conv')
      .innerJoin('links', 'l', 'conv.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .getRawOne();
    const totalConversions = parseInt(
      totalConversionsResult?.count || '0',
      10,
    );

    const topLinks = await this.clickEventRepository.manager
      .createQueryBuilder()
      .select('l.id', 'id')
      .addSelect('l.title', 'title')
      .addSelect('l.short_code', 'shortCode')
      .addSelect('COUNT(ce.id)::int', 'clicks')
      .from('links', 'l')
      .leftJoin('click_events', 'ce', 'ce.link_id = l.id')
      .where('l.project_id = :projectId', { projectId })
      .groupBy('l.id')
      .addGroupBy('l.title')
      .addGroupBy('l.short_code')
      .orderBy('clicks', 'DESC')
      .limit(5)
      .getRawMany();

    return {
      totalLinks,
      clicks24h,
      clicks7d,
      clicks30d,
      totalConversions,
      topLinks: topLinks.map((l) => ({
        id: l.id,
        title: l.title,
        shortCode: l.shortCode,
        clicks: Number(l.clicks),
      })),
    };
  }
}
