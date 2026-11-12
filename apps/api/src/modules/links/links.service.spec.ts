import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { LinksService } from './links.service';
import { LinkEntity } from './entities/link.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { nanoid } from 'nanoid';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const activity = { record: jest.fn() };

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

jest.mock('nanoid', () => ({
  nanoid: jest.fn(),
}));

describe('LinksService', () => {
  let service: LinksService;

  const mockedNanoid = nanoid as jest.MockedFunction<typeof nanoid>;

  // Query builder mock used by findAllByProject
  const qb = {
    loadRelationCountAndMap: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };

  const linkRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
    remove: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
  };

  const makePagination = (overrides: Partial<PaginationDto> = {}): PaginationDto => {
    const p = new PaginationDto();
    Object.assign(p, { page: 1, limit: 20, ...overrides });
    return p;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.values(qb).forEach((fn: any) => {
      if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
    });
    // Re-chain — resetAllMocks would wipe returnThis bindings
    qb.loadRelationCountAndMap.mockReturnThis();
    qb.where.mockReturnThis();
    qb.orderBy.mockReturnThis();
    qb.skip.mockReturnThis();
    qb.take.mockReturnThis();
    qb.andWhere.mockReturnThis();

    // Deletes and status changes write their activity entry in the same transaction.
    Object.assign(linkRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => linkRepo }) },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectActivityService, useValue: activity },
        LinksService,
        { provide: getRepositoryToken(LinkEntity), useValue: linkRepo },
      ],
    }).compile();

    service = module.get<LinksService>(LinksService);
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    const baseDto = { longUrl: 'https://example.com' };

    it('generates a short code via nanoid when none is provided', async () => {
      mockedNanoid.mockReturnValueOnce('abc1234');
      linkRepo.findOne.mockResolvedValueOnce(null); // uniqueness check

      const created = { ...baseDto, shortCode: 'abc1234', projectId: 'proj-1' };
      linkRepo.create.mockReturnValue(created);
      linkRepo.save.mockResolvedValue({ id: 'l-1', ...created });

      const result = await service.create('proj-1', baseDto as any);

      expect(mockedNanoid).toHaveBeenCalledWith(7);
      expect(linkRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ shortCode: 'abc1234', projectId: 'proj-1' }),
      );
      expect(result.id).toBe('l-1');
    });

    it('retries nanoid when the first generated code collides', async () => {
      mockedNanoid.mockReturnValueOnce('dupeXXX').mockReturnValueOnce('freshAB');
      linkRepo.findOne
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);

      linkRepo.create.mockImplementation((v: any) => v);
      linkRepo.save.mockImplementation(async (v: any) => ({ id: 'l-1', ...v }));

      const result = await service.create('proj-1', baseDto as any);

      expect(mockedNanoid).toHaveBeenCalledTimes(2);
      expect(result.shortCode).toBe('freshAB');
    });

    it('throws InternalServerErrorException after 5 failed nanoid attempts', async () => {
      mockedNanoid.mockReturnValue('collide');
      linkRepo.findOne.mockResolvedValue({ id: 'existing' });

      await expect(service.create('proj-1', baseDto as any)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(linkRepo.findOne).toHaveBeenCalledTimes(5);
    });

    it('uses a custom shortCode when provided and available', async () => {
      linkRepo.findOne.mockResolvedValueOnce(null); // custom claim check
      linkRepo.create.mockImplementation((v: any) => v);
      linkRepo.save.mockImplementation(async (v: any) => ({ id: 'l-1', ...v }));

      const result = await service.create('proj-1', {
        ...baseDto,
        shortCode: 'promo-2026',
      } as any);

      expect(mockedNanoid).not.toHaveBeenCalled();
      expect(result.shortCode).toBe('promo-2026');
      // Ensure the raw DTO shortCode is not spread into linkRepo.create twice
      expect(linkRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ shortCode: 'promo-2026', longUrl: 'https://example.com' }),
      );
    });

    it('rejects a reserved custom shortCode with ConflictException', async () => {

      await expect(
        service.create('proj-1', { ...baseDto, shortCode: 'admin' } as any),
      ).rejects.toThrow(ConflictException);
      expect(linkRepo.findOne).not.toHaveBeenCalled();
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    // Each of these is a page in apps/web, which a link with that code would shadow.
    it.each(['verify-email', 'forgot-password', 'reset-password', 'Reset-Password'])(
      'rejects the account page path %s as a shortCode',
      async (shortCode) => {
  
        await expect(
          service.create('proj-1', { ...baseDto, shortCode } as any),
        ).rejects.toThrow(ConflictException);
      },
    );

    // /redirect/health reaches GET /api/health, the deploy scripts' health check.
    it('rejects health as a shortCode', async () => {
      await expect(service.create('proj-1', { ...baseDto, shortCode: 'health' } as any)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects a reserved custom shortCode case-insensitively', async () => {

      await expect(
        service.create('proj-1', { ...baseDto, shortCode: 'ADMIN' } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a duplicate custom shortCode with ConflictException', async () => {
      linkRepo.findOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(
        service.create('proj-1', { ...baseDto, shortCode: 'taken' } as any),
      ).rejects.toThrow(/already taken/);
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it('translates Postgres unique-violation race to ConflictException for custom codes', async () => {
      linkRepo.findOne.mockResolvedValueOnce(null); // passes pre-check

      linkRepo.create.mockImplementation((v: any) => v);
      const qfe = new QueryFailedError('INSERT', [], new Error('dup'));
      (qfe as any).code = '23505';
      linkRepo.save.mockRejectedValueOnce(qfe);

      await expect(
        service.create('proj-1', { ...baseDto, shortCode: 'racey' } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows non-unique-violation errors from save', async () => {
      mockedNanoid.mockReturnValueOnce('xyz1234');
      linkRepo.findOne.mockResolvedValueOnce(null);
      linkRepo.create.mockImplementation((v: any) => v);
      linkRepo.save.mockRejectedValueOnce(new Error('boom'));

      await expect(service.create('proj-1', baseDto as any)).rejects.toThrow(
        'boom',
      );
    });

    it('does NOT translate unique-violation to 409 when using nanoid path', async () => {
      // Only the custom-code path re-throws 23505 as ConflictException.
      mockedNanoid.mockReturnValueOnce('xyz1234');
      linkRepo.findOne.mockResolvedValueOnce(null);
      linkRepo.create.mockImplementation((v: any) => v);

      const qfe = new QueryFailedError('INSERT', [], new Error('dup'));
      (qfe as any).code = '23505';
      linkRepo.save.mockRejectedValueOnce(qfe);

      await expect(service.create('proj-1', baseDto as any)).rejects.toThrow(
        QueryFailedError,
      );
    });

  });

  // ---------------------------------------------------------------------------
  // findAllByProject
  // ---------------------------------------------------------------------------
  describe('findAllByProject', () => {
    beforeEach(() => {
    });

    it('returns paginated links with meta', async () => {
      qb.getManyAndCount.mockResolvedValue([[{ id: 'l-1' }], 1]);

      const result = await service.findAllByProject(
        'proj-1',
        makePagination({ page: 1, limit: 20 }),
      );

      expect(qb.where).toHaveBeenCalledWith('link.projectId = :projectId', {
        projectId: 'proj-1',
      });
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(result.data).toEqual([{ id: 'l-1' }]);
      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });

    it('applies title ILIKE filter when search is given', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAllByProject('proj-1', makePagination(), 'promo');

      expect(qb.andWhere).toHaveBeenCalledWith('link.title ILIKE :search', {
        search: '%promo%',
      });
    });

    it('applies one andWhere per tag when tags are given', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAllByProject(
        'proj-1',
        makePagination(),
        undefined,
        'spring,sale,beta',
      );

      expect(qb.andWhere).toHaveBeenCalledTimes(3);
      expect(qb.andWhere).toHaveBeenNthCalledWith(1, 'link.tags LIKE :tag0', {
        tag0: '%spring%',
      });
      expect(qb.andWhere).toHaveBeenNthCalledWith(2, 'link.tags LIKE :tag1', {
        tag1: '%sale%',
      });
      expect(qb.andWhere).toHaveBeenNthCalledWith(3, 'link.tags LIKE :tag2', {
        tag2: '%beta%',
      });
    });

    it('trims whitespace from tag list', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAllByProject(
        'proj-1',
        makePagination(),
        undefined,
        '  a  ,  b  ',
      );

      expect(qb.andWhere).toHaveBeenCalledWith('link.tags LIKE :tag0', { tag0: '%a%' });
      expect(qb.andWhere).toHaveBeenCalledWith('link.tags LIKE :tag1', { tag1: '%b%' });
    });

    it('computes totalPages for multi-page results', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 95]);

      const result = await service.findAllByProject(
        'proj-1',
        makePagination({ page: 3, limit: 20 }),
      );

      expect(result.meta.totalPages).toBe(5);
      expect(qb.skip).toHaveBeenCalledWith(40);
    });

  });

  // ---------------------------------------------------------------------------
  // findOne / findByShortCode
  // ---------------------------------------------------------------------------
  describe('findOne', () => {
    it('returns link with project relation when found', async () => {
      const link = { id: 'l-1', project: { ownerId: 'u1' } };
      linkRepo.findOne.mockResolvedValue(link);

      const result = await service.findOne('l-1');

      expect(linkRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        relations: ['project'],
      });
      expect(result).toBe(link);
    });

    it('throws NotFoundException when link not found', async () => {
      linkRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByShortCode', () => {
    it('returns link with project relation when found', async () => {
      const link = { id: 'l-1', shortCode: 'abc', project: { ownerId: 'u1' } };
      linkRepo.findOne.mockResolvedValue(link);

      const result = await service.findByShortCode('abc');

      expect(linkRepo.findOne).toHaveBeenCalledWith({
        where: { shortCode: 'abc' },
        relations: ['project'],
      });
      expect(result).toBe(link);
    });

    it('throws NotFoundException when short code not found', async () => {
      linkRepo.findOne.mockResolvedValue(null);

      await expect(service.findByShortCode('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------
  describe('update', () => {
    it('updates and saves a link', async () => {
      const link = {
        id: 'l-1',
        title: 'Old',
        project: { ownerId: 'u1' },
      };
      linkRepo.findOne.mockResolvedValue(link);
      linkRepo.save.mockImplementation(async (v: any) => v);

      const result = await service.update('l-1', { title: 'New' } as any, 'proj-1', REQUESTER);

      expect(result.title).toBe('New');
      expect(linkRepo.save).toHaveBeenCalledWith(expect.objectContaining({ title: 'New' }));
    });

    it('throws NotFoundException when link is missing', async () => {
      linkRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update('l-1', { title: 'X' } as any, 'proj-1', REQUESTER),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------
  describe('remove', () => {
    it('removes a link', async () => {
      const link = { id: 'l-1', project: { ownerId: 'u1' } };
      linkRepo.findOne.mockResolvedValue(link);

      await service.remove('l-1', 'proj-1', REQUESTER);

      expect(linkRepo.delete).toHaveBeenCalledWith({ id: 'l-1', projectId: 'proj-1' });
    });

    it('throws NotFoundException when a racing delete removed it first', async () => {
      linkRepo.findOne.mockResolvedValue({ id: 'l-1', project: { ownerId: 'u1' } });
      linkRepo.delete.mockResolvedValueOnce({ affected: 0 });

      await expect(service.remove('l-1', 'proj-1', REQUESTER)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when link is missing', async () => {
      linkRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('l-1', 'proj-1', REQUESTER)).rejects.toThrow(NotFoundException);
    });
  });
});
