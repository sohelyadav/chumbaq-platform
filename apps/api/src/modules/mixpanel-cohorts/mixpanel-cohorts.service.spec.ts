// Encryption key must be set before the service module loads its lazy getter.
process.env.MIXPANEL_ENCRYPTION_KEY = process.env.MIXPANEL_ENCRYPTION_KEY || 'test-encryption-key-must-be-32b!!';

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { MixpanelCohortsService } from './mixpanel-cohorts.service';
import { MixpanelApiService } from './mixpanel-api.service';
import { MixpanelConfigEntity } from './entities/mixpanel-config.entity';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeConfigEntity(overrides: Partial<MixpanelConfigEntity> = {}): MixpanelConfigEntity {
  // Use a real AES-256-GCM encryption of a known password so decrypt() works.
  // To avoid crypto coupling in tests we spy on getDecryptedConfig directly.
  return {
    id: 'cfg-uuid-1',
    projectId: 'proj-1',
    serviceAccountUsername: 'user@example.com',
    serviceAccountPasswordEncrypted: 'encrypted',
    encryptionIv: 'iv',
    encryptionTag: 'tag',
    mixpanelProjectId: 'mp-proj-1',
    isActive: true,
    lastTestAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  } as MixpanelConfigEntity;
}

function makeCohortEntity(overrides: Partial<MixpanelCohortEntity> = {}): MixpanelCohortEntity {
  return {
    id: 'cohort-uuid-1',
    projectId: 'proj-1',
    mixpanelCohortId: 111,
    name: 'Test Cohort',
    description: null,
    mixpanelUserCount: 10,
    resolvedCount: 0,
    unresolvedCount: 0,
    lastSyncedAt: null,
    status: 'synced',
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
    delete: jest.fn(async () => ({ affected: 1 })),
    update: jest.fn(),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('MixpanelCohortsService', () => {
  let service: MixpanelCohortsService;

  let configRepo: ReturnType<typeof makeMockRepo>;
  let cohortRepo: ReturnType<typeof makeMockRepo>;
  let memberRepo: ReturnType<typeof makeMockRepo>;
  let mixpanelApiService: jest.Mocked<MixpanelApiService>;
  const activity = { record: jest.fn() };

  beforeEach(async () => {
    configRepo = makeMockRepo();
    // configure writes in a transaction; its manager hands back the same repository.
    Object.assign(configRepo, {
      manager: { transaction: (work: (m: unknown) => unknown) => work({ getRepository: () => configRepo }) },
    });
    activity.record.mockReset();
    cohortRepo = makeMockRepo();
    memberRepo = makeMockRepo();

    mixpanelApiService = {
      testConnection: jest.fn(),
      listCohorts: jest.fn(),
      getCohortMembers: jest.fn(),
    } as unknown as jest.Mocked<MixpanelApiService>;

    // Deletes and status changes write their activity entry in the same transaction.
    Object.assign(cohortRepo, {
      manager: { transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => cohortRepo }) },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MixpanelCohortsService,
        { provide: getRepositoryToken(MixpanelConfigEntity), useValue: configRepo },
        { provide: getRepositoryToken(MixpanelCohortEntity), useValue: cohortRepo },
        { provide: getRepositoryToken(MixpanelCohortMemberEntity), useValue: memberRepo },
        { provide: MixpanelApiService, useValue: mixpanelApiService },
        { provide: ProjectActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<MixpanelCohortsService>(MixpanelCohortsService);
  });

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------
  describe('configure', () => {
    const dto = {
      serviceAccountUsername: 'user@example.com',
      serviceAccountPassword: 'secret-password-123',
      mixpanelProjectId: 'mp-proj-1',
    };

    it('creates a new config when none exists', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);
      const created = makeConfigEntity({ id: 'new-uuid' });
      configRepo.create.mockReturnValueOnce(created);
      configRepo.save.mockResolvedValueOnce(created);

      await service.configure('proj-1', dto, 'user-1', { ipAddress: null, userAgent: null });

      expect(configRepo.create).toHaveBeenCalledTimes(1);
      expect(configRepo.save).toHaveBeenCalledTimes(1);
    });

    it('updates the existing config when one already exists', async () => {
      const existing = makeConfigEntity();
      configRepo.findOne.mockResolvedValueOnce(existing);
      configRepo.save.mockResolvedValueOnce(existing);

      await service.configure('proj-1', dto, 'user-1', { ipAddress: null, userAgent: null });

      expect(configRepo.create).not.toHaveBeenCalled();
      expect(configRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ serviceAccountUsername: 'user@example.com' }),
      );
    });

    it('returns { id, projectId, isActive }', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);
      const created = makeConfigEntity({ id: 'result-uuid', projectId: 'proj-1', isActive: true });
      configRepo.create.mockReturnValueOnce(created);
      configRepo.save.mockResolvedValueOnce(created);

      const result = await service.configure('proj-1', dto, 'user-1', { ipAddress: null, userAgent: null });

      expect(result).toEqual({ id: 'result-uuid', projectId: 'proj-1', isActive: true });
    });

    it('sets isActive to true on update', async () => {
      const existing = makeConfigEntity({ isActive: false });
      configRepo.findOne.mockResolvedValueOnce(existing);
      configRepo.save.mockResolvedValueOnce({ ...existing, isActive: true });

      await service.configure('proj-1', dto, 'user-1', { ipAddress: null, userAgent: null });

      expect(configRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
      );
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mixpanel.configured' }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------
  describe('testConnection', () => {
    it('returns { connected: false, error } when config is not found', async () => {
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce(null);

      const result = await service.testConnection('proj-1');

      expect(result).toEqual({
        connected: false,
        error: 'Mixpanel not configured for this project',
      });
    });

    it('returns { connected: true } when API returns true', async () => {
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.testConnection.mockResolvedValueOnce(true);
      configRepo.update.mockResolvedValueOnce(undefined);

      const result = await service.testConnection('proj-1');

      expect(result).toEqual({ connected: true });
    });

    it('returns { connected: false } when API returns false', async () => {
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.testConnection.mockResolvedValueOnce(false);
      configRepo.update.mockResolvedValueOnce(undefined);

      const result = await service.testConnection('proj-1');

      expect(result).toEqual({ connected: false, error: 'Connection test failed — check credentials' });
    });

    it('handles a thrown error gracefully and returns { connected: false }', async () => {
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.testConnection.mockRejectedValueOnce(new Error('Timeout'));

      const result = await service.testConnection('proj-1');

      expect(result.connected).toBe(false);
      expect(result.error).toBe('Timeout');
    });

    it('updates lastTestAt after a successful API call', async () => {
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce({
        username: 'u',
        password: 'p',
        mixpanelProjectId: 'mp-1',
      });
      mixpanelApiService.testConnection.mockResolvedValueOnce(true);
      configRepo.update.mockResolvedValueOnce(undefined);

      await service.testConnection('proj-1');

      expect(configRepo.update).toHaveBeenCalledWith(
        { projectId: 'proj-1' },
        expect.objectContaining({ lastTestAt: expect.any(Date) }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getStatus
  // ---------------------------------------------------------------------------
  describe('getStatus', () => {
    it('returns { configured: false } when no config exists', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getStatus('proj-1');

      // Named in full rather than matched loosely: the dashboard shows which
      // Mixpanel account is connected, so a field silently going missing is a
      // regression the status test should catch.
      expect(result).toEqual({
        configured: false,
        isActive: false,
        lastTestAt: null,
        mixpanelProjectId: null,
        serviceAccountUsername: null,
      });
    });

    it('returns { configured: true, isActive, lastTestAt } when config exists', async () => {
      const lastTestAt = new Date('2024-06-01');
      configRepo.findOne.mockResolvedValueOnce(
        makeConfigEntity({ isActive: true, lastTestAt }),
      );

      const result = await service.getStatus('proj-1');

      expect(result).toEqual({
        configured: true,
        isActive: true,
        lastTestAt,
        mixpanelProjectId: 'mp-proj-1',
        serviceAccountUsername: 'user@example.com',
      });
    });

    it('reflects isActive: false when config is deactivated', async () => {
      configRepo.findOne.mockResolvedValueOnce(
        makeConfigEntity({ isActive: false, lastTestAt: null }),
      );

      const result = await service.getStatus('proj-1');

      expect(result.isActive).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // listImportedCohorts
  // ---------------------------------------------------------------------------
  describe('listImportedCohorts', () => {
    it('returns the ordered list from the repository', async () => {
      const cohorts = [makeCohortEntity({ id: 'c1' }), makeCohortEntity({ id: 'c2' })];
      cohortRepo.find.mockResolvedValueOnce(cohorts);

      const result = await service.listImportedCohorts('proj-1');

      expect(result).toHaveLength(2);
      expect(cohortRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1' },
        order: { createdAt: 'DESC' },
      });
    });

    it('returns an empty array when there are no cohorts', async () => {
      cohortRepo.find.mockResolvedValueOnce([]);

      const result = await service.listImportedCohorts('proj-1');

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // findImportedCohort
  // ---------------------------------------------------------------------------
  describe('findImportedCohort', () => {
    it('returns the cohort when found', async () => {
      const cohort = makeCohortEntity();
      cohortRepo.findOne.mockResolvedValueOnce(cohort);

      const result = await service.findImportedCohort('proj-1', 'cohort-uuid-1');

      expect(result).toBe(cohort);
    });

    it('throws NotFoundException when the cohort does not exist', async () => {
      cohortRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findImportedCohort('proj-1', 'missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException with message "Cohort not found"', async () => {
      cohortRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.findImportedCohort('proj-1', 'missing-id')).rejects.toThrow(
        'Cohort not found',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // deleteImportedCohort
  // ---------------------------------------------------------------------------
  describe('deleteImportedCohort', () => {
    it('deletes the found cohort by id and project', async () => {
      const cohort = makeCohortEntity();
      cohortRepo.findOne.mockResolvedValueOnce(cohort);

      await service.deleteImportedCohort('proj-1', 'cohort-uuid-1', REQUESTER);

      expect(cohortRepo.delete).toHaveBeenCalledWith({ id: 'cohort-uuid-1', projectId: 'proj-1' });
    });

    it('throws NotFoundException when cohort does not exist', async () => {
      cohortRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.deleteImportedCohort('proj-1', 'missing-id', REQUESTER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listAvailableCohorts
  // ---------------------------------------------------------------------------
  describe('listAvailableCohorts', () => {
    it('throws BadRequestException when Mixpanel is not configured', async () => {
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce(null);

      await expect(service.listAvailableCohorts('proj-1')).rejects.toThrow(BadRequestException);
    });

    it('delegates to mixpanelApiService.listCohorts when configured', async () => {
      const creds = { username: 'u', password: 'p', mixpanelProjectId: 'mp-1' };
      jest.spyOn(service, 'getDecryptedConfig').mockResolvedValueOnce(creds);
      mixpanelApiService.listCohorts.mockResolvedValueOnce([]);

      await service.listAvailableCohorts('proj-1');

      expect(mixpanelApiService.listCohorts).toHaveBeenCalledWith(creds);
    });
  });
});
