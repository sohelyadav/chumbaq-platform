import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserEntity } from './entities/user.entity';

describe('UsersService', () => {
  let service: UsersService;

  const mockRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(UserEntity), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  // ---------------------------------------------------------------------------
  // findByEmail
  // ---------------------------------------------------------------------------
  describe('findByEmail', () => {
    it('returns a user when one exists with the given email', async () => {
      const user = { id: 'u1', email: 'a@b.com' } as UserEntity;
      mockRepo.findOne.mockResolvedValueOnce(user);

      const result = await service.findByEmail('a@b.com');

      expect(result).toBe(user);
      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
    });

    it('returns null when no user matches', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.findByEmail('missing@example.com');

      expect(result).toBeNull();
    });

    it('passes an empty string email through to the repository', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      await service.findByEmail('');

      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { email: '' } });
    });
  });

  // ---------------------------------------------------------------------------
  // findById
  // ---------------------------------------------------------------------------
  describe('findById', () => {
    it('returns a user when one exists with the given id', async () => {
      const user = { id: 'u1', email: 'a@b.com' } as UserEntity;
      mockRepo.findOne.mockResolvedValueOnce(user);

      const result = await service.findById('u1');

      expect(result).toBe(user);
      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
    });

    it('returns null when no user matches', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.findById('missing');

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    const data = { email: 'new@example.com', name: 'New', passwordHash: 'hash' };

    it('creates and saves a new user when email is not taken', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);
      const created = { ...data } as UserEntity;
      const saved = { id: 'u99', ...data } as UserEntity;
      mockRepo.create.mockReturnValueOnce(created);
      mockRepo.save.mockResolvedValueOnce(saved);

      const result = await service.create(data);

      expect(mockRepo.create).toHaveBeenCalledWith(data);
      expect(mockRepo.save).toHaveBeenCalledWith(created);
      expect(result).toBe(saved);
    });

    it('throws ConflictException when a user with the email already exists', async () => {
      mockRepo.findOne.mockResolvedValueOnce({ id: 'existing' } as UserEntity);

      await expect(service.create(data)).rejects.toBeInstanceOf(ConflictException);
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('ConflictException message mentions the duplicate email', async () => {
      mockRepo.findOne.mockResolvedValueOnce({ id: 'existing' } as UserEntity);

      await expect(service.create(data)).rejects.toThrow(
        'A user with this email already exists',
      );
    });
  });
});
