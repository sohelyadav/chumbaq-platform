import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { InAppMessagesService } from './in-app-messages.service';
import { InAppMessageEntity } from './entities/in-app-message.entity';
import { CreateInAppMessageDto } from './dto/create-in-app-message.dto';
import { UpdateInAppMessageDto } from './dto/update-in-app-message.dto';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

const SEGMENT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('InAppMessagesService', () => {
  let service: InAppMessagesService;

  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockMessageRepo: any = {
    create: jest.fn((v) => v),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
    update: jest.fn(async () => ({ affected: 1 })),
    exists: jest.fn(async () => true),
    createQueryBuilder: jest.fn(() => qb),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Deletes and status changes write their activity entry in the same transaction.
    Object.assign(mockMessageRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => mockMessageRepo }) },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        InAppMessagesService,
        { provide: getRepositoryToken(InAppMessageEntity), useValue: mockMessageRepo },
      ],
    }).compile();

    service = module.get<InAppMessagesService>(InAppMessagesService);
  });

  describe('create', () => {
    it('creates a message scoped to project with coerced dates', async () => {
      const dto = {
        name: 'Summer Sale',
        messageType: 'modal',
        title: 'Big Deals',
        startsAt: '2024-06-01T00:00:00Z',
        endsAt: '2024-06-30T00:00:00Z',
      };
      mockMessageRepo.save.mockImplementation(async (v: any) => ({ id: 'm1', ...v }));

      const result = await service.create('proj-1', dto as any, 'user-42');

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Summer Sale',
          projectId: 'proj-1',
          createdBy: 'user-42',
          startsAt: expect.any(Date),
          endsAt: expect.any(Date),
        }),
      );
      expect((result as any).id).toBe('m1');
    });

    it('persists the segment a message targets', async () => {
      mockMessageRepo.save.mockImplementation(async (v: any) => ({ id: 'm2', ...v }));

      await service.create('proj-1', {
        name: 'Segment blast',
        messageType: 'modal',
        title: 'T',
        userType: 'segment',
        segmentId: SEGMENT_ID,
      } as any);

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userType: 'segment', segmentId: SEGMENT_ID }),
      );
    });

    it('sets createdBy to null and dates to null when not provided', async () => {
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      await service.create('proj-1', { name: 'X', messageType: 'modal', title: 'T' } as any);

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: null, startsAt: null, endsAt: null }),
      );
    });
  });

  describe('findAll', () => {
    it('paginates and orders by updated_at', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[{ id: 'm1' }], 1]);

      const result = await service.findAll('proj-1', { limit: 10, offset: 5 });

      expect(result.total).toBe(1);
      expect(qb.where).toHaveBeenCalledWith('msg.project_id = :projectId', { projectId: 'proj-1' });
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.skip).toHaveBeenCalledWith(5);
      expect(qb.orderBy).toHaveBeenCalledWith('msg.updated_at', 'DESC');
    });

    it('filters by status when provided', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll('proj-1', { status: 'active' });

      expect(qb.andWhere).toHaveBeenCalledWith('msg.status = :status', { status: 'active' });
    });

    it('uses default pagination when options are omitted', async () => {
      qb.getManyAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll('proj-1');

      expect(qb.take).toHaveBeenCalledWith(50);
      expect(qb.skip).toHaveBeenCalledWith(0);
    });
  });

  describe('findOne', () => {
    it('returns the message when found within the project', async () => {
      const msg = { id: 'm1', projectId: 'proj-1' };
      mockMessageRepo.findOne.mockResolvedValueOnce(msg);

      const result = await service.findOne('m1', 'proj-1');

      expect(result).toBe(msg);
      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'm1', projectId: 'proj-1' },
      });
    });

    it('enforces ownership by throwing when not found in project', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findOne('m1', 'proj-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('merges dto and preserves existing dates when dto has no dates', async () => {
      const existing: any = {
        id: 'm1',
        projectId: 'proj-1',
        status: 'draft',
        title: 'Old',
        startsAt: new Date('2024-01-01'),
        endsAt: new Date('2024-01-31'),
      };
      mockMessageRepo.findOne.mockResolvedValueOnce(existing);
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.update('m1', 'proj-1', { title: 'New' } as any, REQUESTER);

      expect(result.title).toBe('New');
      expect(result.startsAt).toEqual(new Date('2024-01-01'));
      expect(result.endsAt).toEqual(new Date('2024-01-31'));
    });

    it('coerces dto startsAt/endsAt strings into Date instances', async () => {
      const existing: any = { id: 'm1', projectId: 'proj-1', status: 'draft' };
      mockMessageRepo.findOne.mockResolvedValueOnce(existing);
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.update('m1', 'proj-1', {
        startsAt: '2024-06-01T00:00:00Z',
      } as any, REQUESTER);

      expect(result.startsAt).toBeInstanceOf(Date);
    });

    it('logs a warning when editing an active campaign without status change', async () => {
      const existing: any = { id: 'm1', projectId: 'proj-1', status: 'active' };
      mockMessageRepo.findOne.mockResolvedValueOnce(existing);
      mockMessageRepo.save.mockImplementation(async (v: any) => v);
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      await service.update('m1', 'proj-1', { title: 'New Title' } as any, REQUESTER);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Updating active in-app message'));
    });
  });

  describe('remove', () => {
    it('removes a non-active message', async () => {
      const msg = { id: 'm1', projectId: 'proj-1', status: 'draft' };
      mockMessageRepo.findOne.mockResolvedValueOnce(msg);

      await service.remove('m1', 'proj-1', REQUESTER);

      expect(mockMessageRepo.delete).toHaveBeenCalledWith({ id: 'm1', projectId: 'proj-1' });
    });

    it('prevents deletion of an active campaign', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce({
        id: 'm1',
        projectId: 'proj-1',
        status: 'active',
      });

      await expect(service.remove('m1', 'proj-1', REQUESTER)).rejects.toThrow(BadRequestException);
      expect(mockMessageRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('activate', () => {
    it('sets status to active when title is present', async () => {
      const msg: any = { id: 'm1', projectId: 'proj-1', title: 'Hello', status: 'draft' };
      mockMessageRepo.findOne.mockResolvedValueOnce(msg);
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.activate('m1', 'proj-1', REQUESTER);

      expect(result.status).toBe('active');
    });

    it('rejects activation when the message has no title', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce({ id: 'm1', projectId: 'proj-1', title: '' });

      await expect(service.activate('m1', 'proj-1', REQUESTER)).rejects.toThrow(BadRequestException);
    });

    it('reads the message under a row lock inside the transaction', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce({ id: 'm1', projectId: 'proj-1', title: 'Hi', status: 'draft' });
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      await service.activate('m1', 'proj-1', REQUESTER);

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'm1', projectId: 'proj-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(activity.record).toHaveBeenCalledTimes(1);
      expect(activity.record.mock.calls[0][0]).toMatchObject({ action: 'in_app_message.activated' });
    });

    it('writes nothing when the locked row is already active (the second of a double click)', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce({ id: 'm1', projectId: 'proj-1', title: 'Hi', status: 'active' });
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.activate('m1', 'proj-1', REQUESTER);

      expect(result.status).toBe('active');
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('logs an activation that runs after a concurrent archive against the archived status', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce({ id: 'm1', projectId: 'proj-1', title: 'Hi', status: 'archived' });
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      await service.activate('m1', 'proj-1', REQUESTER);

      expect(activity.record).toHaveBeenCalledTimes(1);
      expect(activity.record.mock.calls[0][0]).toMatchObject({ action: 'in_app_message.activated' });
    });

    it('throws 404 and writes nothing when the message is gone by the time the lock is taken', async () => {
      mockMessageRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.activate('m1', 'proj-1', REQUESTER)).rejects.toThrow(NotFoundException);
      expect(mockMessageRepo.save).not.toHaveBeenCalled();
      expect(activity.record).not.toHaveBeenCalled();
    });
  });

  describe('pause', () => {
    it('sets status to paused', async () => {
      const msg: any = { id: 'm1', projectId: 'proj-1', status: 'active' };
      mockMessageRepo.findOne.mockResolvedValueOnce(msg);
      mockMessageRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.pause('m1', 'proj-1', REQUESTER);

      expect(result.status).toBe('paused');
    });
  });

  describe('duplicate', () => {
    it('creates a draft copy with zeroed counters and "(Copy)" suffix', async () => {
      const original: any = {
        id: 'm1',
        projectId: 'proj-1',
        name: 'Original',
        title: 'Hello',
        status: 'active',
        totalImpressions: 100,
        totalClicks: 20,
        totalDismissals: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockMessageRepo.findOne.mockResolvedValueOnce(original);
      mockMessageRepo.save.mockImplementation(async (v: any) => ({ id: 'm2', ...v }));

      const result = await service.duplicate('m1', 'proj-1');

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Original (Copy)',
          status: 'draft',
          totalImpressions: 0,
          totalClicks: 0,
          totalDismissals: 0,
        }),
      );
      // The id of the original must not leak into the duplicate
      const createArg = mockMessageRepo.create.mock.calls[0][0];
      expect(createArg.id).toBeUndefined();
      expect((result as any).id).toBe('m2');
    });
  });

  describe('incrementCounter', () => {
    it('runs an update query with the right column expression', async () => {
      await service.incrementCounter('m1', 'totalClicks');

      expect(qb.update).toHaveBeenCalledWith(InAppMessageEntity);
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ totalClicks: expect.any(Function) }),
      );
      expect(qb.execute).toHaveBeenCalled();
    });
  });
});

