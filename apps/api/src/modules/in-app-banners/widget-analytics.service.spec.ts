import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WidgetAnalyticsService } from './widget-analytics.service';
import { WidgetEventEntity } from './entities/widget-event.entity';

describe('WidgetAnalyticsService', () => {
  let service: WidgetAnalyticsService;

  const makeQb = () => {
    const q: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
      getRawMany: jest.fn(),
    };
    return q;
  };

  // Each call to createQueryBuilder returns a fresh queue-controlled builder
  const qbQueue: any[] = [];

  const mockEventRepo = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => {
      const q = qbQueue.shift() || makeQb();
      return q;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    qbQueue.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WidgetAnalyticsService,
        { provide: getRepositoryToken(WidgetEventEntity), useValue: mockEventRepo },
      ],
    }).compile();

    service = module.get<WidgetAnalyticsService>(WidgetAnalyticsService);
  });

  describe('getSummary', () => {
    it('computes totals, ctr, and unique visitors', async () => {
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '42' });
      qbQueue.push(uniqueQb);

      mockEventRepo.count
        .mockResolvedValueOnce(200) // impressions
        .mockResolvedValueOnce(50); // clicks

      const result = await service.getSummary('cat-1');

      expect(result.totalImpressions).toBe(200);
      expect(result.totalClicks).toBe(50);
      expect(result.ctr).toBeCloseTo(0.25);
      expect(result.uniqueVisitors).toBe(42);
    });

    it('returns ctr = 0 when there are no impressions', async () => {
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      qbQueue.push(uniqueQb);

      mockEventRepo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const result = await service.getSummary('cat-1');

      expect(result.ctr).toBe(0);
      expect(result.uniqueVisitors).toBe(0);
    });

    it('handles null unique result (no rows)', async () => {
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce(null);
      qbQueue.push(uniqueQb);

      mockEventRepo.count.mockResolvedValueOnce(10).mockResolvedValueOnce(0);

      const result = await service.getSummary('cat-1');

      expect(result.uniqueVisitors).toBe(0);
    });
  });

  describe('getTimeseries', () => {
    it('buckets results by the provided granularity', async () => {
      const tsQb = makeQb();
      tsQb.getRawMany.mockResolvedValueOnce([
        { date: '2024-01-01', impressions: '10', clicks: '1' },
        { date: '2024-01-02', impressions: '20', clicks: '2' },
      ]);
      qbQueue.push(tsQb);

      const result = await service.getTimeseries(
        'cat-1',
        new Date('2024-01-01'),
        new Date('2024-01-10'),
        'day',
      );

      expect(result).toEqual([
        { date: '2024-01-01', impressions: 10, clicks: 1 },
        { date: '2024-01-02', impressions: 20, clicks: 2 },
      ]);
      // verify select was called with a DATE_TRUNC with "day"
      expect(tsQb.select).toHaveBeenCalledWith(expect.stringContaining("'day'"), 'date');
    });

    it('falls back to "day" when an unknown granularity is provided', async () => {
      const tsQb = makeQb();
      tsQb.getRawMany.mockResolvedValueOnce([]);
      qbQueue.push(tsQb);

      await service.getTimeseries('cat-1', new Date(), new Date(), 'unknown' as any);

      expect(tsQb.select).toHaveBeenCalledWith(expect.stringContaining("'day'"), 'date');
    });
  });

  describe('getDeviceBreakdown', () => {
    it('returns mapped device/os/browser breakdowns', async () => {
      const dQb = makeQb();
      dQb.getRawMany.mockResolvedValueOnce([{ name: 'mobile', count: '10' }]);
      const oQb = makeQb();
      oQb.getRawMany.mockResolvedValueOnce([{ name: 'iOS', count: '7' }]);
      const bQb = makeQb();
      bQb.getRawMany.mockResolvedValueOnce([{ name: 'Chrome', count: '8' }]);
      qbQueue.push(dQb, oQb, bQb);

      const result = await service.getDeviceBreakdown('cat-1');

      expect(result.deviceTypes).toEqual([{ name: 'mobile', count: 10 }]);
      expect(result.operatingSystems).toEqual([{ name: 'iOS', count: 7 }]);
      expect(result.browsers).toEqual([{ name: 'Chrome', count: 8 }]);
    });
  });

  describe('getGeoBreakdown', () => {
    it('returns mapped country and city breakdowns', async () => {
      const cQb = makeQb();
      cQb.getRawMany.mockResolvedValueOnce([{ name: 'United States', code: 'US', count: '15' }]);
      const ciQb = makeQb();
      ciQb.getRawMany.mockResolvedValueOnce([{ name: 'San Francisco', country: 'United States', count: '5' }]);
      qbQueue.push(cQb, ciQb);

      const result = await service.getGeoBreakdown('cat-1');

      expect(result.countries).toEqual([{ name: 'United States', code: 'US', count: 15 }]);
      expect(result.cities).toEqual([{ name: 'San Francisco', country: 'United States', count: 5 }]);
    });
  });

  describe('getItemStats', () => {
    it('computes per-item CTR', async () => {
      const itemQb = makeQb();
      itemQb.getRawMany.mockResolvedValueOnce([
        { bannerId: 'b1', title: 'B1', impressions: '100', clicks: '25' },
        { bannerId: 'b2', title: 'B2', impressions: '0', clicks: '0' },
      ]);
      qbQueue.push(itemQb);

      const result = await service.getItemStats('cat-1');

      expect(result.items[0]).toEqual({
        bannerId: 'b1',
        title: 'B1',
        impressions: 100,
        clicks: 25,
        ctr: 0.25,
      });
      // divide-by-zero guard
      expect(result.items[1].ctr).toBe(0);
    });
  });
});
