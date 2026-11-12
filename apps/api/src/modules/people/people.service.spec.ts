import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PeopleService } from './people.service';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { UserEventEntity } from '../events/entities/user-event.entity';

describe('PeopleService', () => {
  let service: PeopleService;

  const makeQb = () => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      getCount: jest.fn(),
      getRawOne: jest.fn(),
      getRawMany: jest.fn(),
      getMany: jest.fn(),
      getManyAndCount: jest.fn(),
      clone: jest.fn(),
    };
    qb.clone.mockReturnValue(qb);
    return qb;
  };

  let identityQb: ReturnType<typeof makeQb>;
  let eventQb: ReturnType<typeof makeQb>;
  let managerQb: ReturnType<typeof makeQb>;

  const identityRepository: any = {
    createQueryBuilder: jest.fn(),
    count: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn((x) => Promise.resolve(x)),
    manager: {
      createQueryBuilder: jest.fn(),
    },
  };

  const eventRepository: any = {
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    identityQb = makeQb();
    eventQb = makeQb();
    managerQb = makeQb();

    identityRepository.createQueryBuilder.mockReturnValue(identityQb);
    identityRepository.manager.createQueryBuilder.mockReturnValue(managerQb);
    eventRepository.createQueryBuilder.mockReturnValue(eventQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PeopleService,
        { provide: getRepositoryToken(DeviceIdentityEntity), useValue: identityRepository },
        { provide: getRepositoryToken(UserEventEntity), useValue: eventRepository },
      ],
    }).compile();

    service = module.get<PeopleService>(PeopleService);
  });

  // ---------------------------------------------------------------------------
  // listPeople
  // ---------------------------------------------------------------------------
  describe('listPeople', () => {
    it('scopes query to the given project and returns mapped rows', async () => {
      const rawRow = {
        id: 'id-1',
        distinctId: 'user-1',
        externalUserId: 'ext-1',
        displayName: '  Jane Doe  ',
        email: 'jane@example.com',
        phone: '+15555555555',
        avatar: null,
        platform: 'ios',
        os: 'iOS',
        browser: null,
        country: 'US',
        city: 'NYC',
        firstSeenAt: '2025-01-01',
        lastSeenAt: '2025-02-01',
        totalSessions: '5',
        totalRevenue: '199.99',
        initialUtmSource: 'google',
        initialUtmCampaign: 'launch',
        status: 'active',
        pushEnabled: true,
        totalEvents: '42',
        deviceCount: '3',
      };

      identityQb.getRawOne.mockResolvedValueOnce({ count: '1' });
      identityQb.getRawMany.mockResolvedValueOnce([rawRow]);

      const result = await service.listPeople('proj-1', {});

      expect(identityQb.where).toHaveBeenCalledWith('di.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: 'id-1',
        distinctId: 'user-1',
        displayName: 'Jane Doe',
        email: 'jane@example.com',
        deviceCount: 3,
        totalEvents: 42,
        totalSessions: 5,
        totalRevenue: 199.99,
        pushEnabled: true,
        status: 'active',
      });
    });

    it('falls back to distinctId when displayName is null and trims', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '1' });
      identityQb.getRawMany.mockResolvedValueOnce([
        {
          id: 'id-2',
          distinctId: 'user-2',
          displayName: null,
          lastSeenAt: '2025-02-01',
          firstSeenAt: '2025-01-01',
          deviceCount: '1',
          totalEvents: '0',
          totalSessions: '0',
          totalRevenue: '0',
          pushEnabled: false,
          status: 'inactive',
        },
      ]);

      const result = await service.listPeople('proj-1', {});

      expect(result.data[0].displayName).toBe('user-2');
    });

    it('applies search filter with ILIKE pattern', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      await service.listPeople('proj-1', { search: 'jane' });

      expect(identityQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE :search'),
        { search: '%jane%' },
      );
    });

    it('applies active status filter', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      await service.listPeople('proj-1', { status: 'active' });

      expect(identityQb.andWhere).toHaveBeenCalledWith('di.last_seen_at >= :thirtyDaysAgo');
    });

    it('applies inactive status filter', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      await service.listPeople('proj-1', { status: 'inactive' });

      expect(identityQb.andWhere).toHaveBeenCalledWith('di.last_seen_at < :thirtyDaysAgo');
    });

    it('applies push enabled filter when true', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      await service.listPeople('proj-1', { pushEnabled: true });

      expect(identityQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('is_active = true) > 0'),
      );
    });

    it('applies push enabled filter when false', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      await service.listPeople('proj-1', { pushEnabled: false });

      expect(identityQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('is_active = true) = 0'),
      );
    });

    it('applies country, platform, and hasRevenue filters', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '0' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      await service.listPeople('proj-1', {
        country: 'US',
        platform: 'ios',
        hasRevenue: true,
      });

      expect(identityQb.andWhere).toHaveBeenCalledWith('di.country = :country', { country: 'US' });
      expect(identityQb.andWhere).toHaveBeenCalledWith('di.platform = :platform', { platform: 'ios' });
      expect(identityQb.andWhere).toHaveBeenCalledWith('di.total_revenue > 0');
    });

    it('computes pagination offset from page number', async () => {
      identityQb.getRawOne.mockResolvedValueOnce({ count: '50' });
      identityQb.getRawMany.mockResolvedValueOnce([]);

      const result = await service.listPeople('proj-1', { page: 3, limit: 10 });

      expect(identityQb.offset).toHaveBeenCalledWith(20);
      expect(identityQb.limit).toHaveBeenCalledWith(10);
      expect(result.meta).toEqual({ page: 3, limit: 10, total: 50, totalPages: 5 });
    });
  });

  // ---------------------------------------------------------------------------
  // getPeopleStats
  // ---------------------------------------------------------------------------
  describe('getPeopleStats', () => {
    it('aggregates totals, revenue, top countries and platforms', async () => {
      identityRepository.count.mockResolvedValueOnce(100);

      // Sequential createQueryBuilder calls, each returning a fresh qb.
      // We need distinct behavior per call: active30d, pushEnabled, newThisWeek,
      // identified, revenueStats, topCountries, topPlatforms.
      const active30dQb = makeQb();
      active30dQb.getCount.mockResolvedValueOnce(60);

      const pushEnabledQb = makeQb();
      pushEnabledQb.getCount.mockResolvedValueOnce(30);

      const newThisWeekQb = makeQb();
      newThisWeekQb.getCount.mockResolvedValueOnce(5);

      const identifiedQb = makeQb();
      identifiedQb.getCount.mockResolvedValueOnce(40);

      const revenueQb = makeQb();
      revenueQb.getRawOne.mockResolvedValueOnce({ withRevenue: '15', totalRevenue: '1234.56' });

      const topCountriesQb = makeQb();
      topCountriesQb.getRawMany.mockResolvedValueOnce([{ country: 'US', count: 50 }]);

      const topPlatformsQb = makeQb();
      topPlatformsQb.getRawMany.mockResolvedValueOnce([{ platform: 'ios', count: 80 }]);

      identityRepository.createQueryBuilder
        .mockReturnValueOnce(active30dQb)
        .mockReturnValueOnce(pushEnabledQb)
        .mockReturnValueOnce(newThisWeekQb)
        .mockReturnValueOnce(identifiedQb)
        .mockReturnValueOnce(revenueQb)
        .mockReturnValueOnce(topCountriesQb)
        .mockReturnValueOnce(topPlatformsQb);

      const result = await service.getPeopleStats('proj-1');

      expect(identityRepository.count).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } });
      expect(result).toEqual({
        total: 100,
        active30d: 60,
        pushEnabled: 30,
        newThisWeek: 5,
        identified: 40,
        withRevenue: 15,
        totalRevenue: 1234.56,
        topCountries: [{ country: 'US', count: 50 }],
        topPlatforms: [{ platform: 'ios', count: 80 }],
      });
    });

    it('handles missing revenue stats gracefully', async () => {
      identityRepository.count.mockResolvedValueOnce(0);

      const stub = () => {
        const q = makeQb();
        q.getCount.mockResolvedValueOnce(0);
        q.getRawOne.mockResolvedValueOnce(null);
        q.getRawMany.mockResolvedValueOnce([]);
        return q;
      };

      identityRepository.createQueryBuilder
        .mockReturnValueOnce(stub())
        .mockReturnValueOnce(stub())
        .mockReturnValueOnce(stub())
        .mockReturnValueOnce(stub())
        .mockReturnValueOnce(stub())
        .mockReturnValueOnce(stub())
        .mockReturnValueOnce(stub());

      const result = await service.getPeopleStats('proj-1');

      expect(result.withRevenue).toBe(0);
      expect(result.totalRevenue).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getPersonDetail
  // ---------------------------------------------------------------------------
  describe('getPersonDetail', () => {
    it('returns null when identity is not found', async () => {
      identityRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getPersonDetail('proj-1', 'person-1');

      expect(identityRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'person-1', projectId: 'proj-1' },
      });
      expect(result).toBeNull();
    });

    it('returns a detailed record with events, push tokens, and devices', async () => {
      const identity: any = {
        id: 'id-1',
        distinctId: 'user-1',
        deviceFingerprint: 'fp-1',
        externalUserId: null,
        firstName: 'Jane',
        lastName: 'Doe',
        traits: { '$email': 'jane@example.com' },
        phone: null,
        avatar: null,
        locale: 'en-US',
        language: 'en',
        platform: 'ios',
        os: 'iOS',
        osVersion: '17',
        browser: null,
        browserVersion: null,
        appVersion: '1.0',
        appBuild: '1',
        manufacturer: 'Apple',
        brand: 'Apple',
        model: 'iPhone',
        screenHeight: 800,
        screenWidth: 400,
        carrier: null,
        country: 'US',
        countryCode: 'US',
        region: 'NY',
        city: 'NYC',
        timezone: 'America/New_York',
        latitude: 40,
        longitude: -74,
        initialReferrer: null,
        initialReferringDomain: null,
        initialUtmSource: 'google',
        initialUtmMedium: 'cpc',
        initialUtmCampaign: 'launch',
        initialUtmContent: null,
        initialUtmTerm: null,
        installSource: null,
        installCampaign: null,
        latestReferrer: null,
        latestUtmSource: null,
        latestUtmMedium: null,
        latestUtmCampaign: null,
        totalSessions: 3,
        totalRevenue: '99.50',
        currency: 'USD',
        lastEventAt: new Date('2025-03-01'),
        emailOptIn: true,
        smsOptIn: false,
        pushOptIn: true,
        gdprConsent: true,
        doNotTrack: false,
        consentUpdatedAt: new Date('2025-01-01'),
        firstSeenAt: new Date('2025-01-01'),
        lastSeenAt: new Date(),
      };
      identityRepository.findOne.mockResolvedValueOnce(identity);

      // recentEvents qb
      const recentQb = makeQb();
      recentQb.getMany.mockResolvedValueOnce([{ id: 'e1', eventName: 'click' }]);

      // eventCounts qb
      const countsQb = makeQb();
      countsQb.getRawMany.mockResolvedValueOnce([{ eventName: 'click', count: 5 }]);

      eventRepository.createQueryBuilder
        .mockReturnValueOnce(recentQb)
        .mockReturnValueOnce(countsQb);

      // push tokens via manager qb
      const pushTokensQb = makeQb();
      pushTokensQb.getRawMany.mockResolvedValueOnce([
        { id: 't1', device_identity_id: 'id-1', is_active: true },
      ]);
      identityRepository.manager.createQueryBuilder.mockReturnValueOnce(pushTokensQb);

      // devices via find
      identityRepository.find.mockResolvedValueOnce([
        { id: 'id-1', deviceFingerprint: 'fp-1', platform: 'ios', os: 'iOS', lastSeenAt: new Date() },
        { id: 'id-2', deviceFingerprint: 'fp-2', platform: 'ios', os: 'iOS', lastSeenAt: new Date() },
      ]);

      const result: any = await service.getPersonDetail('proj-1', 'id-1');

      expect(result).not.toBeNull();
      expect(result.id).toBe('id-1');
      expect(result.distinctId).toBe('user-1');
      expect(result.displayName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.totalRevenue).toBe(99.5);
      expect(result.totalSessions).toBe(3);
      expect(result.pushEnabled).toBe(true);
      expect(result.deviceCount).toBe(2);
      expect(result.recentEvents).toHaveLength(1);
      expect(result.eventCounts).toHaveLength(1);
      expect(result.status).toBe('active');
    });

    it('uses device fingerprint when no distinctId and returns only one device', async () => {
      const identity: any = {
        id: 'id-10',
        distinctId: null,
        deviceFingerprint: 'fp-10',
        externalUserId: null,
        firstName: null,
        lastName: null,
        traits: null,
        firstSeenAt: new Date('2025-01-01'),
        lastSeenAt: new Date(),
        totalSessions: 0,
        totalRevenue: 0,
      };
      identityRepository.findOne.mockResolvedValueOnce(identity);

      const recentQb = makeQb();
      recentQb.getMany.mockResolvedValueOnce([]);
      const countsQb = makeQb();
      countsQb.getRawMany.mockResolvedValueOnce([]);
      eventRepository.createQueryBuilder
        .mockReturnValueOnce(recentQb)
        .mockReturnValueOnce(countsQb);

      const pushTokensQb = makeQb();
      pushTokensQb.getRawMany.mockResolvedValueOnce([]);
      identityRepository.manager.createQueryBuilder.mockReturnValueOnce(pushTokensQb);

      const result: any = await service.getPersonDetail('proj-1', 'id-10');

      expect(result.distinctId).toBe('fp-10');
      expect(result.deviceCount).toBe(1);
      expect(result.pushEnabled).toBe(false);
      // identityRepository.find should NOT be called when no distinctId
      expect(identityRepository.find).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getPersonEvents
  // ---------------------------------------------------------------------------
  describe('getPersonEvents', () => {
    it('returns empty result when identity is missing', async () => {
      identityRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getPersonEvents('proj-1', 'id-0', {});

      expect(result).toEqual({ data: [], total: 0 });
    });

    it('queries events by distinctId with default pagination', async () => {
      identityRepository.findOne.mockResolvedValueOnce({
        id: 'id-1',
        distinctId: 'user-1',
        deviceFingerprint: 'fp-1',
      });
      eventQb.getManyAndCount.mockResolvedValueOnce([[{ id: 'e1' }], 1]);

      const result = await service.getPersonEvents('proj-1', 'id-1', {});

      expect(eventQb.where).toHaveBeenCalledWith('event.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(eventQb.andWhere).toHaveBeenCalledWith('event.distinct_id = :distinctId', {
        distinctId: 'user-1',
      });
      expect(eventQb.take).toHaveBeenCalledWith(50);
      expect(eventQb.skip).toHaveBeenCalledWith(0);
      expect(result).toEqual({ data: [{ id: 'e1' }], total: 1 });
    });

    it('applies eventName filter and paginated offset', async () => {
      identityRepository.findOne.mockResolvedValueOnce({
        id: 'id-1',
        distinctId: 'user-1',
        deviceFingerprint: 'fp-1',
      });
      eventQb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.getPersonEvents('proj-1', 'id-1', {
        page: 2,
        limit: 10,
        eventName: 'signup',
      });

      expect(eventQb.andWhere).toHaveBeenCalledWith('event.event_name = :eventName', {
        eventName: 'signup',
      });
      expect(eventQb.take).toHaveBeenCalledWith(10);
      expect(eventQb.skip).toHaveBeenCalledWith(10);
    });
  });

  // ---------------------------------------------------------------------------
  // updatePersonTraits
  // ---------------------------------------------------------------------------
  describe('updatePersonTraits', () => {
    it('merges in one UPDATE against the live row, never a load and save', async () => {
      (identityRepository as any).query = jest.fn().mockResolvedValueOnce([[{ id: 'id-1' }], 1]);
      identityRepository.findOne.mockResolvedValueOnce({ id: 'id-1', traits: { tier: 'gold', vip: true } });

      const result = await service.updatePersonTraits('proj-1', '11111111-1111-1111-1111-111111111111', { vip: true });

      const [sql, params] = (identityRepository as any).query.mock.calls[0];
      expect(sql).toContain("SET traits = COALESCE(traits, '{}'::jsonb) || $3::jsonb");
      expect(sql).toContain('project_id = $1');
      expect(params).toEqual(['proj-1', '11111111-1111-1111-1111-111111111111', JSON.stringify({ vip: true })]);
      expect(identityRepository.save).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'id-1', traits: { tier: 'gold', vip: true } });
    });

    it('returns null (a 404) when no row matched: unknown, another project, or erased meanwhile', async () => {
      (identityRepository as any).query = jest.fn().mockResolvedValueOnce([[], 0]);
      await expect(service.updatePersonTraits('proj-1', '22222222-2222-2222-2222-222222222222', { a: 1 })).resolves.toBeNull();
      expect(identityRepository.findOne).not.toHaveBeenCalled();
    });

    it('answers null for an id that is not a UUID, without querying', async () => {
      (identityRepository as any).query = jest.fn();
      await expect(service.updatePersonTraits('proj-1', 'not-a-uuid', { a: 1 })).resolves.toBeNull();
      expect((identityRepository as any).query).not.toHaveBeenCalled();
    });

    it('refuses traits that are not an object', async () => {
      await expect(service.updatePersonTraits('proj-1', 'id-1', [1] as never)).rejects.toThrow('Traits must be an object');
    });
  });
});
