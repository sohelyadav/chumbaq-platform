import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SegmentEntity } from '../segments/entities/segment.entity';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { JourneysService } from './journeys.service';
import { JourneyEntity } from './entities/journey.entity';
import { JourneyRunEntity } from './entities/journey-run.entity';
import { JourneyStep, JourneyTrigger } from './journey-definition';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

describe('JourneysService', () => {
  let service: JourneysService;

  const journeyRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((o) => o),
    remove: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
  };
  const runRepo = { createQueryBuilder: jest.fn() };
  // Behaves like the database: counts only segments seeded in that project.
  const projectSegments: Record<string, string[]> = {};
  const segmentRepo = {
    count: jest.fn(async ({ where }: { where: { id: { _value: string[] }; projectId: string } }) =>
      where.id._value.filter((id) => (projectSegments[where.projectId] ?? []).includes(id)).length,
    ),
  };

  const trigger: JourneyTrigger = { type: 'event', eventName: 'signup' };
  const steps: JourneyStep[] = [
    { type: 'wait', durationSeconds: 3600 },
    { type: 'send_push', title: 'Hello' },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    // Deletes and status changes write their activity entry in the same transaction.
    Object.assign(journeyRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => journeyRepo }) },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        JourneysService,
        { provide: getRepositoryToken(JourneyEntity), useValue: journeyRepo },
        { provide: getRepositoryToken(JourneyRunEntity), useValue: runRepo },
        { provide: getRepositoryToken(SegmentEntity), useValue: segmentRepo },
      ],
    }).compile();
    service = module.get(JourneysService);
  });

  describe('create', () => {
    it('stores a valid journey as a draft', async () => {
      journeyRepo.save.mockImplementation(async (o) => ({ id: 'j1', ...o }));

      const created = await service.create('proj-1', {
        name: 'Onboarding',
        trigger,
        steps,
      });

      // Never active on creation: activating is the deliberate act that sets
      // the enrolment watermark.
      expect(created).toMatchObject({ projectId: 'proj-1', status: 'draft' });
    });

    it('refuses a definition that would fail once running', async () => {
      await expect(
        service.create('proj-1', {
          name: 'Broken',
          trigger,
          steps: [{ type: 'send_push', title: '' }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(journeyRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('refuses to edit a journey people are inside', async () => {
      journeyRepo.findOne.mockResolvedValueOnce({
        id: 'j1',
        projectId: 'proj-1',
        status: 'active',
        trigger,
        steps,
      });

      // Renumbering underneath a run moves someone to a step that means
      // something else, or to one that no longer exists.
      await expect(
        service.update('proj-1', 'j1', { name: 'New' }),
      ).rejects.toThrow(BadRequestException);
      expect(journeyRepo.save).not.toHaveBeenCalled();
    });

    it('allows editing a paused journey', async () => {
      journeyRepo.findOne.mockResolvedValueOnce({
        id: 'j1',
        projectId: 'proj-1',
        status: 'paused',
        trigger,
        steps,
      });
      journeyRepo.save.mockImplementation(async (o) => o);

      await expect(
        service.update('proj-1', 'j1', { name: 'Renamed' }),
      ).resolves.toMatchObject({ name: 'Renamed' });
    });

    it('validates the result, not just the change', async () => {
      journeyRepo.findOne.mockResolvedValueOnce({
        id: 'j1',
        projectId: 'proj-1',
        status: 'draft',
        trigger,
        steps,
      });

      await expect(
        service.update('proj-1', 'j1', { steps: [] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('setStatus', () => {
    const draft = () => ({
      id: 'j1',
      projectId: 'proj-1',
      status: 'draft',
      trigger,
      steps,
      enrolledThrough: null as Date | null,
    });

    /**
     * The journey as the database holds it: read by `findOne`, and changed by an
     * `update` only while it still has the status the update is conditional on.
     */
    const stored = <T extends { status: string }>(journey: T): T => {
      journeyRepo.findOne.mockResolvedValue(journey);
      journeyRepo.update.mockImplementation(async (where: { status: string }, set: Partial<T>) => {
        if (journey.status !== where.status) return { affected: 0 };
        Object.assign(journey, set);
        return { affected: 1 };
      });
      return journey;
    };

    it('starts enrolment from activation, not from the beginning of time', async () => {
      const journey = draft();
      stored(journey);

      await service.setStatus('proj-1', 'j1', 'active', REQUESTER);

      // Otherwise switching a journey on against a mature project enrols
      // everyone who ever matched it.
      expect(journey.enrolledThrough).toBeInstanceOf(Date);
      expect(journey.status).toBe('active');
    });

    it('leaves the watermark alone when resuming a paused journey', async () => {
      const paused = new Date('2026-06-01T00:00:00Z');
      const journey = {
        ...draft(),
        status: 'paused' as const,
        enrolledThrough: paused,
      };
      stored(journey);

      await service.setStatus('proj-1', 'j1', 'active', REQUESTER);

      // Resetting it here would make a pause a silent stop-and-restart —
      // everyone who matched while it was paused would be skipped, invisibly.
      expect(journey.enrolledThrough).toBe(paused);
      expect(journey.status).toBe('active');
    });

    it('sets the watermark when an archived journey goes live again', async () => {
      const journey = { ...draft(), status: 'archived' as const };
      stored(journey);

      await service.setStatus('proj-1', 'j1', 'active', REQUESTER);

      // Only a pause is a pause. Anything else going live is a fresh start,
      // and picking up months of backlog would be the surprise.
      expect(journey.enrolledThrough).toBeInstanceOf(Date);
    });

    it('writes the entry only when this request moved the status', async () => {
      const journey = stored({ ...draft(), status: 'active' as const });
      // Another request activated it between this one's read and its update.
      journeyRepo.findOne.mockResolvedValueOnce({ ...draft() });
      activity.record.mockClear();

      const result = await service.setStatus('proj-1', 'j1', 'active', REQUESTER);

      expect(result).toBe(journey);
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('refuses to activate a journey that would fail', async () => {
      journeyRepo.findOne.mockResolvedValueOnce({ ...draft(), steps: [] });

      await expect(
        service.setStatus('proj-1', 'j1', 'active', REQUESTER),
      ).rejects.toThrow(BadRequestException);
    });

    it('pausing leaves runs to finish rather than abandoning them', async () => {
      const journey = { ...draft(), status: 'active' as const };
      stored(journey);

      await service.setStatus('proj-1', 'j1', 'paused', REQUESTER);

      // Nothing touches existing runs: stopping someone between a message and
      // its follow-up is worse than letting the journey drain.
      expect(journey.status).toBe('paused');
      expect(runRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('refuses while people are inside it', async () => {
      journeyRepo.findOne.mockResolvedValueOnce({
        id: 'j1',
        projectId: 'proj-1',
        status: 'active',
      });

      await expect(service.remove('proj-1', 'j1', REQUESTER)).rejects.toThrow(
        BadRequestException,
      );
      expect(journeyRepo.remove).not.toHaveBeenCalled();
    });
  });

  describe('scoping', () => {
    it('will not read another project\'s journey', async () => {
      journeyRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findOne('proj-1', 'j1')).rejects.toThrow(
        NotFoundException,
      );
      expect(journeyRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'j1', projectId: 'proj-1' },
      });
    });
  });

  describe('segments it names', () => {
    const SEG_A = '11111111-1111-4111-8111-111111111111';
    const SEG_B = '22222222-2222-4222-8222-222222222222';
    beforeEach(() => {
      projectSegments['proj-1'] = [SEG_A];
      projectSegments['proj-2'] = [SEG_B];
      journeyRepo.save.mockImplementation(async (o: unknown) => o);
    });

    it('accepts a segment trigger from its own project', async () => {
      await expect(
        service.create('proj-1', { name: 'j', trigger: { type: 'segment_entry', segmentId: SEG_A }, steps }),
      ).resolves.toBeDefined();
    });

    it("refuses another project's segment as the trigger, before saving", async () => {
      await expect(
        service.create('proj-1', { name: 'j', trigger: { type: 'segment_entry', segmentId: SEG_B }, steps }),
      ).rejects.toThrow('does not belong to this project');
      expect(journeyRepo.save).not.toHaveBeenCalled();
    });

    it("refuses another project's segment in a branch step", async () => {
      await expect(
        service.create('proj-1', {
          name: 'j',
          trigger,
          steps: [
            { type: 'branch', segmentId: SEG_B, ifMember: 1, ifNot: 1 },
            { type: 'send_push', title: 'Hi' },
          ],
        }),
      ).rejects.toThrow('does not belong to this project');
    });

    it("refuses to activate a journey saved earlier with another project's segment", async () => {
      journeyRepo.findOne.mockResolvedValueOnce({
        id: 'j1',
        projectId: 'proj-1',
        status: 'paused',
        trigger: { type: 'segment_entry', segmentId: SEG_B },
        steps,
      });
      await expect(service.setStatus('proj-1', 'j1', 'active', REQUESTER)).rejects.toThrow(
        'does not belong to this project',
      );
      expect(journeyRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a segment id that is not a uuid without querying', async () => {
      await expect(
        service.create('proj-1', { name: 'j', trigger: { type: 'segment_entry', segmentId: 'nope' }, steps }),
      ).rejects.toThrow('does not belong to this project');
      expect(segmentRepo.count).not.toHaveBeenCalled();
    });
  });
});
