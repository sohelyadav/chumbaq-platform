import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AttributionService } from './attribution.service';
import { AttributionResultEntity } from './entities/attribution-result.entity';
import { TouchpointsService } from '../touchpoints/touchpoints.service';
import { TouchpointEntity } from '../touchpoints/entities/touchpoint.entity';

describe('AttributionService', () => {
  let service: AttributionService;
  let resultRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let touchpointsService: {
    getJourneyBeforeConversion: jest.Mock;
  };
  let qbMock: {
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  };

  const tp = (
    id: string,
    touchedAt: Date,
    overrides: Partial<TouchpointEntity> = {},
  ): TouchpointEntity =>
    ({
      id,
      touchedAt,
      touchpointType: 'link_click',
      channel: 'google',
      campaign: 'spring',
      utmSource: 'google',
      utmMedium: 'cpc',
      linkId: 'link-1',
      ...overrides,
    } as unknown as TouchpointEntity);

  beforeEach(async () => {
    qbMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    resultRepo = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve(x)),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => qbMock),
    };

    touchpointsService = {
      getJourneyBeforeConversion: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttributionService,
        {
          provide: getRepositoryToken(AttributionResultEntity),
          useValue: resultRepo,
        },
        {
          provide: TouchpointsService,
          useValue: touchpointsService,
        },
      ],
    }).compile();

    service = module.get<AttributionService>(AttributionService);
  });

  // ---------------------------------------------------------------------------
  // attributeConversion — individual models
  // ---------------------------------------------------------------------------
  describe('attributeConversion', () => {
    const conversionTime = new Date('2024-01-15T12:00:00Z');

    it('defaults to linear model with 30 day lookback', async () => {
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce([]);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
      });

      expect(touchpointsService.getJourneyBeforeConversion).toHaveBeenCalledWith(
        'proj-1',
        'user-1',
        conversionTime,
        30,
      );
      expect(resultRepo.create.mock.calls[0][0].model).toBe('linear');
    });

    it('produces empty creditSplits when there is no touchpoint history', async () => {
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce([]);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
        model: 'linear',
      });

      const created = resultRepo.create.mock.calls[0][0];
      expect(created.creditSplits).toEqual([]);
      expect(created.touchpointCount).toBe(0);
    });

    it('assigns 100% credit to the last touch for last_touch model', async () => {
      const touchpoints = [
        tp('tp-1', new Date('2024-01-01'), { channel: 'google' }),
        tp('tp-2', new Date('2024-01-05'), { channel: 'facebook' }),
        tp('tp-3', new Date('2024-01-10'), { channel: 'email' }),
      ];
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce(touchpoints);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
        model: 'last_touch',
      });

      const splits = resultRepo.create.mock.calls[0][0].creditSplits;
      // lastTouch sorts DESC so index 0 is the most recent
      expect(splits).toHaveLength(3);
      const lastTouched = splits.find((s: any) => s.touchpointId === 'tp-3');
      expect(lastTouched.credit).toBe(1);
      const first = splits.find((s: any) => s.touchpointId === 'tp-1');
      const second = splits.find((s: any) => s.touchpointId === 'tp-2');
      expect(first.credit).toBe(0);
      expect(second.credit).toBe(0);
    });

    it('assigns 100% credit to the first touch for first_touch model', async () => {
      const touchpoints = [
        tp('tp-1', new Date('2024-01-01')),
        tp('tp-2', new Date('2024-01-05')),
        tp('tp-3', new Date('2024-01-10')),
      ];
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce(touchpoints);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
        model: 'first_touch',
      });

      const splits = resultRepo.create.mock.calls[0][0].creditSplits;
      const first = splits.find((s: any) => s.touchpointId === 'tp-1');
      expect(first.credit).toBe(1);
      const second = splits.find((s: any) => s.touchpointId === 'tp-2');
      const third = splits.find((s: any) => s.touchpointId === 'tp-3');
      expect(second.credit).toBe(0);
      expect(third.credit).toBe(0);
    });

    it('splits credit evenly across all touchpoints for linear model', async () => {
      const touchpoints = [
        tp('tp-1', new Date('2024-01-01')),
        tp('tp-2', new Date('2024-01-05')),
        tp('tp-3', new Date('2024-01-10')),
        tp('tp-4', new Date('2024-01-12')),
      ];
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce(touchpoints);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
        model: 'linear',
      });

      const splits = resultRepo.create.mock.calls[0][0].creditSplits;
      expect(splits).toHaveLength(4);
      splits.forEach((s: any) => expect(s.credit).toBe(0.25));
      const sum = splits.reduce((acc: number, s: any) => acc + s.credit, 0);
      expect(sum).toBeCloseTo(1);
    });

    it('assigns more credit to recent touchpoints for time_decay model and credits sum to ~1', async () => {
      const touchpoints = [
        tp('tp-1', new Date('2024-01-01')),
        tp('tp-2', new Date('2024-01-05')),
        tp('tp-3', new Date('2024-01-10')),
      ];
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce(touchpoints);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
        model: 'time_decay',
      });

      const splits = resultRepo.create.mock.calls[0][0].creditSplits;
      expect(splits).toHaveLength(3);
      const t1 = splits.find((s: any) => s.touchpointId === 'tp-1').credit;
      const t2 = splits.find((s: any) => s.touchpointId === 'tp-2').credit;
      const t3 = splits.find((s: any) => s.touchpointId === 'tp-3').credit;
      expect(t1).toBeLessThan(t2);
      expect(t2).toBeLessThan(t3);
      const sum = t1 + t2 + t3;
      expect(sum).toBeCloseTo(1, 3);
    });

    it('respects a custom lookbackDays override', async () => {
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce([]);

      await service.attributeConversion({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime,
        model: 'linear',
        lookbackDays: 7,
      });

      expect(touchpointsService.getJourneyBeforeConversion).toHaveBeenCalledWith(
        'proj-1',
        'user-1',
        conversionTime,
        7,
      );
      expect(resultRepo.create.mock.calls[0][0].lookbackDays).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------
  // attributeAllModels
  // ---------------------------------------------------------------------------
  describe('attributeAllModels', () => {
    it('produces one result per attribution model', async () => {
      touchpointsService.getJourneyBeforeConversion.mockResolvedValueOnce([
        tp('tp-1', new Date('2024-01-01')),
        tp('tp-2', new Date('2024-01-05')),
      ]);
      resultRepo.save.mockImplementationOnce((xs) => Promise.resolve(xs));

      const results = await service.attributeAllModels({
        projectId: 'proj-1',
        conversionId: 'conv-1',
        distinctId: 'user-1',
        conversionTime: new Date(),
      });

      const models = results.map((r: any) => r.model).sort();
      expect(models).toEqual(
        ['first_touch', 'last_touch', 'linear', 'time_decay'].sort(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getChannelAttribution
  // ---------------------------------------------------------------------------
  describe('getChannelAttribution', () => {
    it('aggregates credit by channel and sorts DESC by credit', async () => {
      qbMock.getMany.mockResolvedValueOnce([
        {
          conversionId: 'c1',
          creditSplits: [
            { channel: 'google', credit: 0.5 },
            { channel: 'facebook', credit: 0.5 },
          ],
        },
        {
          conversionId: 'c2',
          creditSplits: [
            { channel: 'google', credit: 1 },
          ],
        },
      ]);

      const result = await service.getChannelAttribution('proj-1');

      expect(result[0].channel).toBe('google');
      expect(result[0].credit).toBe(1.5);
      expect(result[0].conversions).toBe(2);
      expect(result[1].channel).toBe('facebook');
      expect(result[1].credit).toBe(0.5);
      expect(result[1].conversions).toBe(1);
    });

    it('uses "unknown" for splits missing a channel', async () => {
      qbMock.getMany.mockResolvedValueOnce([
        {
          conversionId: 'c1',
          creditSplits: [{ channel: null, credit: 1 }],
        },
      ]);

      const result = await service.getChannelAttribution('proj-1');
      expect(result[0].channel).toBe('unknown');
    });

    it('applies date range filters when start and end are provided', async () => {
      qbMock.getMany.mockResolvedValueOnce([]);

      const start = new Date('2024-01-01');
      const end = new Date('2024-02-01');
      await service.getChannelAttribution('proj-1', 'linear', start, end);

      const andWhereCalls = qbMock.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereCalls).toEqual(
        expect.arrayContaining([
          'ar.model = :model',
          'ar.created_at >= :start',
          'ar.created_at <= :end',
        ]),
      );
    });

    it('returns an empty array when there are no attribution results', async () => {
      qbMock.getMany.mockResolvedValueOnce([]);

      const result = await service.getChannelAttribution('proj-1');

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getCampaignAttribution
  // ---------------------------------------------------------------------------
  describe('getCampaignAttribution', () => {
    it('aggregates credit by campaign::channel key', async () => {
      qbMock.getMany.mockResolvedValueOnce([
        {
          conversionId: 'c1',
          creditSplits: [
            { channel: 'google', campaign: 'spring', credit: 0.5 },
            { channel: 'google', campaign: 'fall', credit: 0.5 },
          ],
        },
      ]);

      const result = await service.getCampaignAttribution('proj-1');

      expect(result).toHaveLength(2);
      expect(result.some((r) => r.campaign === 'spring')).toBe(true);
      expect(result.some((r) => r.campaign === 'fall')).toBe(true);
    });

    it('uses "none" when campaign is missing', async () => {
      qbMock.getMany.mockResolvedValueOnce([
        {
          conversionId: 'c1',
          creditSplits: [{ channel: 'google', campaign: null, credit: 1 }],
        },
      ]);

      const result = await service.getCampaignAttribution('proj-1');
      expect(result[0].campaign).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // getConversionAttribution
  // ---------------------------------------------------------------------------
  describe('getConversionAttribution', () => {
    it('queries attribution results by conversion and project, ordered by model ASC', async () => {
      resultRepo.find.mockResolvedValueOnce([]);

      await service.getConversionAttribution('proj-1', 'conv-1');

      expect(resultRepo.find).toHaveBeenCalledWith({
        where: { conversionId: 'conv-1', projectId: 'proj-1' },
        order: { model: 'ASC' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getModelComparison
  // ---------------------------------------------------------------------------
  describe('getModelComparison', () => {
    it('returns a record keyed by each of the 4 models', async () => {
      qbMock.getMany.mockResolvedValue([]);

      const result = await service.getModelComparison('proj-1');

      expect(Object.keys(result).sort()).toEqual(
        ['first_touch', 'last_touch', 'linear', 'time_decay'].sort(),
      );
    });
  });
});
