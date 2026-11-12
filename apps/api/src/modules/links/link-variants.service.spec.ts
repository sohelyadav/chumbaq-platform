import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { LinkVariantsService } from './link-variants.service';
import { LinkVariantEntity } from './entities/link-variant.entity';
import { LinkEntity } from './entities/link.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

describe('LinkVariantsService', () => {
  let service: LinkVariantsService;

  const repo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    // Each write and its `link.changed` entry share a transaction; the link is read
    // from the same manager to label the entry.
    manager: {
      transaction: async (work: (m: unknown) => unknown) =>
        work({
          getRepository: (entity: unknown) =>
            entity === LinkEntity ? { findOne: async () => ({ id: 'l-1', title: 'Promo', shortCode: 'promo' }) } : repo,
        }),
    },
  };
  const activity = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LinkVariantsService,
        { provide: getRepositoryToken(LinkVariantEntity), useValue: repo },
        { provide: ProjectActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<LinkVariantsService>(LinkVariantsService);
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    it('creates a variant with the provided values and defaults weight to 50', async () => {
      const dto = { name: 'A', longUrl: 'https://a.example' };
      const built = {
        linkId: 'l-1',
        name: 'A',
        longUrl: 'https://a.example',
        iosUrl: null,
        androidUrl: null,
        weight: 50,
      };
      repo.create.mockReturnValue(built);
      repo.save.mockImplementation(async (v: any) => ({ id: 'v-1', ...v }));

      const result = await service.create('l-1', dto as any, 'proj-1', REQUESTER);

      expect(repo.create).toHaveBeenCalledWith({
        linkId: 'l-1',
        name: 'A',
        longUrl: 'https://a.example',
        iosUrl: null,
        androidUrl: null,
        weight: 50,
      });
      expect(result).toEqual({ id: 'v-1', ...built });
    });

    it('uses the provided weight and platform URLs', async () => {
      const dto = {
        name: 'B',
        longUrl: 'https://b.example',
        iosUrl: 'ios://deep',
        androidUrl: 'android://deep',
        weight: 75,
      };
      repo.create.mockImplementation((v: any) => v);
      repo.save.mockImplementation(async (v: any) => ({ id: 'v-2', ...v }));

      const result = await service.create('l-1', dto as any, 'proj-1', REQUESTER);

      expect(result.weight).toBe(75);
      expect(result.iosUrl).toBe('ios://deep');
      expect(result.androidUrl).toBe('android://deep');
    });

    it('passes weight=0 through untouched (does not apply default)', async () => {
      const dto = { name: 'Z', longUrl: 'https://z.example', weight: 0 };
      repo.create.mockImplementation((v: any) => v);
      repo.save.mockImplementation(async (v: any) => v);

      const result = await service.create('l-1', dto as any, 'proj-1', REQUESTER);

      expect(result.weight).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // findAllByLink
  // ---------------------------------------------------------------------------
  describe('findAllByLink', () => {
    it('queries by linkId and orders by createdAt ASC', async () => {
      const variants = [{ id: 'v-1' }, { id: 'v-2' }];
      repo.find.mockResolvedValue(variants);

      const result = await service.findAllByLink('l-1');

      expect(repo.find).toHaveBeenCalledWith({
        where: { linkId: 'l-1' },
        order: { createdAt: 'ASC' },
      });
      expect(result).toEqual(variants);
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------
  describe('update', () => {
    it('updates an existing variant', async () => {
      const existing = { id: 'v-1', linkId: 'l-1', name: 'Old', weight: 20 };
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockImplementation(async (v: any) => v);

      const result = await service.update('v-1', 'l-1', { name: 'New' } as any, 'proj-1', REQUESTER);

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'v-1', linkId: 'l-1' },
      });
      expect(result.name).toBe('New');
    });

    it('assigns only the variant\'s own fields, even from a body that bypassed the DTO', async () => {
      const existing = { id: 'v-1', linkId: 'l-1', name: 'Old', weight: 20, clicks: 5 };
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockImplementation(async (v: any) => v);

      const result = await service.update(
        'v-1',
        'l-1',
        { name: 'New', linkId: 'someone-elses', clicks: 999, id: 'v-2' } as any,
        'proj-1',
        REQUESTER,
      );

      expect(result).toEqual({ id: 'v-1', linkId: 'l-1', name: 'New', weight: 20, clicks: 5 });
    });

    it('throws NotFoundException when variant not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.update('v-1', 'l-1', { name: 'X' }, 'proj-1', REQUESTER),
      ).rejects.toThrow(NotFoundException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------
  describe('remove', () => {
    it('removes an existing variant', async () => {
      const existing = { id: 'v-1', linkId: 'l-1' };
      repo.findOne.mockResolvedValue(existing);

      await service.remove('v-1', 'l-1', 'proj-1', REQUESTER);

      expect(repo.remove).toHaveBeenCalledWith(existing);
    });

    it('throws NotFoundException when variant not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.remove('v-1', 'l-1', 'proj-1', REQUESTER)).rejects.toThrow(NotFoundException);
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // selectVariant
  // ---------------------------------------------------------------------------
  describe('selectVariant', () => {
    it('returns null when no variants exist', async () => {
      repo.find.mockResolvedValue([]);

      const result = await service.selectVariant('l-1');

      expect(result).toBeNull();
    });

    it('returns the first variant when all weights are zero', async () => {
      const variants = [
        { id: 'v-1', weight: 0, clicks: 0 },
        { id: 'v-2', weight: 0, clicks: 0 },
      ];
      repo.find.mockResolvedValue(variants);

      const result = await service.selectVariant('l-1');

      expect(result).toBe(variants[0]);
      // save is NOT called for the zero-weight branch
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('selects the first variant when random falls in its range', async () => {
      const variants = [
        { id: 'v-1', weight: 70, clicks: 0 },
        { id: 'v-2', weight: 30, clicks: 0 },
      ];
      repo.find.mockResolvedValue(variants);
      repo.save.mockImplementation(async (v: any) => v);
      // Math.random() * 100 = 10 — 10 - 70 <= 0 → picks v-1
      jest.spyOn(Math, 'random').mockReturnValueOnce(0.1);

      const result = await service.selectVariant('l-1');

      expect(result?.id).toBe('v-1');
      expect(result?.clicks).toBe(1);
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-1', clicks: 1 }));
    });

    it('selects the second variant when random skips past the first', async () => {
      const variants = [
        { id: 'v-1', weight: 30, clicks: 0 },
        { id: 'v-2', weight: 70, clicks: 0 },
      ];
      repo.find.mockResolvedValue(variants);
      repo.save.mockImplementation(async (v: any) => v);
      // Math.random() * 100 = 80 — 80 - 30 = 50, 50 - 70 = -20 → picks v-2
      jest.spyOn(Math, 'random').mockReturnValueOnce(0.8);

      const result = await service.selectVariant('l-1');

      expect(result?.id).toBe('v-2');
      expect(result?.clicks).toBe(1);
    });

    it('increments clicks on the selected variant', async () => {
      const variants = [{ id: 'v-1', weight: 100, clicks: 5 }];
      repo.find.mockResolvedValue(variants);
      repo.save.mockImplementation(async (v: any) => v);
      jest.spyOn(Math, 'random').mockReturnValueOnce(0.0);

      const result = await service.selectVariant('l-1');

      expect(result?.clicks).toBe(6);
    });
  });
});
