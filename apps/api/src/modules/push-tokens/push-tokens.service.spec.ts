import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';
import { PushTokensService } from './push-tokens.service';
import { PushTokenEntity } from './entities/push-token.entity';
import { IdentityService } from '../identity/identity.service';

describe('PushTokensService', () => {
  let service: PushTokensService;

  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    getCount: jest.fn(),
  };

  const tokenRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };

  const identityService = {
    findByFingerprintAndProject: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset queryBuilder mock to chain properly
    Object.assign(queryBuilder, {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushTokensService,
        { provide: getRepositoryToken(PushTokenEntity), useValue: tokenRepo },
        { provide: IdentityService, useValue: identityService },
      ],
    }).compile();

    service = module.get<PushTokensService>(PushTokensService);
  });

  // ---------------------------------------------------------------------------
  // registerToken
  // ---------------------------------------------------------------------------
  describe('registerToken', () => {
    const dto = {
      projectId: 'proj-1',
      deviceFingerprint: 'fp-1',
      token: 'tok-abc',
      platform: 'ios' as const,
      provider: 'fcm' as const,
    };

    it('throws NotFoundException if device identity does not exist', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce(null);

      await expect(service.registerToken(dto)).rejects.toThrow(NotFoundException);
      expect(tokenRepo.create).not.toHaveBeenCalled();
      expect(tokenRepo.save).not.toHaveBeenCalled();
    });

    it('creates a new token row when no existing token matches', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'dev-1' });
      tokenRepo.findOne.mockResolvedValueOnce(null);
      tokenRepo.create.mockImplementation((obj) => ({ ...obj }));
      tokenRepo.save.mockImplementation(async (obj) => ({ id: 'tk-1', ...obj }));

      const result = await service.registerToken(dto);

      expect(tokenRepo.create).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityId: 'dev-1',
        token: 'tok-abc',
        platform: 'ios',
        provider: 'fcm',
        isActive: true,
      });
      expect(result.id).toBe('tk-1');
      expect(result.isActive).toBe(true);
    });

    it('defaults provider to "fcm" when not provided', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'dev-1' });
      tokenRepo.findOne.mockResolvedValueOnce(null);
      tokenRepo.create.mockImplementation((obj) => obj);
      tokenRepo.save.mockImplementation(async (obj) => obj);

      await service.registerToken({
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        token: 'tok-abc',
        platform: 'android',
      });

      expect(tokenRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'fcm' }),
      );
    });

    it('upserts existing token: reassigns device identity, reactivates, stamps lastUsedAt', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'dev-new' });
      const existingToken = {
        id: 'tk-1',
        projectId: 'proj-1',
        token: 'tok-abc',
        deviceIdentityId: 'dev-old',
        platform: 'android',
        provider: 'fcm',
        isActive: false,
        lastUsedAt: new Date('2020-01-01'),
      };
      tokenRepo.findOne.mockResolvedValueOnce(existingToken);
      tokenRepo.save.mockImplementation(async (obj) => obj);

      const before = Date.now();
      const result = await service.registerToken(dto);

      expect(tokenRepo.create).not.toHaveBeenCalled();
      expect(result.deviceIdentityId).toBe('dev-new');
      expect(result.platform).toBe('ios');
      expect(result.isActive).toBe(true);
      expect((result.lastUsedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('scopes existing-token lookup by projectId and token', async () => {
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({ id: 'dev-1' });
      tokenRepo.findOne.mockResolvedValueOnce(null);
      tokenRepo.create.mockImplementation((o) => o);
      tokenRepo.save.mockImplementation(async (o) => o);

      await service.registerToken(dto);

      expect(tokenRepo.findOne).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', token: 'tok-abc' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // unregisterToken
  // ---------------------------------------------------------------------------
  describe('unregisterToken', () => {
    it('sets isActive to false for the matching project+token', async () => {
      tokenRepo.update.mockResolvedValueOnce({});

      await service.unregisterToken('proj-1', 'tok-abc');

      expect(tokenRepo.update).toHaveBeenCalledWith(
        { projectId: 'proj-1', token: 'tok-abc' },
        {
          isActive: false,
          deactivatedAt: expect.any(Date),
          // A logout is not an uninstall. Recording the reason is what keeps
          // it out of the churn figures.
          deactivationReason: 'app_requested',
        },
      );
    });
  });

  describe('re-registration', () => {
    it('clears the deactivation record when a token comes back', async () => {
      const existing: Record<string, unknown> = {
        id: 't1',
        isActive: false,
        deactivatedAt: new Date('2026-01-01'),
        deactivationReason: 'provider_rejected',
      };
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'dev-1',
      });
      tokenRepo.findOne.mockResolvedValueOnce(existing);
      tokenRepo.save.mockImplementation(async (o: unknown) => o);

      await service.registerToken({
        projectId: 'proj-1',
        deviceFingerprint: 'fp-1',
        token: 'tok-abc',
        platform: 'ios' as const,
        provider: 'fcm' as const,
      });

      // A token that comes back was never really gone. Leaving the record in
      // place would keep counting a reinstalled device as an uninstall.
      expect(existing.isActive).toBe(true);
      expect(existing.deactivatedAt).toBeNull();
      expect(existing.deactivationReason).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // markTokenInvalid
  // ---------------------------------------------------------------------------
  describe('markTokenInvalid', () => {
    it('deactivates all token rows matching the given token string', async () => {
      tokenRepo.update.mockResolvedValueOnce({});

      await service.markTokenInvalid('tok-abc');

      expect(tokenRepo.update).toHaveBeenCalledWith(
        { token: 'tok-abc' },
        {
          isActive: false,
          deactivatedAt: expect.any(Date),
          deactivationReason: 'provider_rejected',
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // markTokensInvalid
  // ---------------------------------------------------------------------------
  describe('markTokensInvalid', () => {
    it('deactivates the batch in one update scoped to the project', async () => {
      tokenRepo.update.mockResolvedValueOnce({});

      await service.markTokensInvalid('proj-1', ['tok-a', 'tok-b']);

      expect(tokenRepo.update).toHaveBeenCalledTimes(1);
      expect(tokenRepo.update).toHaveBeenCalledWith(
        { projectId: 'proj-1', token: In(['tok-a', 'tok-b']) },
        {
          isActive: false,
          deactivatedAt: expect.any(Date),
          deactivationReason: 'provider_rejected',
        },
      );
    });

    it('does not deactivate the same token value in other projects', async () => {
      tokenRepo.update.mockResolvedValueOnce({});

      await service.markTokensInvalid('proj-1', ['shared-token']);

      const [criteria] = tokenRepo.update.mock.calls[0];
      expect(criteria.projectId).toBe('proj-1');
    });

    it('issues no statement for an empty batch', async () => {
      await service.markTokensInvalid('proj-1', []);

      expect(tokenRepo.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Paginated reads used by the campaign worker
  // ---------------------------------------------------------------------------
  describe('countActiveTokensByProject', () => {
    it('counts only active tokens for the project', async () => {
      queryBuilder.getCount.mockResolvedValueOnce(1234);

      await expect(service.countActiveTokensByProject('proj-1')).resolves.toBe(1234);
      expect(queryBuilder.where).toHaveBeenCalledWith(
        't.project_id = :projectId',
        { projectId: 'proj-1' },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('t.is_active = true');
    });

    it('excludes devices already at their daily cap', async () => {
      queryBuilder.getCount.mockResolvedValueOnce(21);

      await expect(
        service.countActiveTokensByProject('proj-1', 2),
      ).resolves.toBe(21);

      // The preview must be produced by the same predicate that decides who is
      // actually sent to, or it promises reach the send cannot deliver.
      const capClause = queryBuilder.andWhere.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('push_notification_events'),
      );
      expect(capClause).toBeDefined();
      expect(capClause![1]).toMatchObject({ cap: 2 });
    });
  });

  describe('countTokensByDeviceIdentityIds', () => {
    it('returns 0 without querying when the id list is empty', async () => {
      await expect(service.countTokensByDeviceIdentityIds('proj-1', [])).resolves.toBe(0);
      expect(tokenRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('counts active tokens for the given identities', async () => {
      queryBuilder.getCount.mockResolvedValueOnce(2);

      await expect(
        service.countTokensByDeviceIdentityIds('proj-1', ['dev-1', 'dev-2']),
      ).resolves.toBe(2);
      expect(queryBuilder.where).toHaveBeenCalledWith(
        't.project_id = :projectId',
        { projectId: 'proj-1' },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        't.device_identity_id IN (:...ids)',
        { ids: ['dev-1', 'dev-2'] },
      );
    });
  });

  describe('getActiveTokensPage', () => {
    it('orders by id and does not add a cursor predicate on the first page', async () => {
      queryBuilder.getMany.mockResolvedValueOnce([{ id: 'a', token: 't1' }]);

      const page = await service.getActiveTokensPage('proj-1', null, 500);

      expect(page).toEqual([{ id: 'a', token: 't1' }]);
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('t.id', 'ASC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(500);
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
        't.id > :afterId',
        expect.anything(),
      );
    });

    it('applies the keyset cursor on later pages', async () => {
      queryBuilder.getMany.mockResolvedValueOnce([]);

      await service.getActiveTokensPage('proj-1', 'tok-500', 500);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('t.id > :afterId', {
        afterId: 'tok-500',
      });
    });
  });

  describe('getTokensByDeviceIdentityIdsPage', () => {
    it('short-circuits on an empty id list', async () => {
      const page = await service.getTokensByDeviceIdentityIdsPage('proj-1', [], null, 500);

      expect(page).toEqual([]);
      expect(tokenRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('filters by identity ids and applies the cursor', async () => {
      queryBuilder.getMany.mockResolvedValueOnce([{ id: 'b', token: 'tx' }]);

      const page = await service.getTokensByDeviceIdentityIdsPage(
        'proj-1',
        ['dev-1'],
        'tok-9',
        500,
      );

      expect(page).toEqual([{ id: 'b', token: 'tx' }]);
      expect(queryBuilder.where).toHaveBeenCalledWith(
        't.project_id = :projectId',
        { projectId: 'proj-1' },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        't.device_identity_id IN (:...ids)',
        { ids: ['dev-1'] },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('t.id > :afterId', {
        afterId: 'tok-9',
      });
    });
  });
});
