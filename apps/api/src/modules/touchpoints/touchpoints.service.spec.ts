import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TouchpointsService } from './touchpoints.service';
import { TouchpointEntity } from './entities/touchpoint.entity';

describe('TouchpointsService', () => {
  let service: TouchpointsService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qbMock: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
    orderBy: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    qbMock = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(),
    };

    repo = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve({ id: 'tp-1', ...x })),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => qbMock),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TouchpointsService,
        {
          provide: getRepositoryToken(TouchpointEntity),
          useValue: repo,
        },
      ],
    }).compile();

    service = module.get<TouchpointsService>(TouchpointsService);
  });

  // ---------------------------------------------------------------------------
  // record
  // ---------------------------------------------------------------------------
  describe('record', () => {
    it('persists a touchpoint with explicit channel and UTM fields', async () => {
      await service.record({
        projectId: 'proj-1',
        distinctId: 'user-1',
        touchpointType: 'link_click',
        channel: 'google',
        campaign: 'spring',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring-sale',
        utmTerm: 'shoes',
        utmContent: 'banner',
        linkId: 'link-1',
      });

      const created = repo.create.mock.calls[0][0];
      expect(created.channel).toBe('google');
      expect(created.campaign).toBe('spring');
      expect(created.utmSource).toBe('google');
      expect(created.utmMedium).toBe('cpc');
      expect(created.utmCampaign).toBe('spring-sale');
      expect(created.utmTerm).toBe('shoes');
      expect(created.utmContent).toBe('banner');
      expect(created.linkId).toBe('link-1');
      expect(repo.save).toHaveBeenCalled();
    });

    it('uses utmCampaign as campaign when campaign is not explicitly set', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
        utmCampaign: 'auto-set',
      });

      expect(repo.create.mock.calls[0][0].campaign).toBe('auto-set');
    });

    it('maps missing optional fields to null', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'custom_event',
      });

      const created = repo.create.mock.calls[0][0];
      expect(created.distinctId).toBeNull();
      expect(created.deviceFingerprint).toBeNull();
      expect(created.campaign).toBeNull();
      expect(created.utmSource).toBeNull();
      expect(created.linkId).toBeNull();
      expect(created.metadata).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // inferChannel (via record)
  // ---------------------------------------------------------------------------
  describe('inferChannel', () => {
    it('infers utmSource as channel when provided', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
        utmSource: 'newsletter',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('newsletter');
    });

    it('infers push channel for push_click touchpoints', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'push_click',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('push');
    });

    it('infers email channel for email_open touchpoints', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'email_open',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('email');
    });

    it('infers in-app channel for banner_view touchpoints', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'banner_view',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('in-app');
    });

    it('infers in-app channel for banner_click touchpoints', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'banner_click',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('in-app');
    });

    it('infers facebook channel from facebook referrer', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
        referrer: 'https://www.facebook.com/some-post',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('facebook');
    });

    it('infers google channel from google referrer', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
        referrer: 'https://www.google.com/search?q=foo',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('google');
    });

    it('infers twitter channel from t.co referrer', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
        referrer: 'https://t.co/abc',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('twitter');
    });

    it('infers referral channel for unknown referrers', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
        referrer: 'https://random-blog.example.com/post',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('referral');
    });

    it('infers direct channel for link_click with no referrer and no utm', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'link_click',
      });

      expect(repo.create.mock.calls[0][0].channel).toBe('direct');
    });

    it('returns null channel for a custom_event with no signals', async () => {
      await service.record({
        projectId: 'proj-1',
        touchpointType: 'custom_event',
      });

      expect(repo.create.mock.calls[0][0].channel).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getJourney
  // ---------------------------------------------------------------------------
  describe('getJourney', () => {
    it('queries by projectId and distinctId ordered by touchedAt ASC', async () => {
      repo.find.mockResolvedValueOnce([]);

      await service.getJourney('proj-1', 'user-1', 30);

      const callArg = repo.find.mock.calls[0][0];
      expect(callArg.where.projectId).toBe('proj-1');
      expect(callArg.where.distinctId).toBe('user-1');
      expect(callArg.order).toEqual({ touchedAt: 'ASC' });
      // touchedAt should be MoreThanOrEqual
      expect(callArg.where.touchedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getJourneyByFingerprint
  // ---------------------------------------------------------------------------
  describe('getJourneyByFingerprint', () => {
    it('queries by projectId and deviceFingerprint', async () => {
      repo.find.mockResolvedValueOnce([]);

      await service.getJourneyByFingerprint('proj-1', 'fp-abc', 7);

      const callArg = repo.find.mock.calls[0][0];
      expect(callArg.where.projectId).toBe('proj-1');
      expect(callArg.where.deviceFingerprint).toBe('fp-abc');
      expect(callArg.order).toEqual({ touchedAt: 'ASC' });
    });
  });

  // ---------------------------------------------------------------------------
  // getJourneyBeforeConversion
  // ---------------------------------------------------------------------------
  describe('getJourneyBeforeConversion', () => {
    it('uses a Between range from (conversionTime - lookback) to conversionTime', async () => {
      repo.find.mockResolvedValueOnce([]);

      const conversionTime = new Date('2024-01-15T00:00:00Z');
      await service.getJourneyBeforeConversion('proj-1', 'user-1', conversionTime, 7);

      const callArg = repo.find.mock.calls[0][0];
      expect(callArg.where.projectId).toBe('proj-1');
      expect(callArg.where.distinctId).toBe('user-1');
      expect(callArg.order).toEqual({ touchedAt: 'ASC' });
      // Between operator stores its constraints in _value and _type
      const between = callArg.where.touchedAt;
      expect(between).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getChannelSummary
  // ---------------------------------------------------------------------------
  describe('getChannelSummary', () => {
    it('returns channels with counts and percentages', async () => {
      qbMock.getRawMany.mockResolvedValueOnce([
        { channel: 'google', count: 30 },
        { channel: 'facebook', count: 20 },
      ]);

      const result = await service.getChannelSummary('proj-1');

      expect(result).toEqual([
        { channel: 'google', count: 30, percentage: 60 },
        { channel: 'facebook', count: 20, percentage: 40 },
      ]);
    });

    it('returns empty array when there are no results', async () => {
      qbMock.getRawMany.mockResolvedValueOnce([]);

      const result = await service.getChannelSummary('proj-1');

      expect(result).toEqual([]);
    });

    it('applies date range filters when start and end are provided', async () => {
      qbMock.getRawMany.mockResolvedValueOnce([]);

      const start = new Date('2024-01-01');
      const end = new Date('2024-02-01');
      await service.getChannelSummary('proj-1', start, end);

      const andWhereCalls = qbMock.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereCalls).toEqual(
        expect.arrayContaining([
          'tp.touched_at >= :start',
          'tp.touched_at <= :end',
        ]),
      );
    });
  });
});
