import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InAppBannersService } from './in-app-banners.service';
import { InAppBannerEntity } from './entities/in-app-banner.entity';
import { BannerCategoryEntity } from './entities/banner-category.entity';
import { WidgetEventEntity } from './entities/widget-event.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

describe('InAppBannersService', () => {
  let service: InAppBannersService;

  // Chainable query builder that tracks the last `.execute()` call.
  const makeUpdateQb = () => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereInIds: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  });

  let lastUpdateQb: any;

  const mockBannerRepo: any = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => {
      lastUpdateQb = makeUpdateQb();
      return lastUpdateQb;
    }),
  };

  const mockCategoryRepo = {
    findOne: jest.fn(),
  };

  const mockEventRepo = {
    create: jest.fn((v) => v),
    save: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn(async (fn: any) => {
      const manager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
      (mockDataSource as any).lastManager = manager;
      return fn(manager);
    }),
  };

  let suspendedProject: string | null = null;
  const suspension = {
    isSuspended: jest.fn(async (id: string) => id === suspendedProject),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    suspendedProject = null;

    // Deletes and status changes write their activity entry in the same transaction.
    Object.assign(mockBannerRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => mockBannerRepo }) },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        InAppBannersService,
        { provide: getRepositoryToken(InAppBannerEntity), useValue: mockBannerRepo },
        { provide: getRepositoryToken(BannerCategoryEntity), useValue: mockCategoryRepo },
        { provide: getRepositoryToken(WidgetEventEntity), useValue: mockEventRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    service = module.get<InAppBannersService>(InAppBannersService);
  });

  describe('create', () => {
    it('creates a banner scoped to the category', async () => {
      const dto = { title: 'Promo' };
      const entity = { ...dto, categoryId: 'cat-1' };
      mockBannerRepo.create.mockReturnValue(entity);
      mockBannerRepo.save.mockResolvedValue({ id: 'b1', ...entity });

      const result = await service.create('cat-1', dto as any);

      expect(mockBannerRepo.create).toHaveBeenCalledWith({ ...dto, categoryId: 'cat-1' });
      expect(result.id).toBe('b1');
    });
  });

  describe('findAllByCategory', () => {
    it('filters by category and orders by sortOrder then createdAt', async () => {
      const banners = [{ id: 'b1' }, { id: 'b2' }];
      mockBannerRepo.find.mockResolvedValueOnce(banners);

      const result = await service.findAllByCategory('cat-1');

      expect(result).toBe(banners);
      expect(mockBannerRepo.find).toHaveBeenCalledWith({
        where: { categoryId: 'cat-1' },
        order: { sortOrder: 'ASC', createdAt: 'DESC' },
      });
    });
  });

  describe('findOne', () => {
    it('returns when found', async () => {
      const b = { id: 'b1' };
      mockBannerRepo.findOne.mockResolvedValueOnce(b);
      const result = await service.findOne('b1');
      expect(result).toBe(b);
    });

    it('throws NotFoundException when missing', async () => {
      mockBannerRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne('b1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('merges dto into existing banner', async () => {
      const existing: any = { id: 'b1', title: 'Old', sortOrder: 0 };
      mockBannerRepo.findOne.mockResolvedValueOnce(existing);
      mockBannerRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.update('b1', { title: 'New' } as any);

      expect(result.title).toBe('New');
      expect(result.sortOrder).toBe(0);
    });
  });

  describe('remove', () => {
    it('removes the banner entity', async () => {
      const b = { id: 'b1', categoryId: 'cat-1' };
      mockBannerRepo.findOne.mockResolvedValueOnce(b);
      await service.remove('b1', 'proj-1', REQUESTER);
      expect(mockBannerRepo.delete).toHaveBeenCalledWith({ id: 'b1', categoryId: 'cat-1' });
    });
  });

  describe('reorder', () => {
    it('updates each banner with new sortOrder in a transaction', async () => {
      const items = [
        { id: 'b1', sortOrder: 2 },
        { id: 'b2', sortOrder: 1 },
      ];
      mockBannerRepo.find.mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }]);

      await service.reorder('cat-1', items);

      expect(mockDataSource.transaction).toHaveBeenCalled();
      const manager = (mockDataSource as any).lastManager;
      expect(manager.update).toHaveBeenCalledTimes(2);
      expect(manager.update).toHaveBeenCalledWith(
        InAppBannerEntity,
        { id: 'b1', categoryId: 'cat-1' },
        { sortOrder: 2 },
      );
    });

    it('throws NotFoundException when some ids do not belong to category', async () => {
      const items = [
        { id: 'b1', sortOrder: 1 },
        { id: 'b2', sortOrder: 2 },
      ];
      mockBannerRepo.find.mockResolvedValueOnce([{ id: 'b1' }]); // only one found

      await expect(service.reorder('cat-1', items)).rejects.toThrow(NotFoundException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('serve', () => {
    it('throws when the category is not active', async () => {
      mockCategoryRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.serve('cat-1')).rejects.toThrow(NotFoundException);
    });

    it('returns active banners and records impressions', async () => {
      const category = { id: 'cat-1', status: 'active' };
      const banners = [{ id: 'b1', isActive: true }];
      mockCategoryRepo.findOne.mockResolvedValueOnce(category);
      mockBannerRepo.find.mockResolvedValueOnce(banners);
      mockEventRepo.save.mockResolvedValue([]);

      const result = await service.serve('cat-1', { ipAddress: '8.8.8.8', userAgent: 'Mozilla' });

      expect(result.category).toBe(category);
      expect(result.banners).toBe(banners);
      // Give the fire-and-forget impression record a chance to run
      await new Promise((r) => setImmediate(r));
      expect(mockEventRepo.save).toHaveBeenCalled();
    });

    it('does not record impressions when no banners are returned', async () => {
      const category = { id: 'cat-1', status: 'active' };
      mockCategoryRepo.findOne.mockResolvedValueOnce(category);
      mockBannerRepo.find.mockResolvedValueOnce([]);

      await service.serve('cat-1');

      await new Promise((r) => setImmediate(r));
      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('serveScoped', () => {
    it('throws when the category does not belong to the expected project', async () => {
      mockCategoryRepo.findOne.mockResolvedValueOnce({ id: 'cat-1', projectId: 'other', status: 'active' });

      await expect(service.serveScoped('cat-1', 'my-proj')).rejects.toThrow(NotFoundException);
    });

    it('delegates to serve when project matches', async () => {
      const category = { id: 'cat-1', projectId: 'my-proj', status: 'active' };
      // findOne is called once inside serveScoped and then again inside serve.
      mockCategoryRepo.findOne.mockResolvedValueOnce(category).mockResolvedValueOnce(category);
      mockBannerRepo.find.mockResolvedValueOnce([]);

      const result = await service.serveScoped('cat-1', 'my-proj');

      expect(result.category).toBe(category);
    });
  });

  describe('recordClick', () => {
    it('records a click event and increments the click counter', async () => {
      const banner = { id: 'b1', categoryId: 'cat-1' };
      mockBannerRepo.findOne.mockResolvedValueOnce(banner);
      mockEventRepo.save.mockResolvedValue([]);

      await service.recordClick('b1', { ipAddress: '8.8.8.8', userAgent: 'Mozilla' });

      expect(mockBannerRepo.createQueryBuilder).toHaveBeenCalled();
      expect(lastUpdateQb.update).toHaveBeenCalledWith(InAppBannerEntity);
      expect(lastUpdateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ clicks: expect.any(Function) }),
      );
      expect(lastUpdateQb.where).toHaveBeenCalledWith('id = :id', { id: 'b1' });
      expect(lastUpdateQb.execute).toHaveBeenCalled();
      await new Promise((r) => setImmediate(r));
      expect(mockEventRepo.save).toHaveBeenCalled();
    });

    it('verifies the banner belongs to the expected project', async () => {
      const banner = { id: 'b1', categoryId: 'cat-1' };
      mockBannerRepo.findOne.mockResolvedValueOnce(banner);
      // First call (findOne) succeeds, but the ownership check category lookup fails.
      mockCategoryRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.recordClick('b1', undefined, 'my-proj')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws when the category belongs to a different project', async () => {
      mockBannerRepo.findOne.mockResolvedValueOnce({ id: 'b1', categoryId: 'cat-1' });
      mockCategoryRepo.findOne.mockResolvedValueOnce({
        id: 'cat-1',
        projectId: 'other-proj',
      });

      await expect(service.recordClick('b1', undefined, 'my-proj')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('skips ownership check when no expectedProjectId is provided', async () => {
      mockBannerRepo.findOne.mockResolvedValueOnce({ id: 'b1', categoryId: 'cat-1' });
      mockEventRepo.save.mockResolvedValue([]);

      await service.recordClick('b1');

      expect(mockCategoryRepo.findOne).not.toHaveBeenCalled();
      expect(lastUpdateQb.execute).toHaveBeenCalled();
    });
  });

  describe('serveScoped for a suspended tenant', () => {
    const category = { id: 'cat-1', projectId: 'my-proj', status: 'active' };
    const banner = { id: 'b1', categoryId: 'cat-1' };

    it('answers with the widget and no banners, and records no impression', async () => {
      suspendedProject = 'my-proj';
      mockCategoryRepo.findOne.mockResolvedValueOnce(category);
      mockBannerRepo.find.mockResolvedValueOnce([banner]);

      await expect(service.serveScoped('cat-1', 'my-proj')).resolves.toEqual({
        category,
        banners: [],
      });
      expect(mockEventRepo.save).not.toHaveBeenCalled();
    });

    it('still serves an active tenant\'s banners', async () => {
      suspendedProject = 'other';
      mockCategoryRepo.findOne.mockResolvedValueOnce(category).mockResolvedValueOnce(category);
      mockBannerRepo.find.mockResolvedValueOnce([banner]);

      const result = await service.serveScoped('cat-1', 'my-proj');

      expect(result.banners).toEqual([banner]);
    });
  });
});
