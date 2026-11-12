import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IdentityService } from './identity.service';
import { DeviceIdentityEntity } from './entities/device-identity.entity';
import { IdentityAliasEntity } from './entities/identity-alias.entity';
import { ConsentEventsService } from '../consent/consent-events.service';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ErasedSuppressionsService } from '../privacy/erased-suppressions.service';

describe('IdentityService', () => {
  let service: IdentityService;

  const identityRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: {
      query: jest.fn(),
      // Runs the work on a manager over the same repository, as a
      // transaction would: identify, revenue and consent all run inside
      // `locked()`, and everything they write goes through that manager.
      transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) => work(txManager)),
    } as Record<string, jest.Mock>,
  };

  const txManager = {
    getRepository: () => identityRepo,
    query: jest.fn(async () => []),
    update: jest.fn(async () => ({ affected: 1 })),
    // `persist` saves through the manager; delegate so tests that watch
    // identityRepo.save see it, and give a new row an id as Postgres would.
    save: jest.fn(async (_target: unknown, entity: Record<string, unknown>) => {
      const saved = ((await identityRepo.save(entity)) ?? entity) as Record<string, unknown>;
      return { ...saved, id: saved.id ?? 'new-id' };
    }),
  };

  const consentEvents = { record: jest.fn(async () => undefined) };
  let doNotTrackPerson = false;
  const trackingConsent = {
    hasPersonObjection: jest.fn(async () => false),
    isDoNotTrack: jest.fn(async () => doNotTrackPerson),
    recordDrop: jest.fn(),
  };

  const aliasRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };

  const erasedSuppressions = { restore: jest.fn().mockResolvedValue(0) };

  beforeEach(async () => {
    jest.clearAllMocks();
    doNotTrackPerson = false;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityService,
        { provide: ConsentEventsService, useValue: consentEvents },
        { provide: TrackingConsentService, useValue: trackingConsent },
        { provide: getRepositoryToken(DeviceIdentityEntity), useValue: identityRepo },
        { provide: getRepositoryToken(IdentityAliasEntity), useValue: aliasRepo },
        { provide: ErasedSuppressionsService, useValue: erasedSuppressions },
        { provide: ProjectActivityService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get<IdentityService>(IdentityService);
  });

  // ---------------------------------------------------------------------------
  // identify
  // ---------------------------------------------------------------------------
  describe('identify', () => {
    const baseDto = {
      projectId: 'proj-1',
      deviceFingerprint: 'fp-1',
      platform: 'ios',
    };

    describe('suppressions of erased people', () => {
      const existing = (over: Record<string, unknown> = {}) =>
        ({ id: 'id-1', projectId: 'proj-1', deviceFingerprint: 'fp-1', traits: {}, email: null, phoneE164: null, ...over }) as any;

      beforeEach(() => {
        identityRepo.save.mockImplementation(async (obj) => obj);
      });

      it('restores before saving a new identity that carries an address', async () => {
        identityRepo.findOne.mockResolvedValueOnce(null);
        identityRepo.create.mockImplementation((obj) => obj);
        const order: string[] = [];
        erasedSuppressions.restore.mockImplementationOnce(async () => {
          order.push('restore');
          return 1;
        });
        identityRepo.save.mockImplementationOnce(async (obj) => {
          order.push('save');
          return obj;
        });

        await service.identify({ ...baseDto, email: 'Gone@Example.com', phone: '+91 98765 43210' });

        expect(erasedSuppressions.restore).toHaveBeenCalledWith(
          'proj-1',
          { email: 'gone@example.com', phoneE164: '+919876543210' },
          expect.anything(),
        );
        // No send can reach the address between storing it and restoring its suppression.
        expect(order).toEqual(['restore', 'save']);
      });

      it('looks up only an address that changed', async () => {
        identityRepo.findOne.mockResolvedValueOnce(
          existing({ email: 'same@example.com', phoneE164: '+919876543210' }),
        );
        await service.identify({ ...baseDto, email: 'same@example.com', phone: '+447700900123' });
        expect(erasedSuppressions.restore).toHaveBeenCalledWith(
          'proj-1',
          { email: null, phoneE164: '+447700900123' },
          expect.anything(),
        );
      });

      it('reads the identity under a row lock in a transaction, for identify, revenue and consent', async () => {
        identityRepo.findOne.mockResolvedValue(existing());
        await service.identify({ ...baseDto, traits: { plan: 'pro' } });
        await service.trackRevenue({ projectId: 'proj-1', deviceFingerprint: 'fp-1', amount: 5 } as any);
        await service.updateConsent('proj-1', 'id-1', { emailOptIn: true } as any, null);
        expect(identityRepo.manager.transaction).toHaveBeenCalledTimes(3);
        for (const [args] of identityRepo.findOne.mock.calls) {
          expect(args.lock).toEqual({ mode: 'pessimistic_write' });
        }
        identityRepo.findOne.mockReset();
      });

      it('does nothing for an identify that reports no new address', async () => {
        identityRepo.findOne.mockResolvedValueOnce(existing({ email: 'same@example.com' }));
        await service.identify({ ...baseDto, email: 'same@example.com' });
        identityRepo.findOne.mockResolvedValueOnce(existing());
        await service.identify({ ...baseDto, traits: { plan: 'pro' } });
        expect(erasedSuppressions.restore).not.toHaveBeenCalled();
      });
    });

    describe('email address', () => {
      const existing = () =>
        ({ id: 'id-1', projectId: 'proj-1', deviceFingerprint: 'fp-1', traits: {}, email: null }) as any;

      it('reads the $email trait shipped SDKs already send, normalised', async () => {
        identityRepo.findOne.mockResolvedValueOnce(existing());
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({
          ...baseDto,
          traits: { $email: '  Priya@Example.COM ' },
        });
        expect(result.email).toBe('priya@example.com');
      });

      it('prefers the explicit field over traits', async () => {
        identityRepo.findOne.mockResolvedValueOnce(existing());
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({
          ...baseDto,
          email: 'work@example.com',
          traits: { email: 'home@example.com' },
        } as any);
        expect(result.email).toBe('work@example.com');
      });

      it('ignores a trait that is not an address instead of clearing a good one', async () => {
        identityRepo.findOne.mockResolvedValueOnce({ ...existing(), email: 'priya@example.com' });
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({ ...baseDto, traits: { email: 'Priya Shah' } });
        expect(result.email).toBe('priya@example.com');
      });

      it('stores the address on a new identity', async () => {
        identityRepo.findOne.mockResolvedValueOnce(null);
        identityRepo.create.mockImplementation((obj) => ({ ...obj }));
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({ ...baseDto, traits: { email: 'new@example.com' } });
        expect(result.email).toBe('new@example.com');
      });
    });

    describe('SMS number', () => {
      const existing = () =>
        ({ id: 'id-1', projectId: 'proj-1', deviceFingerprint: 'fp-1', traits: {}, phoneE164: null }) as any;

      it('stores the phone field in E.164, keeping phone as reported', async () => {
        identityRepo.findOne.mockResolvedValueOnce(existing());
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({ ...baseDto, phone: '+91 98765-43210' } as any);
        expect(result.phoneE164).toBe('+919876543210');
        expect(result.phone).toBe('+91 98765-43210');
      });

      it('reads the $phone trait and the 00 international prefix', async () => {
        identityRepo.findOne.mockResolvedValueOnce(existing());
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({ ...baseDto, traits: { $phone: '0044 7700 900123' } });
        expect(result.phoneE164).toBe('+447700900123');
      });

      it('leaves a national number with no country code unreachable rather than guessing', async () => {
        identityRepo.findOne.mockResolvedValueOnce({ ...existing(), phoneE164: '+919876543210' });
        identityRepo.save.mockImplementation(async (obj) => obj);
        const result = await service.identify({ ...baseDto, phone: '09876543210' } as any);
        expect(result.phoneE164).toBe('+919876543210');
      });
    });

    it('creates a new identity when none exists', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => ({ id: 'id-1', ...obj }));

      const result = await service.identify({
        ...baseDto,
        distinctId: 'user-1',
        traits: { plan: 'pro' },
      });

      expect(identityRepo.findOne).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', deviceFingerprint: 'fp-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(identityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          deviceFingerprint: 'fp-1',
          platform: 'ios',
          distinctId: 'user-1',
          traits: { plan: 'pro' },
          totalSessions: 1,
          totalRevenue: 0,
        }),
      );
      expect(identityRepo.save).toHaveBeenCalled();
      expect(result.id).toBe('id-1');
    });

    it('sets initial attribution fields from referrer and UTM params on new identity', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => obj);

      await service.identify({
        ...baseDto,
        referrer: 'https://google.com/search?q=x',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring',
      });

      expect(identityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          initialReferrer: 'https://google.com/search?q=x',
          initialReferringDomain: 'google.com',
          initialUtmSource: 'google',
          initialUtmMedium: 'cpc',
          initialUtmCampaign: 'spring',
          latestReferrer: 'https://google.com/search?q=x',
          latestUtmSource: 'google',
          latestUtmMedium: 'cpc',
          latestUtmCampaign: 'spring',
        }),
      );
    });

    it('updates existing identity: merges traits, increments sessions, updates lastSeenAt', async () => {
      const existing: Partial<DeviceIdentityEntity> = {
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        traits: { existingTrait: 'keep' },
        totalSessions: 3,
        firstSeenAt: new Date('2024-01-01'),
      };
      identityRepo.findOne.mockResolvedValueOnce(existing);
      identityRepo.save.mockImplementation(async (obj) => obj);

      const before = Date.now();
      const result = await service.identify({
        ...baseDto,
        traits: { newTrait: 'added' },
      });

      expect(result.traits).toEqual({ existingTrait: 'keep', newTrait: 'added' });
      expect(result.totalSessions).toBe(4);
      expect(result.firstSeenAt).toEqual(new Date('2024-01-01')); // preserved
      expect((result.lastSeenAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      // create should NOT be called on existing path
      expect(identityRepo.create).not.toHaveBeenCalled();
    });

    it('is idempotent when re-identifying with no new fields', async () => {
      const existing: Partial<DeviceIdentityEntity> = {
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        distinctId: 'user-1',
        totalSessions: 1,
        traits: { x: 1 },
      };
      identityRepo.findOne.mockResolvedValueOnce(existing);
      identityRepo.save.mockImplementation(async (obj) => obj);

      const result = await service.identify({
        ...baseDto,
        distinctId: 'user-1',
      });

      expect(result.distinctId).toBe('user-1');
      expect(result.traits).toEqual({ x: 1 });
      expect(result.totalSessions).toBe(2); // only session increments
    });

    it('scopes lookup by projectId and fingerprint', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => obj);

      await service.identify({
        projectId: 'proj-xyz',
        deviceFingerprint: 'fp-xyz',
        platform: 'web',
      });

      expect(identityRepo.findOne).toHaveBeenCalledWith({
        where: { projectId: 'proj-xyz', deviceFingerprint: 'fp-xyz' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('updates latest attribution on existing identity', async () => {
      const existing: Partial<DeviceIdentityEntity> = {
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        latestUtmSource: 'old-source',
        latestUtmCampaign: 'old-campaign',
        initialUtmSource: 'original-source',
        totalSessions: 1,
      };
      identityRepo.findOne.mockResolvedValueOnce(existing);
      identityRepo.save.mockImplementation(async (obj) => obj);

      const result = await service.identify({
        ...baseDto,
        utmSource: 'new-source',
        utmCampaign: 'new-campaign',
      });

      expect(result.latestUtmSource).toBe('new-source');
      expect(result.latestUtmCampaign).toBe('new-campaign');
      // Initial should NOT be touched on existing
      expect(result.initialUtmSource).toBe('original-source');
    });

    it('updates consent fields and sets consentUpdatedAt when provided', async () => {
      const existing: Partial<DeviceIdentityEntity> = {
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        emailOptIn: false,
        totalSessions: 1,
      };
      identityRepo.findOne.mockResolvedValueOnce(existing);
      identityRepo.save.mockImplementation(async (obj) => obj);

      const result = await service.identify({
        ...baseDto,
        emailOptIn: true,
        pushOptIn: true,
      });

      expect(result.emailOptIn).toBe(true);
      expect(result.pushOptIn).toBe(true);
      expect(result.consentUpdatedAt).toBeInstanceOf(Date);
    });

    it('handles missing referrer gracefully in domain extraction', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => obj);

      await service.identify({ ...baseDto });

      expect(identityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          initialReferrer: null,
          initialReferringDomain: null,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // trackRevenue
  // ---------------------------------------------------------------------------
  describe('trackRevenue', () => {
    it('adds amount to totalRevenue and updates currency', async () => {
      const existing: Partial<DeviceIdentityEntity> = {
        id: 'id-1',
        totalRevenue: 50,
      };
      identityRepo.findOne.mockResolvedValueOnce(existing);
      identityRepo.save.mockImplementation(async (obj) => obj);

      await service.trackRevenue({
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        amount: 25.5,
        currency: 'USD',
      });

      expect(identityRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalRevenue: 75.5,
          currency: 'USD',
          lastEventAt: expect.any(Date),
        }),
      );
    });

    it('no-ops silently when identity not found', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);

      await service.trackRevenue({
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        amount: 10,
      });

      expect(identityRepo.save).not.toHaveBeenCalled();
    });

    it('coerces non-numeric totalRevenue before adding', async () => {
      identityRepo.findOne.mockResolvedValueOnce({
        id: 'id-1',
        totalRevenue: '100' as unknown as number, // typeorm decimal sometimes returns string
      });
      identityRepo.save.mockImplementation(async (obj) => obj);

      await service.trackRevenue({
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        amount: 20,
      });

      expect(identityRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ totalRevenue: 120 }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateConsent
  // ---------------------------------------------------------------------------
  describe('updateConsent', () => {
    it('updates provided consent fields and returns identity', async () => {
      const existing: Partial<DeviceIdentityEntity> = {
        id: 'id-1',
        projectId: 'proj-1',
        emailOptIn: false,
      };
      identityRepo.findOne.mockResolvedValueOnce(existing);
      identityRepo.save.mockImplementation(async (obj) => obj);

      const result = await service.updateConsent('proj-1', 'id-1', {
        emailOptIn: true,
        gdprConsent: true,
      }, null);

      expect(result?.emailOptIn).toBe(true);
      expect(result?.gdprConsent).toBe(true);
      expect(result?.consentUpdatedAt).toBeInstanceOf(Date);
    });

    it('returns null when identity not found', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.updateConsent('proj-1', 'missing', { emailOptIn: true }, null);

      expect(result).toBeNull();
    });

    it('enforces project scoping when locating identity', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      await service.updateConsent('proj-1', 'id-1', { emailOptIn: false }, null);

      expect(identityRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'id-1', projectId: 'proj-1' },
        lock: { mode: 'pessimistic_write' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // mergeIdentity
  // ---------------------------------------------------------------------------
  describe('mergeIdentity', () => {
    it('short-circuits when anonymousId equals identifiedId', async () => {
      await service.mergeIdentity('proj-1', 'same', 'same');

      expect(aliasRepo.findOne).not.toHaveBeenCalled();
      expect(aliasRepo.save).not.toHaveBeenCalled();
    });

    it('creates an alias when none exists and updates device_identities + event tables', async () => {
      aliasRepo.findOne.mockResolvedValueOnce(null);
      aliasRepo.create.mockImplementation((o) => o);
      aliasRepo.save.mockResolvedValue({});

      const execute = jest.fn().mockResolvedValue({});
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      identityRepo.createQueryBuilder.mockReturnValueOnce(qb);
      identityRepo.manager.query.mockResolvedValue([]);

      await service.mergeIdentity('proj-1', 'anon-1', 'user-1');

      expect(aliasRepo.create).toHaveBeenCalledWith({
        projectId: 'proj-1',
        anonymousId: 'anon-1',
        identifiedId: 'user-1',
      });
      expect(aliasRepo.save).toHaveBeenCalled();
      expect(qb.set).toHaveBeenCalledWith({ distinctId: 'user-1', lastSeenAt: expect.any(Function) });
      // last_seen_at is kept as itself, not moved on every row with that id.
      expect(qb.set.mock.calls[0][0].lastSeenAt()).toBe('last_seen_at');
      expect(execute).toHaveBeenCalled();
      // 4 raw queries: click_events, conversion_events, user_events, touchpoints
      expect(identityRepo.manager.query).toHaveBeenCalledTimes(4);
    });

    it('skips creating alias if one already exists (idempotent re-merge)', async () => {
      aliasRepo.findOne.mockResolvedValueOnce({
        id: 'a-1',
        projectId: 'proj-1',
        anonymousId: 'anon-1',
        identifiedId: 'user-1',
      });

      const execute = jest.fn().mockResolvedValue({});
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      identityRepo.createQueryBuilder.mockReturnValueOnce(qb);
      identityRepo.manager.query.mockResolvedValue([]);

      await service.mergeIdentity('proj-1', 'anon-1', 'user-1');

      expect(aliasRepo.create).not.toHaveBeenCalled();
      expect(aliasRepo.save).not.toHaveBeenCalled();
      // Downstream propagation still runs
      expect(identityRepo.manager.query).toHaveBeenCalledTimes(4);
    });

    it('never writes either identifier to the log, which outlives an erasure', async () => {
      aliasRepo.findOne.mockResolvedValueOnce(null);
      aliasRepo.create.mockImplementationOnce((o: unknown) => o);
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      };
      identityRepo.createQueryBuilder.mockReturnValueOnce(qb);
      identityRepo.manager.query.mockResolvedValue([]);
      const lines: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
      try {
        await service.mergeIdentity('proj-1', 'anon-secret-1', 'user-secret-1');
      } finally {
        spy.mockRestore();
      }
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toMatch(/anon-secret-1|user-secret-1/);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveDistinctId
  // ---------------------------------------------------------------------------
  describe('resolveDistinctId', () => {
    it('returns identified id when an alias exists', async () => {
      aliasRepo.findOne.mockResolvedValueOnce({ identifiedId: 'user-1' });

      const result = await service.resolveDistinctId('proj-1', 'anon-1');

      expect(result).toBe('user-1');
    });

    it('returns the original distinctId when no alias exists', async () => {
      aliasRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.resolveDistinctId('proj-1', 'anon-1');

      expect(result).toBe('anon-1');
    });
  });

  // ---------------------------------------------------------------------------
  // find* / getDevices*
  // ---------------------------------------------------------------------------
  describe('finders', () => {
    it('findByFingerprintAndProject scopes by project', async () => {
      identityRepo.findOne.mockResolvedValueOnce({ id: 'x' });

      await service.findByFingerprintAndProject('fp-1', 'proj-1');

      expect(identityRepo.findOne).toHaveBeenCalledWith({
        where: { deviceFingerprint: 'fp-1', projectId: 'proj-1' },
      });
    });

    it('findByDistinctId scopes by project and returns an array', async () => {
      identityRepo.find.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

      const result = await service.findByDistinctId('user-1', 'proj-1');

      expect(result).toHaveLength(2);
      expect(identityRepo.find).toHaveBeenCalledWith({
        where: { distinctId: 'user-1', projectId: 'proj-1' },
      });
    });

    it('getDevicesByUser always scopes by project', async () => {
      identityRepo.find.mockResolvedValueOnce([]);

      await service.getDevicesByUser('ext-1', 'proj-1');

      expect(identityRepo.find).toHaveBeenCalledWith({
        where: { externalUserId: 'ext-1', projectId: 'proj-1' },
        order: { lastSeenAt: 'DESC' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // updateLastSeen & updateLastEventAt
  // ---------------------------------------------------------------------------
  describe('updateLastSeen', () => {
    it('calls repository.update with a new Date', async () => {
      identityRepo.update.mockResolvedValueOnce({});

      await service.updateLastSeen('id-1');

      expect(identityRepo.update).toHaveBeenCalledWith(
        'id-1',
        expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      );
    });
  });

  describe('updateLastEventAt', () => {
    it('stamps only the named row, and never a do-not-track one', async () => {
      const execute = jest.fn().mockResolvedValue({});
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      identityRepo.createQueryBuilder.mockReturnValueOnce(qb);

      await service.updateLastEventAt('proj-1', 'id-1');

      // Proved against Postgres in consent.int-spec.ts; here, the shape.
      expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ lastEventAt: expect.any(Date) }));
      expect(qb.where).toHaveBeenCalledWith('id = :deviceIdentityId', { deviceIdentityId: 'id-1' });
      expect(qb.andWhere).toHaveBeenCalledWith('project_id = :projectId', { projectId: 'proj-1' });
      expect(qb.andWhere).toHaveBeenCalledWith('do_not_track = false');
      expect(execute).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // linkDevice
  // ---------------------------------------------------------------------------
  describe('linkDevice', () => {
    it('delegates to identify() with externalUserId', async () => {
      const spy = jest.spyOn(service, 'identify').mockResolvedValueOnce({
        id: 'id-1',
      } as DeviceIdentityEntity);

      await service.linkDevice({
        externalUserId: 'ext-1',
        deviceFingerprint: 'fp-1',
        platform: 'ios',
        projectId: 'proj-1',
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          externalUserId: 'ext-1',
          deviceFingerprint: 'fp-1',
          platform: 'ios',
          projectId: 'proj-1',
        }),
        undefined,
      );
    });

    it('passes the request address through to identify()', async () => {
      // linkDevice is the other door into identify, so it has to carry the
      // derived address too — otherwise one of the two endpoints silently
      // stops recording geo.
      const spy = jest.spyOn(service, 'identify').mockResolvedValueOnce({
        id: 'id-1',
      } as DeviceIdentityEntity);

      await service.linkDevice(
        {
          externalUserId: 'ext-1',
          deviceFingerprint: 'fp-1',
          platform: 'ios',
          projectId: 'proj-1',
        },
        '198.51.100.5',
      );

      expect(spy).toHaveBeenCalledWith(expect.anything(), '198.51.100.5');
    });
  });

  // ---------------------------------------------------------------------------
  // Client address, never from the body
  // ---------------------------------------------------------------------------
  describe('client address', () => {
    const dto = {
      projectId: 'proj-1',
      deviceFingerprint: 'fp-new',
      platform: 'ios',
    } as never;

    it('stores the address the request came from', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => ({ id: 'id-1', ...obj }));

      const result = await service.identify(dto, '198.51.100.5');

      expect(result.ipAddress).toBe('198.51.100.5');
    });

    it('ignores an address smuggled into the body', async () => {
      // `IdentifyDto` has no `ipAddress`, so the pipe rejects a body carrying
      // one — this is the second half: even handed one, the service reads the
      // request's address and nothing else. Writing a chosen address here
      // also wrote a chosen country and city, which the dashboards aggregate.
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => ({ id: 'id-1', ...obj }));

      const result = await service.identify(
        { ...(dto as object), ipAddress: '203.0.113.7' } as never,
        '198.51.100.5',
      );

      expect(result.ipAddress).toBe('198.51.100.5');
    });

    it('stores no address when the request has none', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));
      identityRepo.save.mockImplementation(async (obj) => ({ id: 'id-1', ...obj }));

      const result = await service.identify(dto);

      expect(result.ipAddress).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Consent history (consent_events)
  // ---------------------------------------------------------------------------
  describe('consent history', () => {
    const baseDto = { projectId: 'proj-1', deviceFingerprint: 'fp-1', platform: 'ios' };
    const existing = (overrides: Partial<DeviceIdentityEntity> = {}) =>
      ({
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        pushOptIn: true,
        emailOptIn: null,
        doNotTrack: false,
        totalSessions: 3,
        ...overrides,
      }) as unknown as DeviceIdentityEntity;

    it('records only the flags identify actually changed, from the SDK, in the save transaction', async () => {
      identityRepo.findOne.mockResolvedValueOnce(existing());

      await service.identify({ ...baseDto, pushOptIn: false, emailOptIn: true, doNotTrack: false });

      // pushOptIn true -> false and emailOptIn null -> true changed; doNotTrack
      // false -> false did not.
      expect(identityRepo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(consentEvents.record).toHaveBeenCalledWith(
        [
          { projectId: 'proj-1', deviceIdentityId: 'id-1', channel: 'email', granted: true, source: 'sdk' },
          { projectId: 'proj-1', deviceIdentityId: 'id-1', channel: 'push', granted: false, source: 'sdk' },
        ],
        txManager,
      );
      // Saved through the same transaction's manager as its history.
      expect(txManager.save).toHaveBeenCalledTimes(1);
    });

    it('records nothing, and saves as before, when the SDK repeats what it said last time', async () => {
      identityRepo.findOne.mockResolvedValueOnce(existing());
      identityRepo.save.mockImplementation(async (obj) => obj);

      await service.identify({ ...baseDto, pushOptIn: true });

      // No history rows; the save is the ordinary one, in locked()'s transaction.
      expect(consentEvents.record).toHaveBeenCalledWith([], txManager);
      expect(identityRepo.save).toHaveBeenCalledTimes(1);
    });

    it('records turning do-not-track on as tracking withdrawn', async () => {
      identityRepo.findOne.mockResolvedValueOnce(existing());

      await service.identify({ ...baseDto, doNotTrack: true });

      expect(consentEvents.record).toHaveBeenCalledWith(
        [expect.objectContaining({ channel: 'tracking', granted: false, source: 'sdk' })],
        txManager,
      );
    });

    it('records every consent field a new identity arrives with, against its new id', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));

      const result = await service.identify({ ...baseDto, pushOptIn: true, doNotTrack: false });

      expect(consentEvents.record).toHaveBeenCalledWith(
        [
          { projectId: 'proj-1', deviceIdentityId: 'new-id', channel: 'push', granted: true, source: 'sdk' },
          { projectId: 'proj-1', deviceIdentityId: 'new-id', channel: 'tracking', granted: true, source: 'sdk' },
        ],
        txManager,
      );
      expect(result.consentUpdatedAt).toBeInstanceOf(Date);
    });

    it('records a change made in the dashboard as such', async () => {
      identityRepo.findOne.mockResolvedValueOnce(existing());

      await service.updateConsent('proj-1', 'id-1', { pushOptIn: false, smsOptIn: false }, null);

      expect(consentEvents.record).toHaveBeenCalledWith(
        [
          { projectId: 'proj-1', deviceIdentityId: 'id-1', channel: 'sms', granted: false, source: 'dashboard' },
          { projectId: 'proj-1', deviceIdentityId: 'id-1', channel: 'push', granted: false, source: 'dashboard' },
        ],
        txManager,
      );
    });

    it('does not save the flag when its history cannot be written', async () => {
      identityRepo.findOne.mockResolvedValueOnce(existing());
      consentEvents.record.mockRejectedValueOnce(new Error('insert failed'));

      await expect(service.updateConsent('proj-1', 'id-1', { pushOptIn: false }, null)).rejects.toThrow(
        'insert failed',
      );
      // Both inside one transaction: the error rolls the flag back with it.
      expect(identityRepo.save).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // do-not-track
  // ---------------------------------------------------------------------------
  describe('do-not-track', () => {
    const baseDto = { projectId: 'proj-1', deviceFingerprint: 'fp-1', platform: 'ios' };

    it('stores consent and profile from identify, but no session, address, place or attribution', async () => {
      identityRepo.findOne.mockResolvedValueOnce({
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        doNotTrack: false,
        totalSessions: 3,
        ipAddress: null,
        latestUtmSource: 'old',
      });

      const result = await service.identify(
        { ...baseDto, doNotTrack: true, firstName: 'Asha', utmSource: 'new', smsOptIn: true },
        '8.8.8.8',
      );

      expect(result.doNotTrack).toBe(true);
      expect(result.smsOptIn).toBe(true);
      expect(result.firstName).toBe('Asha');
      expect(result.totalSessions).toBe(3);
      expect(result.ipAddress).toBeNull();
      expect(result.latestUtmSource).toBe('old');
      expect(result.country).toBeUndefined();
      expect(trackingConsent.recordDrop).toHaveBeenCalledWith('session');
    });

    it('asks about this device and the external id it now claims, nothing wider', async () => {
      // The lookup is proved against Postgres in consent.int-spec.ts; here,
      // only what identify passes and what it does with a yes.
      doNotTrackPerson = true;
      identityRepo.findOne.mockResolvedValueOnce({
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        doNotTrack: false,
        totalSessions: 3,
        externalUserId: null,
      });

      const result = await service.identify({ ...baseDto, externalUserId: 'asha' }, '8.8.8.8');

      expect(trackingConsent.isDoNotTrack).toHaveBeenCalledWith(
        { projectId: 'proj-1', deviceIdentityId: 'id-1', externalUserId: 'asha' },
        // On locked()'s manager, never a second connection.
        txManager,
      );
      expect(result.totalSessions).toBe(3);
      expect(result.ipAddress).toBeUndefined();
    });

    it('keeps last_seen_at where it was for a do-not-track device', async () => {
      const lastSeen = new Date('2026-01-01T00:00:00Z');
      identityRepo.findOne.mockResolvedValueOnce({
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        doNotTrack: true,
        totalSessions: 3,
        lastSeenAt: lastSeen,
      });
      txManager.update.mockClear();

      const result = await service.identify({ ...baseDto });

      expect(result.lastSeenAt).toBe(lastSeen);
      // An UpdateDateColumn moves on any save, so it is written back by name.
      expect(txManager.update).toHaveBeenCalledWith(
        DeviceIdentityEntity,
        { id: 'id-1' },
        { lastSeenAt: lastSeen },
      );
    });

    it('counts the session of someone who is not do-not-track', async () => {
      identityRepo.findOne.mockResolvedValueOnce({
        id: 'id-1',
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        doNotTrack: false,
        totalSessions: 3,
      });
      identityRepo.save.mockImplementation(async (obj) => obj);

      const result = await service.identify({ ...baseDto }, '8.8.8.8');

      expect(result.totalSessions).toBe(4);
      expect(result.ipAddress).toBe('8.8.8.8');
      expect(trackingConsent.recordDrop).not.toHaveBeenCalled();
    });

    it('creates a do-not-track identity with no address, place, attribution or session', async () => {
      identityRepo.findOne.mockResolvedValueOnce(null);
      identityRepo.create.mockImplementation((obj) => ({ ...obj }));

      await service.identify(
        { ...baseDto, doNotTrack: true, referrer: 'https://ads.example.com', utmSource: 'ads', installSource: 'play' },
        '8.8.8.8',
      );

      expect(identityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          doNotTrack: true,
          ipAddress: null,
          initialReferrer: null,
          initialUtmSource: null,
          installSource: null,
          latestUtmSource: null,
          totalSessions: 0,
        }),
      );
      const created = identityRepo.create.mock.calls[0][0];
      expect(created.country).toBeUndefined();
    });

    it('stores no revenue for a do-not-track person', async () => {
      identityRepo.findOne.mockResolvedValueOnce({
        id: 'id-1',
        projectId: 'proj-1',
        doNotTrack: true,
        totalRevenue: 10,
      });

      await service.trackRevenue({ projectId: 'proj-1', deviceFingerprint: 'fp-1', amount: 99 });

      expect(identityRepo.save).not.toHaveBeenCalled();
      expect(trackingConsent.recordDrop).toHaveBeenCalledWith('revenue');
    });
  });
});
