import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { BannerCategoriesService } from './banner-categories.service';
import { BannerCategoryEntity } from './entities/banner-category.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

describe('BannerCategoriesService', () => {
  let service: BannerCategoriesService;

  const qb: any = {
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn(),
  };

  const mockCategoryRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
    createQueryBuilder: jest.fn(() => qb),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Deletes and status changes write their activity entry in the same transaction.
    Object.assign(mockCategoryRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => mockCategoryRepo }) },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        BannerCategoriesService,
        { provide: getRepositoryToken(BannerCategoryEntity), useValue: mockCategoryRepo },
      ],
    }).compile();

    service = module.get<BannerCategoriesService>(BannerCategoriesService);
  });

  describe('create', () => {
    it('creates and saves a category scoped to projectId', async () => {
      const dto = { name: 'Home Banners', layout: 'carousel' };
      const entity = { ...dto, projectId: 'proj-1' };
      mockCategoryRepo.create.mockReturnValue(entity);
      mockCategoryRepo.save.mockResolvedValue({ id: 'cat-1', ...entity });

      const result = await service.create('proj-1', dto as any);

      expect(mockCategoryRepo.create).toHaveBeenCalledWith({ ...dto, projectId: 'proj-1' });
      expect(mockCategoryRepo.save).toHaveBeenCalledWith(entity);
      expect(result).toEqual({ id: 'cat-1', ...entity });
    });
  });

  describe('findAllByProject', () => {
    it('returns entities with parsed aggregate counts', async () => {
      qb.getRawAndEntities.mockResolvedValueOnce({
        entities: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }],
        raw: [
          { bannerCount: '3', totalImpressions: '100', totalClicks: '10' },
          { bannerCount: '0', totalImpressions: '0', totalClicks: '0' },
        ],
      });

      const result = await service.findAllByProject('proj-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'c1', bannerCount: 3, totalImpressions: 100, totalClicks: 10 });
      expect(result[1]).toMatchObject({ id: 'c2', bannerCount: 0, totalImpressions: 0, totalClicks: 0 });
    });

    it('defaults missing aggregate values to 0', async () => {
      qb.getRawAndEntities.mockResolvedValueOnce({
        entities: [{ id: 'c1', name: 'A' }],
        raw: [{}],
      });

      const result = await service.findAllByProject('proj-1');

      expect(result[0].bannerCount).toBe(0);
      expect(result[0].totalImpressions).toBe(0);
      expect(result[0].totalClicks).toBe(0);
    });

    it('filters by layout when provided', async () => {
      qb.getRawAndEntities.mockResolvedValueOnce({ entities: [], raw: [] });

      await service.findAllByProject('proj-1', 'carousel');

      expect(qb.andWhere).toHaveBeenCalledWith('category.layout = :layout', { layout: 'carousel' });
    });

    it('does not call andWhere when no layout is provided', async () => {
      qb.getRawAndEntities.mockResolvedValueOnce({ entities: [], raw: [] });

      await service.findAllByProject('proj-1');

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns a category when found', async () => {
      const cat = { id: 'cat-1', name: 'A' };
      mockCategoryRepo.findOne.mockResolvedValueOnce(cat);

      const result = await service.findOne('cat-1');

      expect(result).toBe(cat);
      expect(mockCategoryRepo.findOne).toHaveBeenCalledWith({ where: { id: 'cat-1' } });
    });

    it('throws NotFoundException when missing', async () => {
      mockCategoryRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findOne('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findOneWithBanners', () => {
    it('loads banners relation with sort order', async () => {
      const cat = { id: 'cat-1', banners: [] };
      mockCategoryRepo.findOne.mockResolvedValueOnce(cat);

      const result = await service.findOneWithBanners('cat-1');

      expect(result).toBe(cat);
      expect(mockCategoryRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'cat-1' },
        relations: ['banners'],
        order: { banners: { sortOrder: 'ASC' } },
      });
    });

    it('throws NotFoundException when missing', async () => {
      mockCategoryRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findOneWithBanners('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('merges dto into existing entity and saves', async () => {
      const existing: any = { id: 'cat-1', name: 'Old', layout: 'carousel' };
      mockCategoryRepo.findOne.mockResolvedValueOnce(existing);
      mockCategoryRepo.save.mockImplementation(async (v) => v);

      const result = await service.update('cat-1', { name: 'New' } as any);

      expect(result.name).toBe('New');
      expect(result.layout).toBe('carousel');
      expect(mockCategoryRepo.save).toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('updates only the status field', async () => {
      const existing: any = { id: 'cat-1', status: 'draft' };
      mockCategoryRepo.findOne.mockResolvedValueOnce(existing);
      mockCategoryRepo.save.mockImplementation(async (v) => v);

      const result = await service.updateStatus('cat-1', 'active');

      expect(result.status).toBe('active');
    });
  });

  describe('remove', () => {
    it('removes the category entity', async () => {
      const cat = { id: 'cat-1' };
      mockCategoryRepo.findOne.mockResolvedValueOnce(cat);

      await service.remove('cat-1', 'proj-1', REQUESTER);

      expect(mockCategoryRepo.delete).toHaveBeenCalledWith({ id: 'cat-1', projectId: 'proj-1' });
    });

    it('throws NotFoundException when category does not exist', async () => {
      mockCategoryRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.remove('nope', 'proj-1', REQUESTER)).rejects.toThrow(NotFoundException);
      expect(mockCategoryRepo.delete).not.toHaveBeenCalled();
    });
  });
});
