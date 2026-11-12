import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PushTemplatesService } from './push-templates.service';
import { PushTemplateEntity } from './entities/push-template.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

describe('PushTemplatesService', () => {
  let service: PushTemplatesService;
  let qb: any;

  const templateRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((o) => o),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    qb = {};
    for (const m of ['update', 'set', 'where']) qb[m] = jest.fn(() => qb);
    qb.execute = jest.fn();
    templateRepo.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        PushTemplatesService,
        {
          provide: getRepositoryToken(PushTemplateEntity),
          useValue: templateRepo,
        },
      ],
    }).compile();

    service = module.get(PushTemplatesService);
  });

  describe('findAll', () => {
    it('orders most-used first', async () => {
      templateRepo.find.mockResolvedValueOnce([]);

      await service.findAll('proj-1');

      // The list is a picker; the template reached for most often should not
      // be buried under alphabetical order.
      expect(templateRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1' },
        order: { useCount: 'DESC', name: 'ASC' },
      });
    });
  });

  describe('findOne', () => {
    it('is project-scoped', async () => {
      templateRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findOne('proj-1', 't1')).rejects.toThrow(
        NotFoundException,
      );
      expect(templateRepo.findOne).toHaveBeenCalledWith({
        where: { id: 't1', projectId: 'proj-1' },
      });
    });
  });

  describe('create', () => {
    it('stores the content', async () => {
      templateRepo.findOne.mockResolvedValueOnce(null);
      templateRepo.save.mockImplementation(async (o) => ({ id: 't1', ...o }));

      const created = await service.create('proj-1', {
        name: 'Weekly promo',
        title: 'Hello',
        body: 'World',
      });

      expect(created).toMatchObject({
        projectId: 'proj-1',
        name: 'Weekly promo',
        title: 'Hello',
        body: 'World',
      });
    });

    it('refuses a duplicate name in the same project', async () => {
      templateRepo.findOne.mockResolvedValueOnce({ id: 'existing' });

      // Two identical entries in a picker is how the wrong copy gets sent.
      await expect(
        service.create('proj-1', { name: 'Weekly promo', title: 'x' }),
      ).rejects.toThrow(ConflictException);
      expect(templateRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('rich content', () => {
    const base = { name: 'Flash sale', title: 'Ends tonight' };

    it('stores action buttons, a carousel and a countdown', async () => {
      // Before these columns a template could only express text and image, so
      // "start from a template" silently dropped the three layouts that rich
      // content makes possible.
      templateRepo.findOne.mockResolvedValueOnce(null);
      templateRepo.save.mockImplementation(async (t: unknown) => t);

      const saved = await service.create('proj-1', {
        ...base,
        actions: [{ id: 'shop', title: 'Shop now', deepLinkUrl: 'myapp://shop' }],
        iosCategory: 'SALE',
        carousel: [
          { imageUrl: 'https://example.com/1.png', caption: 'Shoes' },
          { imageUrl: 'https://example.com/2.png' },
        ],
        timer: { durationSeconds: 3600 },
      });

      expect(saved.actions).toHaveLength(1);
      expect(saved.iosCategory).toBe('SALE');
      expect(saved.carousel).toHaveLength(2);
      expect(saved.timer).toEqual({ durationSeconds: 3600 });
    });

    it('leaves rich content null when a template is plain text', async () => {
      // null rather than an empty array: an empty list reads as "this template
      // has no buttons" where the campaign expects the field to be absent.
      templateRepo.findOne.mockResolvedValueOnce(null);
      templateRepo.save.mockImplementation(async (t: unknown) => t);

      const saved = await service.create('proj-1', base);

      expect(saved.actions).toBeNull();
      expect(saved.carousel).toBeNull();
      expect(saved.timer).toBeNull();
      expect(saved.iosCategory).toBeNull();
    });

    it('refuses a fixed countdown, which a reused template cannot honour', async () => {
      // The rule that is stricter here than on a campaign. A campaign's
      // countdown is checked against the instant it goes out; a template has
      // no send time, so a fixed moment would pass and every campaign started
      // from it afterwards would arrive already expired.
      templateRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.create('proj-1', {
          ...base,
          timer: { endsAt: '2099-01-01T00:00:00.000Z' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(templateRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a countdown too short to read', async () => {
      templateRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.create('proj-1', { ...base, timer: { durationSeconds: 5 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a carousel the campaign would refuse too', async () => {
      // Same rules as a campaign, so a template cannot store something that
      // breaks the moment it is used.
      templateRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.create('proj-1', {
          ...base,
          carousel: [{ imageUrl: 'https://example.com/only.png' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('validates on update as well as create', async () => {
      templateRepo.findOne.mockResolvedValueOnce({ id: 't1', name: 'Flash sale' });

      await expect(
        service.update('proj-1', 't1', { timer: { endsAt: '2099-01-01T00:00:00.000Z' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(templateRepo.save).not.toHaveBeenCalled();
    });

    it('clears rich content when it is explicitly set to null', async () => {
      const existing = {
        id: 't1', name: 'Flash sale',
        actions: [{ id: 'a', title: 'A' }], carousel: [], timer: { durationSeconds: 60 },
      };
      templateRepo.findOne.mockResolvedValueOnce(existing);
      templateRepo.save.mockImplementation(async (t: unknown) => t);

      const saved = await service.update('proj-1', 't1', {
        actions: undefined as never,
        carousel: null as never,
        timer: null as never,
      });

      // `undefined` means "not supplied" and must leave the field alone;
      // an explicit null means "remove it".
      expect(saved.actions).toEqual([{ id: 'a', title: 'A' }]);
      expect(saved.carousel).toBeNull();
      expect(saved.timer).toBeNull();
    });
  });

  describe('update', () => {
    it('changes only what was supplied', async () => {
      const existing: any = {
        id: 't1',
        projectId: 'proj-1',
        name: 'Old',
        title: 'Old title',
        body: 'Old body',
      };
      templateRepo.findOne.mockResolvedValueOnce(existing);
      templateRepo.save.mockImplementation(async (o) => o);

      await service.update('proj-1', 't1', { title: 'New title' });

      expect(existing.title).toBe('New title');
      expect(existing.body).toBe('Old body');
      expect(existing.name).toBe('Old');
    });

    it('does not let a client rewrite the usage record', async () => {
      const existing: any = {
        id: 't1',
        projectId: 'proj-1',
        name: 'Old',
        useCount: 12,
        lastUsedAt: new Date('2026-01-01'),
      };
      templateRepo.findOne.mockResolvedValueOnce(existing);
      templateRepo.save.mockImplementation(async (o) => o);

      await service.update('proj-1', 't1', {
        title: 'New',
        useCount: 0,
      } as never);

      // useCount and lastUsedAt record what happened; they are not settings.
      expect(existing.useCount).toBe(12);
    });

    it('refuses a rename onto an existing name', async () => {
      templateRepo.findOne
        .mockResolvedValueOnce({ id: 't1', projectId: 'proj-1', name: 'Old' })
        .mockResolvedValueOnce({ id: 't2' });

      await expect(
        service.update('proj-1', 't1', { name: 'Taken' }),
      ).rejects.toThrow(ConflictException);
    });

    it('allows saving without changing the name', async () => {
      const existing: any = { id: 't1', projectId: 'proj-1', name: 'Same' };
      templateRepo.findOne.mockResolvedValueOnce(existing);
      templateRepo.save.mockImplementation(async (o) => o);

      // Re-submitting the same name must not collide with itself.
      await expect(
        service.update('proj-1', 't1', { name: 'Same', title: 'x' }),
      ).resolves.toBeDefined();
    });
  });

  describe('recordUse', () => {
    it('increments atomically rather than reading and writing back', async () => {
      await service.recordUse('proj-1', 't1');

      // Two campaigns created from one template at the same moment must both
      // count; a read-modify-write would lose one.
      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
      const setArg = qb.set.mock.calls[0][0];
      expect(typeof setArg.useCount).toBe('function');
      expect(setArg.useCount()).toBe('use_count + 1');
    });

    it('is project-scoped', async () => {
      await service.recordUse('proj-1', 't1');
      expect(qb.where).toHaveBeenCalledWith(
        'id = :id AND project_id = :projectId',
        { id: 't1', projectId: 'proj-1' },
      );
    });
  });

  describe('remove', () => {
    it('refuses a template from another project', async () => {
      templateRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.remove('proj-1', 't1', REQUESTER)).rejects.toThrow(
        NotFoundException,
      );
      expect(templateRepo.remove).not.toHaveBeenCalled();
    });
  });
});