/**
 * The entity, the migration and MessageDeliveryService all carry segment_id,
 * but the field only reaches them through this DTO. The global ValidationPipe
 * runs with whitelist + forbidNonWhitelisted, so an undeclared segmentId is
 * not merely dropped — the whole request 400s and no caller can create a
 * segment-targeted message at all. These cases pin the declaration by running
 * the same pipe options the app boots with.
 */
describe('in-app message DTO segment targeting', () => {
  const pipeOptions = { whitelist: true, forbidNonWhitelisted: true } as const;

  const errorsFor = <T extends object>(dto: object, cls: new () => T) =>
    validateSync(plainToInstance(cls, dto), pipeOptions);

  const base = { name: 'Segment blast', messageType: 'modal', title: 'T' };

  it('accepts segmentId on create rather than rejecting it as an unknown field', () => {
    const errors = errorsFor(
      { ...base, userType: 'segment', segmentId: SEGMENT_ID },
      CreateInAppMessageDto,
    );

    expect(errors).toEqual([]);
  });

  it('accepts segmentId on update, which inherits the field via PartialType', () => {
    expect(errorsFor({ segmentId: SEGMENT_ID }, UpdateInAppMessageDto)).toEqual([]);
  });

  it('still rejects a segmentId that is not a UUID', () => {
    const errors = errorsFor({ ...base, segmentId: 'not-a-uuid' }, CreateInAppMessageDto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('segmentId');
  });

  it('still rejects a genuinely unknown field, proving the whitelist is live', () => {
    const errors = errorsFor({ ...base, bogusField: 'x' }, CreateInAppMessageDto);

    expect(errors.map((e) => e.property)).toContain('bogusField');
  });
});
