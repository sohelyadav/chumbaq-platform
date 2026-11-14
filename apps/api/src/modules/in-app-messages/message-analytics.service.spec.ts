import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessageAnalyticsService } from './message-analytics.service';
import { InAppMessageImpressionEntity } from './entities/in-app-message-impression.entity';
import { InAppMessageEntity } from './entities/in-app-message.entity';

describe('MessageAnalyticsService', () => {
  let service: MessageAnalyticsService;

  const makeQb = () => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
    getRawOne: jest.fn(),
  });

  // Control the sequence of query builders returned by createQueryBuilder.
  let qbQueue: any[] = [];

  const mockImpressionRepo = {
    createQueryBuilder: jest.fn(() => {
      return qbQueue.shift() || makeQb();
    }),
  };

  const mockMessageRepo: any = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => qbQueue.shift() || makeQb()),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    qbQueue = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageAnalyticsService,
        { provide: getRepositoryToken(InAppMessageImpressionEntity), useValue: mockImpressionRepo },
        { provide: getRepositoryToken(InAppMessageEntity), useValue: mockMessageRepo },
      ],
    }).compile();

    service = module.get<MessageAnalyticsService>(MessageAnalyticsService);
  });

  describe('getSummary', () => {
    it('computes clickRate and dismissRate from event counts', async () => {
      const eventQb = makeQb();
      eventQb.getRawMany.mockResolvedValueOnce([
        { eventType: 'impression', count: '1000' },
        { eventType: 'click', count: '80' },
        { eventType: 'cta_click', count: '20' },
        { eventType: 'dismiss', count: '50' },
        { eventType: 'delivered', count: '1050' },
        { eventType: 'auto_dismiss', count: '5' },
      ]);
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '777' });
      qbQueue.push(eventQb, uniqueQb);

      const result = await service.getSummary('m1', 'proj-1');

      expect(result.messageId).toBe('m1');
      expect(result.totalImpressions).toBe(1000);
      expect(result.totalClicks).toBe(80);
      expect(result.totalCtaClicks).toBe(20);
      expect(result.totalDismissals).toBe(50);
      expect(result.totalDelivered).toBe(1050);
      expect(result.totalAutoDismissals).toBe(5);
      expect(result.uniqueUsers).toBe(777);
      // clickRate = (click + cta_click) / impressions = 100 / 1000
      expect(result.clickRate).toBeCloseTo(0.1);
      // dismissRate = dismiss / impressions = 50 / 1000
      expect(result.dismissRate).toBeCloseTo(0.05);
    });

    it('returns zero rates when impressions are zero', async () => {
      const eventQb = makeQb();
      eventQb.getRawMany.mockResolvedValueOnce([]);
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      qbQueue.push(eventQb, uniqueQb);

      const result = await service.getSummary('m1', 'proj-1');

      expect(result.totalImpressions).toBe(0);
      expect(result.clickRate).toBe(0);
      expect(result.dismissRate).toBe(0);
      expect(result.uniqueUsers).toBe(0);
    });

    it('handles a null unique-users row gracefully', async () => {
      const eventQb = makeQb();
      eventQb.getRawMany.mockResolvedValueOnce([]);
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce(null);
      qbQueue.push(eventQb, uniqueQb);

      const result = await service.getSummary('m1', 'proj-1');

      expect(result.uniqueUsers).toBe(0);
    });
  });

  describe('getFunnel', () => {
    it('derives funnel from the summary numbers', async () => {
      const eventQb = makeQb();
      eventQb.getRawMany.mockResolvedValueOnce([
        { eventType: 'impression', count: '100' },
        { eventType: 'click', count: '10' },
        { eventType: 'cta_click', count: '5' },
        { eventType: 'dismiss', count: '3' },
        { eventType: 'delivered', count: '120' },
      ]);
      const uniqueQb = makeQb();
      uniqueQb.getRawOne.mockResolvedValueOnce({ count: '50' });
      qbQueue.push(eventQb, uniqueQb);

      const result = await service.getFunnel('m1', 'proj-1');

      expect(result).toEqual({
        delivered: 120,
        impressions: 100,
        clicks: 10,
        ctaClicks: 5,
        dismissals: 3,
      });
    });
  });

  describe('getButtonBreakdown', () => {
    it('returns button-level click counts', async () => {
      const qb = makeQb();
      const expected = [
        { buttonId: 'primary', clicks: 30 },
        { buttonId: 'secondary', clicks: 10 },
      ];
      qb.getRawMany.mockResolvedValueOnce(expected);
      qbQueue.push(qb);

      const result = await service.getButtonBreakdown('m1', 'proj-1');

      expect(result).toEqual(expected);
      // cta_click filter must be applied
      expect(qb.andWhere).toHaveBeenCalledWith('imp.event_type = :type', { type: 'cta_click' });
    });
  });

  describe('getTimeseries', () => {
    it('pivots event rows into date-bucketed records', async () => {
      const qb = makeQb();
      qb.getRawMany.mockResolvedValueOnce([
        { date: '2024-01-01', eventType: 'impression', count: '10' },
        { date: '2024-01-01', eventType: 'click', count: '2' },
        { date: '2024-01-01', eventType: 'cta_click', count: '1' },
        { date: '2024-01-01', eventType: 'dismiss', count: '1' },
        { date: '2024-01-02', eventType: 'impression', count: '5' },
      ]);
      qbQueue.push(qb);

      const result = await service.getTimeseries('m1', 'proj-1', {
        start: '2024-01-01',
        end: '2024-01-31',
        granularity: 'day',
      });

      expect(result).toHaveLength(2);
      const day1 = result.find((r) => r.date === '2024-01-01')!;
      expect(day1.impressions).toBe(10);
      // clicks counts both click and cta_click
      expect(day1.clicks).toBe(3);
      expect(day1.dismissals).toBe(1);

      const day2 = result.find((r) => r.date === '2024-01-02')!;
      expect(day2.impressions).toBe(5);
      expect(day2.clicks).toBe(0);
    });

    it('defaults to the last 30 days and day granularity when options are empty', async () => {
      const qb = makeQb();
      qb.getRawMany.mockResolvedValueOnce([]);
      qbQueue.push(qb);

      await service.getTimeseries('m1', 'proj-1', {});

      expect(qb.select).toHaveBeenCalledWith(expect.stringContaining("'day'"), 'date');
      // start param should be a Date (~30 days ago)
      const callArgs = qb.andWhere.mock.calls;
      const startCall = callArgs.find((c: any[]) => c[0] === 'imp.created_at >= :start');
      expect(startCall[1].start).toBeInstanceOf(Date);
    });

    it('honors a custom granularity', async () => {
      const qb = makeQb();
      qb.getRawMany.mockResolvedValueOnce([]);
      qbQueue.push(qb);

      await service.getTimeseries('m1', 'proj-1', { granularity: 'hour' });

      expect(qb.select).toHaveBeenCalledWith(expect.stringContaining("'hour'"), 'date');
    });

    // granularity arrives as a bare query string: its union type exists only at
    // compile time, so a value that is not one of the three units must never reach
    // the SQL text.
    it.each([
      ["day', imp.created_at)::text || (SELECT 'INJECTED') || DATE_TRUNC('day"],
      ['month'],
      [['hour', 'day']],
    ])('falls back to day and keeps %j out of the SQL', async (granularity) => {
      const qb = makeQb();
      qb.getRawMany.mockResolvedValueOnce([]);
      qbQueue.push(qb);

      await service.getTimeseries('m1', 'proj-1', { granularity: granularity as any });

      expect(qb.select).toHaveBeenCalledWith("DATE_TRUNC('day', imp.created_at)", 'date');
      expect(qb.groupBy).toHaveBeenCalledWith("DATE_TRUNC('day', imp.created_at)");
    });
  });

  describe('getPlatformBreakdown', () => {
    it('returns platform-level impression counts', async () => {
      const qb = makeQb();
      const expected = [
        { platform: 'ios', count: 100 },
        { platform: 'android', count: 50 },
      ];
      qb.getRawMany.mockResolvedValueOnce(expected);
      qbQueue.push(qb);

      const result = await service.getPlatformBreakdown('m1', 'proj-1');

      expect(result).toEqual(expected);
      expect(qb.andWhere).toHaveBeenCalledWith('imp.event_type = :type', { type: 'impression' });
    });
  });

  describe('getProjectSummary', () => {
    it('aggregates campaigns and computes avgClickRate', async () => {
      mockMessageRepo.count
        .mockResolvedValueOnce(10) // totalCampaigns
        .mockResolvedValueOnce(4); // activeCampaigns

      const qb = makeQb();
      qb.getRawOne.mockResolvedValueOnce({ totalImpressions: '1000', totalClicks: '125' });
      qbQueue.push(qb);

      const result = await service.getProjectSummary('proj-1');

      expect(result.totalCampaigns).toBe(10);
      expect(result.activeCampaigns).toBe(4);
      expect(result.totalImpressions).toBe(1000);
      expect(result.totalClicks).toBe(125);
      expect(result.avgClickRate).toBeCloseTo(0.125);
    });

    it('returns avgClickRate=0 when there are no impressions', async () => {
      mockMessageRepo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      const qb = makeQb();
      qb.getRawOne.mockResolvedValueOnce({ totalImpressions: '0', totalClicks: '0' });
      qbQueue.push(qb);

      const result = await service.getProjectSummary('proj-1');

      expect(result.avgClickRate).toBe(0);
    });
  });
});
