import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyEntity } from './entities/api-key.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const CTX = { ipAddress: null, userAgent: null };

describe('ApiKeysService', () => {
  let service: ApiKeysService;

  const mockRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    exists: jest.fn(),
    // The service writes in a transaction; its manager hands back this same repository.
    manager: {
      transaction: async (work: (manager: unknown) => Promise<unknown>) =>
        work({ getRepository: () => mockRepo }),
    },
  };
  const activity = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: getRepositoryToken(ApiKeyEntity), useValue: mockRepo },
        { provide: ProjectActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    it('generates a raw key prefixed with "chumbaq_" and returns it alongside the saved entity', async () => {
      const created = { id: 'k1' } as ApiKeyEntity;
      const saved = { id: 'k1', name: 'Key' } as ApiKeyEntity;
      mockRepo.create.mockReturnValueOnce(created);
      mockRepo.save.mockResolvedValueOnce(saved);

      const result = await service.create('proj-1', { name: 'Key' } as any, 'user-1', CTX);

      expect(result.fullKey).toMatch(/^chumbaq_[a-f0-9]{64}$/);
      expect(result.apiKey).toBe(saved);
    });

    it('hashes the generated key with sha256 and stores a 12-char prefix', async () => {
      mockRepo.create.mockImplementationOnce((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementationOnce(async (entity: any) => entity);

      const result = await service.create('proj-1', { name: 'Key' } as any, 'user-1', CTX);

      const expectedHash = crypto
        .createHash('sha256')
        .update(result.fullKey)
        .digest('hex');
      const createdArg = mockRepo.create.mock.calls[0][0];
      expect(createdArg.keyHash).toBe(expectedHash);
      expect(createdArg.prefix).toBe(result.fullKey.substring(0, 12));
      expect(createdArg.prefix).toHaveLength(12);
    });

    it('defaults permissions to ["read", "write"] when none provided', async () => {
      mockRepo.create.mockImplementationOnce((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementationOnce(async (entity: any) => entity);

      await service.create('proj-1', { name: 'Key' } as any, 'user-1', CTX);

      const createdArg = mockRepo.create.mock.calls[0][0];
      expect(createdArg.permissions).toEqual(['read', 'write']);
    });

    it('uses the provided permissions when supplied', async () => {
      mockRepo.create.mockImplementationOnce((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementationOnce(async (entity: any) => entity);

      await service.create('proj-1', {
        name: 'Key',
        permissions: ['read'],
      } as any, 'user-1', CTX);

      const createdArg = mockRepo.create.mock.calls[0][0];
      expect(createdArg.permissions).toEqual(['read']);
    });

    it('converts expiresAt string to a Date', async () => {
      mockRepo.create.mockImplementationOnce((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementationOnce(async (entity: any) => entity);

      await service.create('proj-1', {
        name: 'Key',
        expiresAt: '2030-01-01T00:00:00.000Z',
      } as any, 'user-1', CTX);

      const createdArg = mockRepo.create.mock.calls[0][0];
      expect(createdArg.expiresAt).toBeInstanceOf(Date);
      expect(createdArg.expiresAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    });

    it('sets expiresAt to null when not provided', async () => {
      mockRepo.create.mockImplementationOnce((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementationOnce(async (entity: any) => entity);

      await service.create('proj-1', { name: 'Key' } as any, 'user-1', CTX);

      const createdArg = mockRepo.create.mock.calls[0][0];
      expect(createdArg.expiresAt).toBeNull();
    });

    it('scopes the created key to the supplied project id', async () => {
      mockRepo.create.mockImplementationOnce((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementationOnce(async (entity: any) => entity);

      await service.create('proj-xyz', { name: 'Key' } as any, 'user-1', CTX);

      const createdArg = mockRepo.create.mock.calls[0][0];
      expect(createdArg.projectId).toBe('proj-xyz');
    });

    it('two consecutive calls return distinct raw keys (randomness)', async () => {
      mockRepo.create.mockImplementation((entity: Partial<ApiKeyEntity>) => entity);
      mockRepo.save.mockImplementation(async (entity: any) => entity);

      const a = await service.create('p1', { name: 'K' } as any, 'user-1', CTX);
      const b = await service.create('p1', { name: 'K' } as any, 'user-1', CTX);

      expect(a.fullKey).not.toBe(b.fullKey);
    });
  });

  // ---------------------------------------------------------------------------
  // findAllByProject
  // ---------------------------------------------------------------------------
  describe('findAllByProject', () => {
    it('queries the repository scoped to the project and ordered by createdAt DESC', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      await service.findAllByProject('proj-1');

      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { projectId: 'proj-1' },
        order: { createdAt: 'DESC' },
      });
    });

    it('returns the repository results unchanged', async () => {
      const rows = [{ id: 'a' }, { id: 'b' }] as ApiKeyEntity[];
      mockRepo.find.mockResolvedValueOnce(rows);

      const result = await service.findAllByProject('proj-1');

      expect(result).toBe(rows);
    });

    it('returns an empty array when no keys exist', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      const result = await service.findAllByProject('proj-1');

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // revoke
  // ---------------------------------------------------------------------------
  describe('revoke', () => {
    it('writes only is_active, scoped to the project, never a whole row', async () => {
      mockRepo.update.mockResolvedValueOnce({ affected: 1 });
      mockRepo.findOne.mockResolvedValueOnce({ id: 'k1', name: 'Key' });

      await service.revoke('k1', 'p1', 'user-1', CTX);

      expect(mockRepo.update).toHaveBeenCalledWith(
        { id: 'k1', projectId: 'p1', isActive: true },
        { isActive: false },
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api_key.revoked', target: { type: 'api_key', id: 'k1', label: 'Key' } }),
        CTX,
        expect.anything(),
      );
    });

    it('a key already revoked succeeds and logs nothing', async () => {
      mockRepo.update.mockResolvedValueOnce({ affected: 0 });
      mockRepo.exists.mockResolvedValueOnce(true);

      await service.revoke('k1', 'p1', 'user-1', CTX);

      expect(activity.record).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the key does not exist', async () => {
      mockRepo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.revoke('missing', 'p1', 'user-1', CTX)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('scopes by projectId — cannot revoke another project\'s key', async () => {
      mockRepo.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.revoke('k1', 'wrong-project', 'user-1', CTX)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockRepo.update).toHaveBeenCalledWith(
        { id: 'k1', projectId: 'wrong-project', isActive: true },
        { isActive: false },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // validateKey
  // ---------------------------------------------------------------------------
  describe('validateKey', () => {
    it('returns null when no active key matches the hash', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.validateKey('chumbaq_nope');

      expect(result).toBeNull();
    });

    it('hashes the raw key and looks it up with isActive=true and loads project relation', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      await service.validateKey('chumbaq_abc');

      const expectedHash = crypto
        .createHash('sha256')
        .update('chumbaq_abc')
        .digest('hex');
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { keyHash: expectedHash, isActive: true },
        relations: ['project'],
      });
    });

    it('returns the key, updates lastUsedAt, and persists when valid and unexpired', async () => {
      const key = {
        id: 'k1',
        keyHash: 'hash',
        isActive: true,
        expiresAt: null as any,
        lastUsedAt: null as any,
      } as ApiKeyEntity;
      mockRepo.findOne.mockResolvedValueOnce(key);
      mockRepo.update.mockResolvedValueOnce({ affected: 1 });

      const result = await service.validateKey('chumbaq_abc');

      expect(result).toBe(key);
      expect(key.lastUsedAt).toBeInstanceOf(Date);
      // Only last_used_at, and only while still active: a save() of the row
      // would write is_active back and undo a revoke made in between.
      expect(mockRepo.update).toHaveBeenCalledWith(
        { id: 'k1', isActive: true },
        { lastUsedAt: key.lastUsedAt },
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('refuses the key when it was revoked between the lookup and the write', async () => {
      const key = { id: 'k1', keyHash: 'hash', isActive: true, expiresAt: null as any } as ApiKeyEntity;
      mockRepo.findOne.mockResolvedValueOnce(key);
      mockRepo.update.mockResolvedValueOnce({ affected: 0 });

      expect(await service.validateKey('chumbaq_abc')).toBeNull();
    });

    it('returns null when the key has expired', async () => {
      const key = {
        id: 'k1',
        keyHash: 'hash',
        isActive: true,
        expiresAt: new Date('2000-01-01'),
      } as ApiKeyEntity;
      mockRepo.findOne.mockResolvedValueOnce(key);

      const result = await service.validateKey('chumbaq_abc');

      expect(result).toBeNull();
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('accepts a future expiresAt as unexpired', async () => {
      const future = new Date(Date.now() + 86400000);
      const key = {
        id: 'k1',
        keyHash: 'hash',
        isActive: true,
        expiresAt: future,
      } as ApiKeyEntity;
      mockRepo.findOne.mockResolvedValueOnce(key);
      mockRepo.update.mockResolvedValueOnce({ affected: 1 });

      const result = await service.validateKey('chumbaq_abc');

      expect(result).toBe(key);
    });
  });
});
