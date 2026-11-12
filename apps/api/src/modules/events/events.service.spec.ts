import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventsService } from './events.service';
import { UserEventEntity } from './entities/user-event.entity';
import { IdentityService } from '../identity/identity.service';

import { TrackingConsentService } from '../consent/tracking-consent.service';

/** Nobody is do-not-track unless a test says so. */
const trackingConsent = {
  isDoNotTrack: jest.fn(async (_subject: unknown) => false),
  withoutDoNotTrack: jest.fn(async (_projectId: string, ids: string[]) => ids),
  recordDrop: jest.fn(),
};

describe('EventsService', () => {
  let service: EventsService;

  const makeQb = () => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    getRawMany: jest.fn(),
    getMany: jest.fn(),
    getManyAndCount: jest.fn(),
  });

  let qb: ReturnType<typeof makeQb>;

  const eventRepository = {
    create: jest.fn((entity) => entity),
    save: jest.fn((entity) => Promise.resolve({ id: 'event-1', ...entity })),
    createQueryBuilder: jest.fn(),
  };

  const identityService = {
    findByFingerprintAndProject: jest.fn(),
    updateLastSeen: jest.fn(),
    updateLastEventAt: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    qb = makeQb();
    eventRepository.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: TrackingConsentService, useValue: trackingConsent },
        EventsService,
        { provide: getRepositoryToken(UserEventEntity), useValue: eventRepository },
        { provide: IdentityService, useValue: identityService },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  // ---------------------------------------------------------------------------
  // track
  // ---------------------------------------------------------------------------
  describe('track', () => {
    it('creates an event without identity when no fingerprint is provided', async () => {
      const dto = {
        projectId: 'proj-1',
        eventName: 'button_click',
        distinctId: 'user-abc',
        properties: { button: 'cta' },
      };

      const result = await service.track(dto as any);

      expect(identityService.findByFingerprintAndProject).not.toHaveBeenCalled();
      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          eventName: 'button_click',
          distinctId: 'user-abc',
          properties: { button: 'cta' },
          sourceType: 'sdk',
          deviceIdentityId: null,
        }),
      );
      expect(result).toHaveProperty('id', 'event-1');
    });

    it('resolves device identity when fingerprint is provided', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'id-1',
        distinctId: 'user-xyz',
        deviceFingerprint: 'fp-1',
      });
      identityService.updateLastSeen.mockResolvedValue(undefined);
      identityService.updateLastEventAt.mockResolvedValue(undefined);

      const dto = {
        projectId: 'proj-1',
        eventName: 'page_view',
        deviceFingerprint: 'fp-1',
      };

      await service.track(dto as any);

      expect(identityService.findByFingerprintAndProject).toHaveBeenCalledWith('fp-1', 'proj-1');
      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceIdentityId: 'id-1',
          distinctId: 'user-xyz',
        }),
      );
    });

    it('falls back to device fingerprint when identity has no distinctId', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'id-2',
        distinctId: null,
        deviceFingerprint: 'fp-2',
      });
      identityService.updateLastSeen.mockResolvedValue(undefined);
      identityService.updateLastEventAt.mockResolvedValue(undefined);

      const dto = {
        projectId: 'proj-1',
        eventName: 'page_view',
        deviceFingerprint: 'fp-2',
      };

      await service.track(dto as any);

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ distinctId: 'fp-2' }),
      );
    });

    it('prefers explicit dto distinctId over identity distinctId', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'id-3',
        distinctId: 'identity-user',
        deviceFingerprint: 'fp-3',
      });
      identityService.updateLastSeen.mockResolvedValue(undefined);
      identityService.updateLastEventAt.mockResolvedValue(undefined);

      const dto = {
        projectId: 'proj-1',
        eventName: 'page_view',
        deviceFingerprint: 'fp-3',
        distinctId: 'explicit-user',
      };

      await service.track(dto as any);

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ distinctId: 'explicit-user' }),
      );
    });

    it('parses timestamp string to a Date', async () => {
      const dto = {
        projectId: 'proj-1',
        eventName: 'click',
        timestamp: '2025-01-01T12:00:00.000Z',
      };

      await service.track(dto as any);

      const createdArg = eventRepository.create.mock.calls[0][0];
      expect(createdArg.timestamp).toBeInstanceOf(Date);
      expect(createdArg.timestamp.toISOString()).toBe('2025-01-01T12:00:00.000Z');
    });

    it('defaults timestamp to now when not provided', async () => {
      const dto = { projectId: 'proj-1', eventName: 'click' };

      await service.track(dto as any);

      const createdArg = eventRepository.create.mock.calls[0][0];
      expect(createdArg.timestamp).toBeInstanceOf(Date);
    });

    it('swallows identity update rejections to avoid failing the track call', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'id-4',
        distinctId: 'u',
        deviceFingerprint: 'fp-4',
      });
      identityService.updateLastSeen.mockRejectedValueOnce(new Error('db down'));
      identityService.updateLastEventAt.mockRejectedValueOnce(new Error('db down'));

      const dto = {
        projectId: 'proj-1',
        eventName: 'click',
        deviceFingerprint: 'fp-4',
      };

      await expect(service.track(dto as any)).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // trackServerEvent
  // ---------------------------------------------------------------------------
  describe('trackServerEvent', () => {
    it('creates an event with all server-side metadata', async () => {
      const params = {
        projectId: 'proj-1',
        distinctId: 'u-1',
        deviceIdentityId: 'di-1',
        eventName: 'signup',
        properties: { plan: 'pro' },
        sourceType: 'server',
        sourceId: 'src-1',
        ipAddress: '1.2.3.4',
        userAgent: 'curl',
        platform: 'server',
        country: 'US',
        city: 'NYC',
      };

      await service.trackServerEvent(params);

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          distinctId: 'u-1',
          deviceIdentityId: 'di-1',
          eventName: 'signup',
          sourceType: 'server',
          sourceId: 'src-1',
          ipAddress: '1.2.3.4',
          platform: 'server',
          country: 'US',
          city: 'NYC',
        }),
      );
    });

    it('defaults optional fields to null', async () => {
      await service.trackServerEvent({
        projectId: 'proj-1',
        eventName: 'signup',
        sourceType: 'server',
      });

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: null,
          deviceIdentityId: null,
          properties: null,
          sourceId: null,
          ipAddress: null,
          userAgent: null,
          platform: null,
          country: null,
          city: null,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // queryByUser
  // ---------------------------------------------------------------------------
  describe('queryByUser', () => {
    it('filters by project_id and distinct_id with default pagination', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[{ id: 'e1' }], 1]);

      const result = await service.queryByUser('proj-1', 'user-1', {});

      expect(qb.where).toHaveBeenCalledWith('event.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('event.distinct_id = :distinctId', {
        distinctId: 'user-1',
      });
      expect(qb.take).toHaveBeenCalledWith(50);
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(result).toEqual({ data: [{ id: 'e1' }], total: 1 });
    });

    it('applies eventName filter when provided', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.queryByUser('proj-1', 'user-1', { eventName: 'login' });

      expect(qb.andWhere).toHaveBeenCalledWith('event.event_name = :eventName', {
        eventName: 'login',
      });
    });

    it('honors explicit limit and offset', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.queryByUser('proj-1', 'user-1', { limit: 10, offset: 20 });

      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.skip).toHaveBeenCalledWith(20);
    });
  });

  // ---------------------------------------------------------------------------
  // queryByProject
  // ---------------------------------------------------------------------------
  describe('queryByProject', () => {
    it('filters by project and applies eventName + time range', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.queryByProject('proj-1', {
        eventName: 'signup',
        start: '2025-01-01T00:00:00.000Z',
        end: '2025-02-01T00:00:00.000Z',
      });

      expect(qb.where).toHaveBeenCalledWith('event.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('event.event_name = :eventName', {
        eventName: 'signup',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'event.timestamp >= :start',
        expect.objectContaining({ start: expect.any(Date) }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'event.timestamp <= :end',
        expect.objectContaining({ end: expect.any(Date) }),
      );
    });

    it('uses default pagination when no limit/offset given', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.queryByProject('proj-1', {});

      expect(qb.take).toHaveBeenCalledWith(50);
      expect(qb.skip).toHaveBeenCalledWith(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getEventNames
  // ---------------------------------------------------------------------------
  describe('getEventNames', () => {
    it('groups events by name ordered by count desc', async () => {
      const rows = [
        { eventName: 'page_view', count: 100 },
        { eventName: 'click', count: 50 },
      ];
      qb.getRawMany.mockResolvedValueOnce(rows);

      const result = await service.getEventNames('proj-1');

      expect(qb.where).toHaveBeenCalledWith('event.project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(qb.groupBy).toHaveBeenCalledWith('event.event_name');
      expect(qb.orderBy).toHaveBeenCalledWith('count', 'DESC');
      expect(result).toEqual(rows);
    });
  });

  // ---------------------------------------------------------------------------
  // getEventVolume
  // ---------------------------------------------------------------------------
  describe('getEventVolume', () => {
    it('returns mapped date/count pairs with default granularity', async () => {
      qb.getRawMany.mockResolvedValueOnce([
        { date: '2025-01-01', count: '10' },
        { date: '2025-01-02', count: '5' },
      ]);

      const result = await service.getEventVolume('proj-1', {});

      expect(qb.select).toHaveBeenCalledWith(
        expect.stringContaining("DATE_TRUNC('day'"),
        'date',
      );
      expect(result).toEqual([
        { date: '2025-01-01', count: 10 },
        { date: '2025-01-02', count: 5 },
      ]);
    });

    it('uses custom granularity and filters by event name', async () => {
      qb.getRawMany.mockResolvedValueOnce([]);

      await service.getEventVolume('proj-1', {
        granularity: 'hour',
        eventName: 'signup',
      });

      expect(qb.select).toHaveBeenCalledWith(
        expect.stringContaining("DATE_TRUNC('hour'"),
        'date',
      );
      expect(qb.andWhere).toHaveBeenCalledWith('event.event_name = :eventName', {
        eventName: 'signup',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getEventBreakdown
  // ---------------------------------------------------------------------------
  describe('getEventBreakdown', () => {
    it('limits to 20 rows ordered by count desc', async () => {
      qb.getRawMany.mockResolvedValueOnce([{ eventName: 'click', count: 3 }]);

      const result = await service.getEventBreakdown('proj-1', {});

      expect(qb.limit).toHaveBeenCalledWith(20);
      expect(qb.orderBy).toHaveBeenCalledWith('count', 'DESC');
      expect(result).toEqual([{ eventName: 'click', count: 3 }]);
    });

    it('uses provided start and end', async () => {
      qb.getRawMany.mockResolvedValueOnce([]);

      await service.getEventBreakdown('proj-1', {
        start: '2025-01-01T00:00:00.000Z',
        end: '2025-01-31T00:00:00.000Z',
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'event.timestamp >= :start',
        expect.objectContaining({ start: expect.any(Date) }),
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'event.timestamp <= :end',
        expect.objectContaining({ end: expect.any(Date) }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateDistinctId
  // ---------------------------------------------------------------------------
  describe('updateDistinctId', () => {
    it('runs an update scoped to project and old distinct id', async () => {
      qb.execute.mockResolvedValueOnce({ affected: 5 });

      await service.updateDistinctId('proj-1', 'old-id', 'new-id');

      expect(qb.update).toHaveBeenCalledWith(UserEventEntity);
      expect(qb.set).toHaveBeenCalledWith({ distinctId: 'new-id' });
      expect(qb.where).toHaveBeenCalledWith('project_id = :projectId', {
        projectId: 'proj-1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('distinct_id = :oldDistinctId', {
        oldDistinctId: 'old-id',
      });
      expect(qb.execute).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // do-not-track
  // ---------------------------------------------------------------------------
  describe('track for a do-not-track person', () => {
    it('stores nothing, touches no identity, counts the drop, and returns null', async () => {
      trackingConsent.isDoNotTrack.mockResolvedValueOnce(true);

      const result = await service.track({
        projectId: 'proj-1',
        eventName: 'screen_view',
        deviceFingerprint: 'fp-1',
        distinctId: 'user-1',
      } as any);

      expect(result).toBeNull();
      expect(trackingConsent.isDoNotTrack).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        distinctId: 'user-1',
      });
      expect(eventRepository.save).not.toHaveBeenCalled();
      expect(identityService.updateLastSeen).not.toHaveBeenCalled();
      expect(identityService.updateLastEventAt).not.toHaveBeenCalled();
      expect(trackingConsent.recordDrop).toHaveBeenCalledWith('event');
    });

    it('stores the event of someone who is not do-not-track', async () => {
      const result = await service.track({ projectId: 'proj-1', eventName: 'x', distinctId: 'u' } as any);
      expect(eventRepository.save).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('id', 'event-1');
      expect(trackingConsent.recordDrop).not.toHaveBeenCalled();
    });
  });
});
