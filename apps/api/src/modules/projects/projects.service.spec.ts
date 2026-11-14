import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectsService } from './projects.service';
import { SeatsService } from '../project-access/seats.service';
import { AccountLimitsService } from '../billing/account-limits.service';
import { ProjectEntity } from './entities/project.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ProjectAccessService } from '../project-access/project-access.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const CTX = { ipAddress: '203.0.113.1', userAgent: 'jest' };

describe('ProjectsService', () => {
  let service: ProjectsService;

  const qb = {
    where: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn(),
  };
  const repo = {
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
    // The account's limit and the caller's member rows for the list; `create` is
    // proved against Postgres in project-limit.int-spec.ts, since its lock is the point.
    manager: { findOne: jest.fn(), find: jest.fn(), transaction: jest.fn() },
  };
  /** The transaction's manager: the locked row is `tx.findOne`'s answer. */
  const tx = { findOne: jest.fn(), update: jest.fn(), remove: jest.fn() };
  const activity = { record: jest.fn() };
  // The visibility SQL itself is proved against Postgres in project-access.int-spec.ts.
  const projectAccess = {
    memberProjectsQuery: jest.fn(() => ({ sql: 'SELECT visible', params: { projectAccess_userId: 'user-1' } })),
  };

  const makePagination = (overrides: Partial<PaginationDto> = {}): PaginationDto => {
    const p = new PaginationDto();
    Object.assign(p, { page: 1, limit: 20, ...overrides });
    return p;
  };

  const seats = { count: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    seats.count.mockResolvedValue(3);
    for (const step of ['where', 'orderBy', 'addOrderBy', 'skip', 'take'] as const) qb[step].mockReturnValue(qb);
    repo.manager.find.mockResolvedValue([]);
    repo.count.mockResolvedValue(0);
    repo.manager.transaction.mockImplementation((cb: (m: typeof tx) => unknown) => cb(tx));
    activity.record.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: getRepositoryToken(ProjectEntity), useValue: repo },
        // Billing off: the install's defaults and the staff override, read from the users row.
        {
          provide: AccountLimitsService,
          useValue: new AccountLimitsService(new ConfigService({ projects: { maxPerAccount: 10, maxSeatsPerAccount: 5 } })),
        },
        { provide: ProjectAccessService, useValue: projectAccess },
        { provide: SeatsService, useValue: seats },
        { provide: ProjectActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  describe('findAllByUser', () => {
    const caller = { userId: 'user-1', email: 'u@example.com', isSuperAdmin: false };

    it('lists the projects the caller may see, each with their role, billing and permissions', async () => {
      const projects = [
        { id: 'p-1', ownerId: 'user-1' },
        { id: 'p-2', ownerId: 'someone-else' },
      ];
      qb.getManyAndCount.mockResolvedValue([projects, 2]);
      repo.manager.find.mockResolvedValue([
        { projectId: 'p-1', role: 'owner' },
        { projectId: 'p-2', role: 'member' },
      ]);
      repo.count.mockResolvedValue(1);

      const result = await service.findAllByUser(caller, makePagination({ page: 1, limit: 20 }));

      expect(projectAccess.memberProjectsQuery).toHaveBeenCalledWith(caller);
      expect(qb.where).toHaveBeenCalledWith('p.id IN (SELECT visible)', { projectAccess_userId: 'user-1' });
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      expect(repo.count).toHaveBeenCalledWith({ where: { ownerId: 'user-1' } });
      expect(result.data).toEqual([
        {
          id: 'p-1',
          ownerId: 'user-1',
          role: 'owner',
          isBillingOwner: true,
          permissions: [
            'project.read',
            'messaging.write',
            'people.read',
            'channels.manage',
            'keys.manage',
            'members.manage',
            'activity.view',
            'privacy',
            'project.admin',
          ],
        },
        {
          id: 'p-2',
          ownerId: 'someone-else',
          role: 'member',
          isBillingOwner: false,
          permissions: ['project.read', 'messaging.write', 'people.read'],
        },
      ]);
      expect(result.meta).toEqual({
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
        projectLimit: 10,
        billedProjects: 1,
        seats: { used: 3, limit: 5 },
      });
    });

    it('asks for the view-as subquery when staff view as the caller', async () => {
      const viewAs = { ...caller, impersonatedBy: 'staff-1' };
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAllByUser(viewAs, makePagination());

      expect(projectAccess.memberProjectsQuery).toHaveBeenCalledWith(viewAs);
    });

    it('leaves out a project whose membership went between the two reads', async () => {
      qb.getManyAndCount.mockResolvedValue([[{ id: 'p-1', ownerId: 'x' }, { id: 'p-2', ownerId: 'x' }], 2]);
      repo.manager.find.mockResolvedValue([{ projectId: 'p-2', role: 'admin' }]);

      const result = await service.findAllByUser(caller, makePagination());

      expect(result.data.map((p) => [p.id, p.role])).toEqual([['p-2', 'admin']]);
    });

    it("gives the account's own limit when staff set one", async () => {
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      repo.manager.findOne.mockResolvedValue({ id: 'user-1', projectLimit: 3 });

      const result = await service.findAllByUser(caller, makePagination());

      expect(result.meta.projectLimit).toBe(3);
      expect(repo.manager.find).not.toHaveBeenCalled();
    });

    it('computes totalPages correctly when total is not a multiple of limit', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 25]);

      const result = await service.findAllByUser(caller, makePagination({ page: 2, limit: 10 }));

      expect(result.meta.totalPages).toBe(3);
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('returns empty array and zero totalPages when no projects exist', async () => {
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      const result = await service.findAllByUser(caller, makePagination());

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });
  });

  // The route's permission guard has already resolved the project and checked the role.
  describe('update', () => {
    it('writes only the settings the request carries that differ, never save() of the guard\'s row', async () => {
      const stale = { id: 'p-1', ownerId: 'user-1', name: 'Old', pendingBillingOwnerId: 'user-2' };
      const locked = { id: 'p-1', ownerId: 'user-2', name: 'Old', domain: 'same.example', pendingBillingOwnerId: null };
      const fresh = { ...locked, name: 'New' };
      tx.findOne.mockResolvedValue(locked);
      repo.findOne.mockResolvedValue(fresh);

      const dto = { name: 'New', domain: 'same.example', ownerId: 'evil', pendingBillingOwnerId: 'evil' };
      const result = await service.update('user-1', stale as any, dto as any, CTX);

      expect(tx.findOne).toHaveBeenCalledWith(expect.anything(), {
        where: { id: 'p-1' },
        lock: { mode: 'for_no_key_update' },
      });
      expect(tx.update).toHaveBeenCalledWith(expect.anything(), { id: 'p-1' }, { name: 'New' });
      expect(repo.save).not.toHaveBeenCalled();
      expect(activity.record).toHaveBeenCalledTimes(1);
      expect(activity.record).toHaveBeenCalledWith(
        {
          projectId: 'p-1',
          actor: { kind: 'user', userId: 'user-1' },
          action: 'project.renamed',
          target: { type: 'project', id: 'p-1', label: 'New' },
          details: { from: 'Old', to: 'New' },
        },
        CTX,
        tx,
      );
      expect(result).toBe(fresh);
    });

    it('writes and logs nothing for an empty body or unchanged values, and returns the current row', async () => {
      const fresh = { id: 'p-1', name: 'Same', domain: 'd.example' };
      tx.findOne.mockResolvedValue(fresh);
      repo.findOne.mockResolvedValue(fresh);

      expect(await service.update('user-1', { id: 'p-1' } as any, {} as any, CTX)).toBe(fresh);
      expect(await service.update('user-1', { id: 'p-1' } as any, { name: 'Same', domain: 'd.example' } as any, CTX)).toBe(
        fresh,
      );

      expect(tx.update).not.toHaveBeenCalled();
      expect(activity.record).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('logs project.deleted and removes the locked row in one transaction', async () => {
      const locked = { id: 'p-1', ownerId: 'user-1', name: 'Doomed' };
      tx.findOne.mockResolvedValue(locked);

      await service.remove('user-1', { id: 'p-1' } as any, CTX);

      expect(activity.record).toHaveBeenCalledWith(
        {
          projectId: 'p-1',
          actor: { kind: 'user', userId: 'user-1' },
          action: 'project.deleted',
          target: { type: 'project', id: 'p-1', label: 'Doomed' },
        },
        CTX,
        tx,
      );
      expect(tx.remove).toHaveBeenCalledWith(locked);
    });

    it('deletes nothing when the entry cannot be written', async () => {
      tx.findOne.mockResolvedValue({ id: 'p-1', name: 'Kept' });
      activity.record.mockRejectedValue(new Error('log down'));

      await expect(service.remove('user-1', { id: 'p-1' } as any, CTX)).rejects.toThrow('log down');
      expect(tx.remove).not.toHaveBeenCalled();
    });
  });
});
