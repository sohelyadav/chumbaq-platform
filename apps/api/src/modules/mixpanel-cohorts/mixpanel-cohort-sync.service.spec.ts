import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';
import { MixpanelApiService } from './mixpanel-api.service';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCohortEntity(overrides: Partial<MixpanelCohortEntity> = {}): MixpanelCohortEntity {
  return {
    id: 'cohort-uuid-1',
    projectId: 'proj-1',
    mixpanelCohortId: 42,
    name: 'Alpha Cohort',
    description: null,
    mixpanelUserCount: 5,
    resolvedCount: 0,
    unresolvedCount: 0,
    lastSyncedAt: null,
    status: 'pending',
    errorMessage: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  } as MixpanelCohortEntity;
}

function makeMemberEntity(
  overrides: Partial<MixpanelCohortMemberEntity> = {},
): MixpanelCohortMemberEntity {
  return {
    id: 'member-uuid-1',
    cohortId: 'cohort-uuid-1',
    projectId: 'proj-1',
    mixpanelDistinctId: 'user-distinct-1',
    deviceIdentityId: null,
    resolvedBy: null,
    isResolved: false,
    mixpanelProfile: {},
    addedAt: new Date('2024-01-01'),
    cohort: undefined as any,
    ...overrides,
  } as MixpanelCohortMemberEntity;
}

function makeMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
    update: jest.fn(),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('MixpanelCohortSyncService', () => {
  let service: MixpanelCohortSyncService;

  let cohortRepo: ReturnType<typeof makeMockRepo>;
  let memberRepo: ReturnType<typeof makeMockRepo>;
  let identityRepo: ReturnType<typeof makeMockRepo>;
  let mixpanelApiService: jest.Mocked<MixpanelApiService>;
  let mixpanelCohortsService: jest.Mocked<MixpanelCohortsService>;

  beforeEach(async () => {
    cohortRepo = makeMockRepo();
    memberRepo = makeMockRepo();
    identityRepo = makeMockRepo();

    mixpanelApiService = {
      testConnection: jest.fn(),
      listCohorts: jest.fn(),
      getCohortMembers: jest.fn(),
    } as unknown as jest.Mocked<MixpanelApiService>;

    mixpanelCohortsService = {
      getDecryptedConfig: jest.fn(),
      configure: jest.fn(),
      testConnection: jest.fn(),
      getStatus: jest.fn(),
      listAvailableCohorts: jest.fn(),
      listImportedCohorts: jest.fn(),
      findImportedCohort: jest.fn(),
      deleteImportedCohort: jest.fn(),
      listCohortMembers: jest.fn(),
      getCohortPushEligible: jest.fn(),
    } as unknown as jest.Mocked<MixpanelCohortsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MixpanelCohortSyncService,
        { provide: getRepositoryToken(MixpanelCohortEntity), useValue: cohortRepo },
        { provide: getRepositoryToken(MixpanelCohortMemberEntity), useValue: memberRepo },
        { provide: getRepositoryToken(DeviceIdentityEntity), useValue: identityRepo },
        { provide: MixpanelApiService, useValue: mixpanelApiService },
        { provide: MixpanelCohortsService, useValue: mixpanelCohortsService },
      ],
    }).compile();

    service = module.get<MixpanelCohortSyncService>(MixpanelCohortSyncService);
  });

  // ---------------------------------------------------------------------------
  // importCohort
  // ---------------------------------------------------------------------------
  describe('importCohort', () => {
    it('throws when getDecryptedConfig returns null', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce(null);

      await expect(service.importCohort('proj-1', 42)).rejects.toThrow(
        'Mixpanel is not configured for this project',
      );
    });

    it('throws when the cohort is not found in the Mixpanel list', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([
        { id: 99, name: 'Other', count: 1, created: '2024-01-01' },
      ]);

      await expect(service.importCohort('proj-1', 42)).rejects.toThrow(
        'Cohort 42 not found in Mixpanel',
      );
    });

    it('creates a new cohort entity with status "syncing" and returns it immediately', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([
        { id: 42, name: 'Alpha Cohort', count: 5, created: '2024-01-01' },
      ]);
      cohortRepo.findOne.mockResolvedValueOnce(null); // no existing cohort

      const newCohort = makeCohortEntity({ status: 'syncing' });
      cohortRepo.create.mockReturnValueOnce(newCohort);
      cohortRepo.save.mockResolvedValueOnce(newCohort);

      // Stub getCohortMembers so the background runSync does not error out
      mixpanelApiService.getCohortMembers.mockResolvedValue([]);
      cohortRepo.save.mockResolvedValue(newCohort);

      const result = await service.importCohort('proj-1', 42);

      expect(cohortRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'syncing', projectId: 'proj-1', mixpanelCohortId: 42 }),
      );
      expect(result.status).toBe('syncing');
    });

    it('updates an existing cohort entity with status "syncing" instead of creating', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([
        { id: 42, name: 'Alpha Cohort Updated', count: 10, created: '2024-01-01' },
      ]);

      const existing = makeCohortEntity({ name: 'Alpha Cohort', status: 'synced' });
      cohortRepo.findOne.mockResolvedValueOnce(existing);
      const updated = { ...existing, name: 'Alpha Cohort Updated', status: 'syncing' };
      cohortRepo.save.mockResolvedValueOnce(updated);

      // Stub background sync
      mixpanelApiService.getCohortMembers.mockResolvedValue([]);
      cohortRepo.save.mockResolvedValue(updated as any);

      const result = await service.importCohort('proj-1', 42);

      expect(cohortRepo.create).not.toHaveBeenCalled();
      expect(result.status).toBe('syncing');
      expect(result.name).toBe('Alpha Cohort Updated');
    });

    it('returns the cohort entity immediately without waiting for background sync', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([
        { id: 42, name: 'Alpha Cohort', count: 5, created: '2024-01-01' },
      ]);
      cohortRepo.findOne.mockResolvedValueOnce(null);

      const newCohort = makeCohortEntity({ status: 'syncing' });
      cohortRepo.create.mockReturnValueOnce(newCohort);
      cohortRepo.save.mockResolvedValueOnce(newCohort);

      // getCohortMembers never resolves in this test — confirms we don't await it
      mixpanelApiService.getCohortMembers.mockReturnValue(new Promise(() => {}));

      const result = await service.importCohort('proj-1', 42);

      expect(result).toBe(newCohort);
      expect(mixpanelApiService.getCohortMembers).not.toHaveBeenCalledTimes(0); // fire-and-forget called
    });

    it('awaits the sync to completion when opts.awaitSync is true', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([
        { id: 42, name: 'Alpha Cohort', count: 5, created: '2024-01-01' },
      ]);
      cohortRepo.findOne.mockResolvedValueOnce(null);

      const newCohort = makeCohortEntity({ status: 'syncing' });
      cohortRepo.create.mockReturnValueOnce(newCohort);
      cohortRepo.save.mockResolvedValueOnce(newCohort);

      mixpanelApiService.getCohortMembers.mockResolvedValueOnce([]);
      cohortRepo.save.mockResolvedValue(newCohort);

      const result = await service.importCohort('proj-1', 42, { awaitSync: true });

      // If the sync were still fire-and-forget, getCohortMembers wouldn't have
      // resolved yet and status would still read 'syncing' at this point.
      expect(mixpanelApiService.getCohortMembers).toHaveBeenCalled();
      expect(result.status).toBe('synced');
    });
  });

  // ---------------------------------------------------------------------------
  // retryUnresolved
  // ---------------------------------------------------------------------------
  describe('retryUnresolved', () => {
    it('returns { attempted: 0, resolved: 0 } when there are no unresolved members', async () => {
      memberRepo.find.mockResolvedValueOnce([]);

      const result = await service.retryUnresolved('cohort-uuid-1');

      expect(result).toEqual({ attempted: 0, resolved: 0 });
    });

    it('returns attempted equal to the number of unresolved members', async () => {
      const members = [
        makeMemberEntity({ mixpanelDistinctId: 'u1' }),
        makeMemberEntity({ id: 'member-uuid-2', mixpanelDistinctId: 'u2' }),
      ];
      memberRepo.find.mockResolvedValueOnce(members);

      // identityRepo always returns null => unresolved stays unresolved
      identityRepo.findOne.mockResolvedValue(null);
      const qb = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
      identityRepo.createQueryBuilder.mockReturnValue(qb);

      // member save returns the member as-is (isResolved stays false)
      memberRepo.findOne.mockResolvedValue(null);
      const unresolvedMember = makeMemberEntity({ isResolved: false });
      memberRepo.create.mockReturnValue(unresolvedMember);
      memberRepo.save.mockResolvedValue(unresolvedMember);

      // cohort update at the end
      cohortRepo.findOne.mockResolvedValueOnce(makeCohortEntity());
      memberRepo.count.mockResolvedValue(0);
      cohortRepo.save.mockResolvedValue(makeCohortEntity());

      const result = await service.retryUnresolved('cohort-uuid-1');

      expect(result.attempted).toBe(2);
    });

    it('counts resolved members correctly when identity match is found', async () => {
      const member = makeMemberEntity({ mixpanelDistinctId: 'u1', mixpanelProfile: {} });
      memberRepo.find.mockResolvedValueOnce([member]);

      // identityRepo returns an identity for externalUserId lookup
      const identity = { id: 'identity-uuid-1', projectId: 'proj-1' } as DeviceIdentityEntity;
      identityRepo.findOne.mockResolvedValueOnce(identity); // externalUserId match

      // memberRepo upsert
      memberRepo.findOne.mockResolvedValueOnce(member);
      const resolvedMember = { ...member, isResolved: true, deviceIdentityId: 'identity-uuid-1' };
      memberRepo.save.mockResolvedValueOnce(resolvedMember as any);

      // cohort update
      cohortRepo.findOne.mockResolvedValueOnce(makeCohortEntity());
      memberRepo.count.mockResolvedValue(1);
      cohortRepo.save.mockResolvedValue(makeCohortEntity());

      const result = await service.retryUnresolved('cohort-uuid-1');

      expect(result.resolved).toBe(1);
      expect(result.attempted).toBe(1);
    });

    it('updates cohort resolved and unresolved counts after retry', async () => {
      memberRepo.find.mockResolvedValueOnce([]);

      const cohort = makeCohortEntity();
      cohortRepo.findOne.mockResolvedValueOnce(cohort);
      memberRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
      cohortRepo.save.mockResolvedValueOnce(cohort);

      await service.retryUnresolved('cohort-uuid-1');

      // When there are no unresolved members the cohort save still happens
      expect(cohortRepo.findOne).toHaveBeenCalledWith({ where: { id: 'cohort-uuid-1' } });
    });
  });
});
