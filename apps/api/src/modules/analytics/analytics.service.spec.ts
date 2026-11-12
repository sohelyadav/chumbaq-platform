import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service';
import { ClickEventEntity } from './entities/click-event.entity';
import { ConversionEventEntity } from '../conversions/entities/conversion-event.entity';
import { LinksService } from '../links/links.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ProjectAccessService } from '../project-access/project-access.service';

import { TrackingConsentService } from '../consent/tracking-consent.service';

/** Nobody is do-not-track unless a test says so. */
const trackingConsent = {
  isDoNotTrack: jest.fn(async (_subject: unknown) => false),
  withoutDoNotTrack: jest.fn(async (_projectId: string, ids: string[]) => ids),
  recordDrop: jest.fn(),
};

jest.mock('geoip-lite', () => ({
  lookup: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const geoip = require('geoip-lite');

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  const makeQb = () => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
      getRawMany: jest.fn(),
      getMany: jest.fn(),
      getCount: jest.fn(),
    };
    return qb;
  };

  let clickQb: ReturnType<typeof makeQb>;
  let conversionQb: ReturnType<typeof makeQb>;

  const clickEventRepository: any = {
    create: jest.fn((entity) => entity),
    save: jest.fn((entity) => Promise.resolve({ id: 'click-1', ...entity })),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: {
      createQueryBuilder: jest.fn(),
    },
  };

  const conversionEventRepository: any = {
    createQueryBuilder: jest.fn(),
    manager: {
      createQueryBuilder: jest.fn(),
    },
  };

  const linksService: any = {
    findOne: jest.fn(),
  };

  // The real SQL is exercised in dashboard-stats.int-spec.ts; here only that it is used.
  const projectAccess: any = {
    memberProjectsQuery: jest.fn(() => ({ sql: 'SELECT member_project_ids', params: { projectAccess_userId: 'user-1' } })),
  };
  const caller: any = { userId: 'user-1', email: 'u@x.test', isSuperAdmin: false };

  const webhooksService: any = {
    fireWebhook: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    clickQb = makeQb();
    conversionQb = makeQb();
    clickEventRepository.createQueryBuilder.mockReturnValue(clickQb);
    conversionEventRepository.createQueryBuilder.mockReturnValue(conversionQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: TrackingConsentService, useValue: trackingConsent },
        AnalyticsService,
        { provide: getRepositoryToken(ClickEventEntity), useValue: clickEventRepository },
        { provide: getRepositoryToken(ConversionEventEntity), useValue: conversionEventRepository },
        { provide: LinksService, useValue: linksService },
        { provide: WebhooksService, useValue: webhooksService },
        { provide: ProjectAccessService, useValue: projectAccess },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  // ---------------------------------------------------------------------------
  // recordClick
  // ---------------------------------------------------------------------------
  describe('recordClick', () => {
    it('records a click without geo when no ip is provided', async () => {
      const params = {
        linkId: 'link-1',
        platform: 'web',
        deviceType: 'desktop',
        redirectType: 'direct_url',
      };

      const result = await service.recordClick(params);

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          linkId: 'link-1',
          platform: 'web',
          country: null,
          city: null,
          matched: false,
          isDeferred: false,
        }),
      );
      expect(clickEventRepository.save).toHaveBeenCalled();
      expect(result).toHaveProperty('id');
    });

    it('resolves geo from a public ip address', async () => {
      (geoip.lookup as jest.Mock).mockReturnValueOnce({
        country: 'US',
        region: 'NY',
        city: 'New York',
        ll: [40.7, -74.0],
      });

      await service.recordClick({
        linkId: 'link-1',
        ipAddress: '8.8.8.8',
        platform: 'ios',
        deviceType: 'mobile',
        redirectType: 'app_deeplink',
      });

      expect(geoip.lookup).toHaveBeenCalledWith('8.8.8.8');
      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          country: 'US',
          city: 'New York',
          region: 'NY',
          latitude: 40.7,
          longitude: -74.0,
        }),
      );
    });

    it('uses India fallback when ip is local', async () => {
      await service.recordClick({
        linkId: 'link-1',
        ipAddress: '127.0.0.1',
        platform: 'web',
        deviceType: 'desktop',
        redirectType: 'direct_url',
      });

      expect(geoip.lookup).not.toHaveBeenCalled();
      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          country: 'India',
          countryCode: 'IN',
          city: 'Mumbai',
          region: 'MH',
        }),
      );
    });

    it('uses the local fallback for 192.168.x.x ips', async () => {
      await service.recordClick({
        linkId: 'link-1',
        ipAddress: '192.168.1.5',
        platform: 'web',
        deviceType: 'desktop',
        redirectType: 'direct_url',
      });

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'India', city: 'Mumbai' }),
      );
    });

    it('swallows geoip errors and still saves the click', async () => {
      (geoip.lookup as jest.Mock).mockImplementationOnce(() => {
        throw new Error('boom');
      });

      const result = await service.recordClick({
        linkId: 'link-1',
        ipAddress: '8.8.8.8',
        platform: 'web',
        deviceType: 'desktop',
        redirectType: 'direct_url',
      });

      expect(clickEventRepository.save).toHaveBeenCalled();
      expect(result).toHaveProperty('id');
    });

    it('marks click isDeferred=true for the app_deeplink the controller writes', async () => {
      // The defect: `is_deferred` was keyed on app_store/play_store, which
      // `redirect.controller.ts` never writes — it records the deep-link
      // attempt, since the interstitial's fallback to the store happens in
      // the browser afterwards. Those two values reach this table only from
      // `seed.ts`, so this column was always false on real traffic, and the
      // two tests below passed for months on values that never occur.
      await service.recordClick({
        linkId: 'link-1',
        platform: 'ios',
        deviceType: 'mobile',
        redirectType: 'app_deeplink',
      });

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDeferred: true }),
      );
    });

    it('leaves isDeferred=false for the desktop web_fallback path', async () => {
      // No app to install, so no deferred install can follow.
      await service.recordClick({
        linkId: 'link-1',
        platform: 'web',
        deviceType: 'desktop',
        redirectType: 'web_fallback',
      });

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDeferred: false }),
      );
    });

    it('marks click isDeferred=true for app_store redirect', async () => {
      await service.recordClick({
        linkId: 'link-1',
        platform: 'ios',
        deviceType: 'mobile',
        redirectType: 'app_store',
      });

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDeferred: true }),
      );
    });

    it('marks click isDeferred=true for play_store redirect', async () => {
      await service.recordClick({
        linkId: 'link-1',
        platform: 'android',
        deviceType: 'mobile',
        redirectType: 'play_store',
      });

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDeferred: true }),
      );
    });

    it('resolves device identity when fingerprint is provided', async () => {
      linksService.findOne.mockResolvedValue({ id: 'link-1', projectId: 'proj-1' });

      const managerQb = makeQb();
      managerQb.getRawOne.mockResolvedValueOnce({ id: 'di-1', distinctId: 'user-1' });
      clickEventRepository.manager.createQueryBuilder.mockReturnValueOnce(managerQb);

      await service.recordClick({
        linkId: 'link-1',
        platform: 'ios',
        deviceType: 'mobile',
        redirectType: 'app_deeplink',
        deviceFingerprint: 'fp-1',
      });

      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceIdentityId: 'di-1',
          distinctId: 'user-1',
        }),
      );
    });

    it('does not fail when identity lookup errors', async () => {
      linksService.findOne.mockRejectedValueOnce(new Error('link gone'));

      const result = await service.recordClick({
        linkId: 'link-1',
        platform: 'ios',
        deviceType: 'mobile',
        redirectType: 'app_deeplink',
        deviceFingerprint: 'fp-1',
      });

      expect(result).toHaveProperty('id');
      expect(clickEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ deviceIdentityId: null, distinctId: null }),
      );
    });

    it('fires a webhook after save', async () => {
      linksService.findOne.mockResolvedValue({ id: 'link-1', projectId: 'proj-1' });
      webhooksService.fireWebhook.mockResolvedValue(undefined);

      await service.recordClick({
        linkId: 'link-1',
        platform: 'web',
        deviceType: 'desktop',
        redirectType: 'direct_url',
      });

      expect(webhooksService.fireWebhook).toHaveBeenCalledWith(
        'proj-1',
        'click',
        expect.objectContaining({ linkId: 'link-1', clickId: 'click-1' }),
      );
    });

    it('does not throw when webhook fails to fire', async () => {
      linksService.findOne.mockResolvedValue({ id: 'link-1', projectId: 'proj-1' });
      webhooksService.fireWebhook.mockRejectedValueOnce(new Error('webhook down'));

      await expect(
        service.recordClick({
          linkId: 'link-1',
          platform: 'web',
          deviceType: 'desktop',
          redirectType: 'direct_url',
        }),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getSummary
  // ---------------------------------------------------------------------------
  describe('getSummary', () => {
    it('aggregates totals, unique visitors, and conversion rate', async () => {
      clickEventRepository.count
        .mockResolvedValueOnce(100) // totalClicks
        .mockResolvedValueOnce(10) // appOpens
        .mockResolvedValueOnce(20); // matchedInstalls

      // 2 distinct createQueryBuilder calls on clickEventRepository:
      // 1) uniqueResult (getRawOne), 2) storeRedirects (getCount)
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '50' });
      const storeQb = makeQb();
      storeQb.getCount.mockResolvedValueOnce(15);
      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(uniqueQb)
        .mockReturnValueOnce(storeQb);

      const convQb = makeQb();
      convQb.getRawMany.mockResolvedValueOnce([
        { eventType: 'signup', count: 10 },
        { eventType: 'purchase', count: 5 },
      ]);
      conversionEventRepository.createQueryBuilder.mockReturnValueOnce(convQb);

      const result = await service.getSummary('link-1');

      expect(result.totalClicks).toBe(100);
      expect(result.uniqueVisitors).toBe(50);
      expect(result.appOpens).toBe(10);
      expect(result.storeRedirects).toBe(15);
      expect(result.matchedInstalls).toBe(20);
      expect(result.conversionRate).toBeCloseTo(0.1);
      expect(result.conversionsByType).toHaveLength(2);
    });

    it('returns conversionRate=0 when totalClicks is 0', async () => {
      clickEventRepository.count.mockResolvedValue(0);

      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      const storeQb = makeQb();
      storeQb.getCount.mockResolvedValueOnce(0);
      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(uniqueQb)
        .mockReturnValueOnce(storeQb);

      const convQb = makeQb();
      convQb.getRawMany.mockResolvedValueOnce([]);
      conversionEventRepository.createQueryBuilder.mockReturnValueOnce(convQb);

      const result = await service.getSummary('link-1');

      expect(result.conversionRate).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getTimeseries
  // ---------------------------------------------------------------------------
  describe('getTimeseries', () => {
    it('groups by day by default', async () => {
      clickQb.getRawMany.mockResolvedValueOnce([
        { date: '2025-01-01', clicks: '5' },
        { date: '2025-01-02', clicks: '10' },
      ]);

      const result = await service.getTimeseries(
        'link-1',
        new Date('2025-01-01'),
        new Date('2025-01-31'),
      );

      expect(clickQb.select).toHaveBeenCalledWith(
        expect.stringContaining("DATE_TRUNC('day'"),
        'date',
      );
      expect(result).toEqual([
        { date: '2025-01-01', clicks: 5 },
        { date: '2025-01-02', clicks: 10 },
      ]);
    });

    it('accepts hour granularity', async () => {
      clickQb.getRawMany.mockResolvedValueOnce([]);

      await service.getTimeseries('link-1', new Date(), new Date(), 'hour');

      expect(clickQb.select).toHaveBeenCalledWith(
        expect.stringContaining("DATE_TRUNC('hour'"),
        'date',
      );
    });

    it('falls back to day for unrecognized granularity', async () => {
      clickQb.getRawMany.mockResolvedValueOnce([]);

      await service.getTimeseries('link-1', new Date(), new Date(), 'month' as any);

      expect(clickQb.select).toHaveBeenCalledWith(
        expect.stringContaining("DATE_TRUNC('day'"),
        'date',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getDeviceBreakdown
  // ---------------------------------------------------------------------------
  describe('getDeviceBreakdown', () => {
    it('returns mapped device types, OS, and browsers', async () => {
      const deviceQb = makeQb();
      deviceQb.getRawMany.mockResolvedValueOnce([{ name: 'mobile', count: '75' }]);
      const osQb = makeQb();
      osQb.getRawMany.mockResolvedValueOnce([{ name: 'iOS', count: '50' }]);
      const browserQb = makeQb();
      browserQb.getRawMany.mockResolvedValueOnce([{ name: 'Safari', count: '40' }]);

      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(deviceQb)
        .mockReturnValueOnce(osQb)
        .mockReturnValueOnce(browserQb);

      const result = await service.getDeviceBreakdown('link-1');

      expect(result).toEqual({
        deviceTypes: [{ name: 'mobile', count: 75 }],
        operatingSystems: [{ name: 'iOS', count: 50 }],
        browsers: [{ name: 'Safari', count: 40 }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getGeoBreakdown
  // ---------------------------------------------------------------------------
  describe('getGeoBreakdown', () => {
    it('returns mapped countries, cities, and points', async () => {
      const countriesQb = makeQb();
      countriesQb.getRawMany.mockResolvedValueOnce([
        { name: 'US', code: 'US', count: '100' },
      ]);
      const citiesQb = makeQb();
      citiesQb.getRawMany.mockResolvedValueOnce([
        { name: 'NYC', region: 'NY', country: 'US', count: '50' },
      ]);
      const pointsQb = makeQb();
      pointsQb.getRawMany.mockResolvedValueOnce([
        { lat: '40.7', lng: '-74.0', city: 'NYC', country: 'US', count: '50' },
      ]);

      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(countriesQb)
        .mockReturnValueOnce(citiesQb)
        .mockReturnValueOnce(pointsQb);

      const result = await service.getGeoBreakdown('link-1');

      expect(result.countries[0]).toEqual({ name: 'US', code: 'US', count: 100 });
      expect(result.cities[0].name).toBe('NYC');
      expect(result.points[0]).toEqual({
        lat: 40.7,
        lng: -74.0,
        city: 'NYC',
        country: 'US',
        count: 50,
      });
    });

    it('defaults missing city/country to empty string in points', async () => {
      const countriesQb = makeQb();
      countriesQb.getRawMany.mockResolvedValueOnce([]);
      const citiesQb = makeQb();
      citiesQb.getRawMany.mockResolvedValueOnce([]);
      const pointsQb = makeQb();
      pointsQb.getRawMany.mockResolvedValueOnce([
        { lat: '1', lng: '2', city: null, country: null, count: '1' },
      ]);

      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(countriesQb)
        .mockReturnValueOnce(citiesQb)
        .mockReturnValueOnce(pointsQb);

      const result = await service.getGeoBreakdown('link-1');

      expect(result.points[0].city).toBe('');
      expect(result.points[0].country).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // getReferrers
  // ---------------------------------------------------------------------------
  describe('getReferrers', () => {
    it('returns referrers with numeric counts, filtering empties', async () => {
      clickQb.getRawMany.mockResolvedValueOnce([
        { referrer: 'https://google.com', count: '40' },
        { referrer: 'https://facebook.com', count: '20' },
      ]);

      const result = await service.getReferrers('link-1');

      expect(clickQb.andWhere).toHaveBeenCalledWith('click.referrer IS NOT NULL');
      expect(clickQb.andWhere).toHaveBeenCalledWith("click.referrer != ''");
      expect(result).toEqual([
        { referrer: 'https://google.com', count: 40 },
        { referrer: 'https://facebook.com', count: 20 },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // exportClicksAsCsv
  // ---------------------------------------------------------------------------
  describe('exportClicksAsCsv', () => {
    it('builds a CSV with header row', async () => {
      clickQb.getMany.mockResolvedValueOnce([
        {
          id: 'c1',
          clickedAt: new Date('2025-01-01T00:00:00Z'),
          ipAddress: '1.2.3.4',
          platform: 'ios',
          deviceType: 'mobile',
          os: 'iOS',
          browser: null,
          country: 'US',
          city: 'NYC',
          referrer: 'https://google.com',
          redirectType: 'app_deeplink',
        },
      ]);

      const csv = await service.exportClicksAsCsv('link-1');

      expect(csv.split('\n')[0]).toContain('id,clicked_at');
      expect(csv).toContain('c1');
      expect(csv).toContain('"https://google.com"');
    });

    it('escapes quotes in referrers', async () => {
      clickQb.getMany.mockResolvedValueOnce([
        {
          id: 'c1',
          clickedAt: new Date('2025-01-01T00:00:00Z'),
          referrer: 'he said "hi"',
        },
      ]);

      const csv = await service.exportClicksAsCsv('link-1');

      expect(csv).toContain('"he said ""hi"""');
    });

    it('applies start and end filters when provided', async () => {
      clickQb.getMany.mockResolvedValueOnce([]);

      await service.exportClicksAsCsv(
        'link-1',
        new Date('2025-01-01'),
        new Date('2025-01-31'),
      );

      expect(clickQb.andWhere).toHaveBeenCalledWith(
        'click.clicked_at >= :start',
        expect.any(Object),
      );
      expect(clickQb.andWhere).toHaveBeenCalledWith(
        'click.clicked_at <= :end',
        expect.any(Object),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getDashboardStats (user-scoped)
  // ---------------------------------------------------------------------------
  describe('getDashboardStats', () => {
    it('aggregates per-user stats across projects', async () => {
      const totalLinksQb = makeQb();
      totalLinksQb.getRawOne.mockResolvedValueOnce({ count: '10' });

      const clicks24hQb = makeQb();
      clicks24hQb.getRawOne.mockResolvedValueOnce({ count: '100' });
      const clicks7dQb = makeQb();
      clicks7dQb.getRawOne.mockResolvedValueOnce({ count: '700' });
      const clicks30dQb = makeQb();
      clicks30dQb.getRawOne.mockResolvedValueOnce({ count: '3000' });

      const topLinksQb = makeQb();
      topLinksQb.getRawMany.mockResolvedValueOnce([
        { id: 'l1', title: 'A', shortCode: 'a', clicks: '50' },
      ]);

      // clickEventRepository.manager.createQueryBuilder calls order:
      // 1) totalLinks, 2-4) clicks windows, 5) topLinks
      clickEventRepository.manager.createQueryBuilder
        .mockReturnValueOnce(totalLinksQb)
        .mockReturnValueOnce(clicks24hQb)
        .mockReturnValueOnce(clicks7dQb)
        .mockReturnValueOnce(clicks30dQb)
        .mockReturnValueOnce(topLinksQb);

      const totalConvQb = makeQb();
      totalConvQb.getRawOne.mockResolvedValueOnce({ count: '25' });
      conversionEventRepository.manager.createQueryBuilder.mockReturnValueOnce(totalConvQb);

      const result = await service.getDashboardStats(caller);

      // All four statements use the caller's visible projects, not owner_id.
      for (const qb of [totalLinksQb, clicks24hQb, clicks7dQb, clicks30dQb, topLinksQb, totalConvQb]) {
        expect(qb.where).toHaveBeenCalledWith('p.id IN (SELECT member_project_ids)', {
          projectAccess_userId: 'user-1',
        });
      }
      expect(projectAccess.memberProjectsQuery).toHaveBeenCalledWith(caller);
      expect(result).toEqual({
        totalLinks: 10,
        clicks24h: 100,
        clicks7d: 700,
        clicks30d: 3000,
        totalConversions: 25,
        topLinks: [{ id: 'l1', title: 'A', shortCode: 'a', clicks: 50 }],
      });
    });

    it('handles missing rows with zero defaults', async () => {
      const stubQb = () => {
        const q = makeQb();
        q.getRawOne.mockResolvedValueOnce(null);
        q.getRawMany.mockResolvedValueOnce([]);
        return q;
      };

      clickEventRepository.manager.createQueryBuilder
        .mockReturnValueOnce(stubQb())
        .mockReturnValueOnce(stubQb())
        .mockReturnValueOnce(stubQb())
        .mockReturnValueOnce(stubQb())
        .mockReturnValueOnce(stubQb());

      conversionEventRepository.manager.createQueryBuilder.mockReturnValueOnce(stubQb());

      const result = await service.getDashboardStats(caller);

      expect(result.totalLinks).toBe(0);
      expect(result.clicks24h).toBe(0);
      expect(result.totalConversions).toBe(0);
      expect(result.topLinks).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getProjectAnalyticsSummary
  // ---------------------------------------------------------------------------
  describe('getProjectAnalyticsSummary', () => {
    it('scopes all counts to the given projectId', async () => {
      const totalClicksQb = makeQb();
      totalClicksQb.getCount.mockResolvedValueOnce(200);

      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '80' });

      const appOpensQb = makeQb();
      appOpensQb.getCount.mockResolvedValueOnce(30);

      const storeQb = makeQb();
      storeQb.getCount.mockResolvedValueOnce(20);

      const matchedQb = makeQb();
      matchedQb.getCount.mockResolvedValueOnce(10);

      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(totalClicksQb)
        .mockReturnValueOnce(uniqueQb)
        .mockReturnValueOnce(appOpensQb)
        .mockReturnValueOnce(storeQb)
        .mockReturnValueOnce(matchedQb);

      const convQb = makeQb();
      convQb.getRawMany.mockResolvedValueOnce([{ eventType: 'signup', count: 20 }]);
      conversionEventRepository.createQueryBuilder.mockReturnValueOnce(convQb);

      const result = await service.getProjectAnalyticsSummary('proj-1');

      expect(result.totalClicks).toBe(200);
      expect(result.uniqueVisitors).toBe(80);
      expect(result.appOpens).toBe(30);
      expect(result.storeRedirects).toBe(20);
      expect(result.matchedInstalls).toBe(10);
      expect(result.conversionRate).toBe(0.1);
      expect(totalClicksQb.where).toHaveBeenCalledWith('l.project_id = :projectId', {
        projectId: 'proj-1',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getProjectTimeseries
  // ---------------------------------------------------------------------------
  describe('getProjectTimeseries', () => {
    it('scopes timeseries to a project', async () => {
      clickQb.getRawMany.mockResolvedValueOnce([{ date: '2025-01-01', clicks: '5' }]);

      const result = await service.getProjectTimeseries(
        'proj-1',
        new Date('2025-01-01'),
        new Date('2025-01-31'),
        'day',
      );

      expect(clickQb.innerJoin).toHaveBeenCalledWith('links', 'l', 'click.link_id = l.id');
      expect(clickQb.where).toHaveBeenCalledWith('l.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(result).toEqual([{ date: '2025-01-01', clicks: 5 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // getProjectDeviceBreakdown
  // ---------------------------------------------------------------------------
  describe('getProjectDeviceBreakdown', () => {
    it('returns project-scoped device, OS and browser breakdowns', async () => {
      const deviceQb = makeQb();
      deviceQb.getRawMany.mockResolvedValueOnce([{ name: 'mobile', count: '10' }]);
      const osQb = makeQb();
      osQb.getRawMany.mockResolvedValueOnce([{ name: 'iOS', count: '5' }]);
      const browserQb = makeQb();
      browserQb.getRawMany.mockResolvedValueOnce([{ name: 'Chrome', count: '3' }]);

      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(deviceQb)
        .mockReturnValueOnce(osQb)
        .mockReturnValueOnce(browserQb);

      const result = await service.getProjectDeviceBreakdown('proj-1');

      expect(result).toEqual({
        deviceTypes: [{ name: 'mobile', count: 10 }],
        operatingSystems: [{ name: 'iOS', count: 5 }],
        browsers: [{ name: 'Chrome', count: 3 }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getProjectGeoBreakdown
  // ---------------------------------------------------------------------------
  describe('getProjectGeoBreakdown', () => {
    it('returns project-scoped geo breakdown', async () => {
      const countriesQb = makeQb();
      countriesQb.getRawMany.mockResolvedValueOnce([
        { name: 'US', code: 'US', count: '10' },
      ]);
      const citiesQb = makeQb();
      citiesQb.getRawMany.mockResolvedValueOnce([]);
      const pointsQb = makeQb();
      pointsQb.getRawMany.mockResolvedValueOnce([]);

      clickEventRepository.createQueryBuilder
        .mockReturnValueOnce(countriesQb)
        .mockReturnValueOnce(citiesQb)
        .mockReturnValueOnce(pointsQb);

      const result = await service.getProjectGeoBreakdown('proj-1');

      expect(result.countries).toEqual([{ name: 'US', code: 'US', count: 10 }]);
      expect(result.cities).toEqual([]);
      expect(result.points).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getProjectReferrers
  // ---------------------------------------------------------------------------
  describe('getProjectReferrers', () => {
    it('returns project-scoped referrers', async () => {
      clickQb.getRawMany.mockResolvedValueOnce([{ referrer: 'https://x.com', count: '7' }]);

      const result = await service.getProjectReferrers('proj-1');

      expect(clickQb.innerJoin).toHaveBeenCalledWith('links', 'l', 'click.link_id = l.id');
      expect(result).toEqual([{ referrer: 'https://x.com', count: 7 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // getProjectDashboardStats
  // ---------------------------------------------------------------------------
  describe('getProjectDashboardStats', () => {
    it('returns aggregated totals and top links scoped to project', async () => {
      const totalLinksQb = makeQb();
      totalLinksQb.getRawOne.mockResolvedValueOnce({ count: '3' });

      const clicks24hQb = makeQb();
      clicks24hQb.getRawOne.mockResolvedValueOnce({ count: '10' });
      const clicks7dQb = makeQb();
      clicks7dQb.getRawOne.mockResolvedValueOnce({ count: '70' });
      const clicks30dQb = makeQb();
      clicks30dQb.getRawOne.mockResolvedValueOnce({ count: '300' });

      const topLinksQb = makeQb();
      topLinksQb.getRawMany.mockResolvedValueOnce([
        { id: 'l1', title: 'A', shortCode: 'a', clicks: '30' },
      ]);

      clickEventRepository.manager.createQueryBuilder
        .mockReturnValueOnce(totalLinksQb)
        .mockReturnValueOnce(clicks24hQb)
        .mockReturnValueOnce(clicks7dQb)
        .mockReturnValueOnce(clicks30dQb)
        .mockReturnValueOnce(topLinksQb);

      const totalConvQb = makeQb();
      totalConvQb.getRawOne.mockResolvedValueOnce({ count: '5' });
      conversionEventRepository.manager.createQueryBuilder.mockReturnValueOnce(totalConvQb);

      const result = await service.getProjectDashboardStats('proj-1');

      expect(result.totalLinks).toBe(3);
      expect(result.clicks24h).toBe(10);
      expect(result.clicks7d).toBe(70);
      expect(result.clicks30d).toBe(300);
      expect(result.totalConversions).toBe(5);
      expect(result.topLinks).toEqual([
        { id: 'l1', title: 'A', shortCode: 'a', clicks: 30 },
      ]);
    });
  });
});
