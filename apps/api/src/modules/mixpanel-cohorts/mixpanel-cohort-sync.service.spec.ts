import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MixpanelCohortSyncService } from './mixpanel-cohort-sync.service';
import { MixpanelApiService } from './mixpanel-api.service';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { cohortTooLarge } from './cohort-sync-limits';

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

      const err = await service.importCohort('proj-1', 42).catch((e) => e);
      // A 400 for the caller, not a 500: the project simply has not connected Mixpanel.
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('Mixpanel is not configured for this project');
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

      const err = await service.importCohort('proj-1', 42).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe('Cohort 42 not found in Mixpanel');
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

    // Claiming an existing cohort is a conditional UPDATE: see mixpanel-sync-claim.int-spec.ts.

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

    it('syncForJob waits for the sync and says it synced', async () => {
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
      (memberRepo as unknown as { query: jest.Mock }).query = jest.fn().mockResolvedValue([]);
      mixpanelApiService.getCohortMembers.mockResolvedValueOnce([]);

      const outcome = await service.syncForJob('proj-1', 42);

      expect(mixpanelApiService.getCohortMembers).toHaveBeenCalled();
      expect(outcome).toEqual({ kind: 'synced' });
      expect(cohortRepo.update).toHaveBeenCalledWith({ id: newCohort.id }, expect.objectContaining({ status: 'synced' }));
    });

    it('syncForJob reports a cohort past the member cap as not worth retrying', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({ username: 'u', password: 'p', mixpanelProjectId: 'mp-1' });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([{ id: 42, name: 'Big', count: 5, created: '2024-01-01' }]);
      cohortRepo.findOne.mockResolvedValueOnce(null);
      const newCohort = makeCohortEntity({ status: 'syncing' });
      cohortRepo.create.mockReturnValueOnce(newCohort);
      cohortRepo.save.mockResolvedValueOnce(newCohort);
      mixpanelApiService.getCohortMembers.mockRejectedValueOnce(cohortTooLarge());

      const outcome = await service.syncForJob('proj-1', 42);

      expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
      expect(cohortRepo.update).toHaveBeenCalledWith({ id: newCohort.id }, expect.objectContaining({ status: 'error' }));
    });

    it('syncForJob reports a Mixpanel failure as worth retrying', async () => {
      mixpanelCohortsService.getDecryptedConfig.mockResolvedValueOnce({ username: 'u', password: 'p', mixpanelProjectId: 'mp-1' });
      mixpanelApiService.listCohorts.mockResolvedValueOnce([{ id: 42, name: 'A', count: 5, created: '2024-01-01' }]);
      cohortRepo.findOne.mockResolvedValueOnce(null);
      const newCohort = makeCohortEntity({ status: 'syncing' });
      cohortRepo.create.mockReturnValueOnce(newCohort);
      cohortRepo.save.mockResolvedValueOnce(newCohort);
      mixpanelApiService.getCohortMembers.mockRejectedValueOnce(new Error('Mixpanel engage API error: 503'));

      expect(await service.syncForJob('proj-1', 42)).toMatchObject({ kind: 'failed', retryable: true });
    });
  });
});
