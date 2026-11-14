import { ConflictException } from '@nestjs/common';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { Test, TestingModule } from '@nestjs/testing';
import { PreAuthService } from './pre-auth.service';
import { SecondFactorsService } from './second-factors.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService, SignedIn, SIGNUP_LINK_INVALID } from './auth.service';
import { UsersService } from '../users/users.service';
import { UserEntity } from '../users/entities/user.entity';
import { SessionsService } from './sessions.service';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthEventsService } from '../auth-events/auth-events.service';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import { TripwiresService } from '../security-alerts/tripwires.service';
import { signSignupToken, signupKey } from './signup-token';

jest.mock('bcrypt');
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe('AuthService', () => {
  let service: AuthService;

  const mockUsersService = {
    create: jest.fn(),
    findByEmail: jest.fn(),
    findById: jest.fn(),
  };

  const mockJwtService = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        'jwt.secret': 'test-secret',
        'jwt.refreshSecret': 'test-refresh-secret-not-the-access-one',
        'jwt.expiration': '15m',
        'jwt.refreshExpiration': '7d',
        'jwt.refreshLifetimeMs': 7 * 86_400_000,
        'jwt.sessionMaxAgeMs': 30 * 86_400_000,
      };
      return map[key] ?? def;
    }),
    getOrThrow: jest.fn((key: string) => (key === 'jwt.secret' ? 'test-secret' : undefined)),
  };

  const mockSessions = {
    create: jest.fn(async () => ({ sessionId: 'session-1', jti: 'jti-1', createdAt: new Date() })),
    rotate: jest.fn(),
    revoke: jest.fn(),
    revokeAll: jest.fn(),
  };

  const mockEvents = {
    record: jest.fn(async () => undefined),
    recentLoginFailures: jest.fn(async () => 0),
  };

  const mockRecovery = { sendVerificationAfterRegister: jest.fn(), startSignup: jest.fn() };
  const signupToken = (email = 'a@b.com', name = 'Alice') => signSignupToken(signupKey('test-secret'), { email, name });

  const buildUser = (overrides: Partial<UserEntity> = {}): UserEntity =>
    ({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      passwordHash: 'stored-hash',
      sessionVersion: 0,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      ...overrides,
    } as UserEntity);

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SessionsService, useValue: mockSessions },
        { provide: AuthEventsService, useValue: mockEvents },
        { provide: AccountRecoveryService, useValue: mockRecovery },
        { provide: PreAuthService, useValue: { putChallenge: async () => undefined, admitLimited: async () => true } },
        { provide: SecondFactorsService, useValue: { methodsFor: async () => [], hasAnyPasskey: async () => false } },
        { provide: SecurityNoticesService, useValue: { inBackground: () => undefined, sessionReplayed: jest.fn() } },
        { provide: FactorResetsService, useValue: { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } },
        { provide: TripwiresService, useValue: { findAccount: async () => null, trippedAccount: async () => undefined } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ---------------------------------------------------------------------------
  // register
  // ---------------------------------------------------------------------------
  describe('register', () => {
    // The same answer for every address: the account is made from the mailed link.
    it('makes no account and no session, and hands the address to the mailed step', async () => {
      await expect(service.register({ email: 'a@b.com', name: 'Alice' })).resolves.toBeUndefined();
      expect(mockUsersService.create).not.toHaveBeenCalled();
      expect(mockSessions.create).not.toHaveBeenCalled();
      expect(mockRecovery.startSignup).toHaveBeenCalledWith('a@b.com', 'Alice');
    });
  });

  describe('completeSignup', () => {
    it('makes the verified account with the password chosen now, hashed at cost 12, and signs it in', async () => {
      (mockedBcrypt.hash as jest.Mock).mockResolvedValueOnce('hashed');
      mockUsersService.create.mockResolvedValueOnce(buildUser());
      mockJwtService.signAsync.mockResolvedValueOnce('access-tok').mockResolvedValueOnce('refresh-tok');

      const result = await service.completeSignup(signupToken(), 'a-new-password');

      expect(mockedBcrypt.hash).toHaveBeenCalledWith('a-new-password', 12);
      expect(mockUsersService.create).toHaveBeenCalledWith({
        email: 'a@b.com',
        name: 'Alice',
        passwordHash: 'hashed',
        emailVerified: true,
      });
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens).toEqual({ accessToken: 'access-tok', refreshToken: 'refresh-tok' });
    });

    it.each([
      ['forged', () => `${signupToken().split('.')[0]}.AAAA`],
      ['signed with another key', () => signSignupToken(signupKey('another-secret'), { email: 'a@b.com', name: 'A' })],
      ['expired', () => signSignupToken(signupKey('test-secret'), { email: 'a@b.com', name: 'A' }, Date.now() - 25 * 3600_000)],
    ])('refuses a %s link and makes nothing', async (_kind, token) => {
      await expect(service.completeSignup(token(), 'a-new-password')).rejects.toThrow(SIGNUP_LINK_INVALID);
      expect(mockUsersService.create).not.toHaveBeenCalled();
    });

    it('refuses a link whose address already has an account, as any spent link', async () => {
      (mockedBcrypt.hash as jest.Mock).mockResolvedValueOnce('hashed');
      mockUsersService.create.mockRejectedValueOnce(new ConflictException('taken'));
      await expect(service.completeSignup(signupToken(), 'a-new-password')).rejects.toThrow(SIGNUP_LINK_INVALID);
    });
  });

  // ---------------------------------------------------------------------------
  // login
  // ---------------------------------------------------------------------------
  describe('login', () => {
    it('returns sanitized user + tokens on valid credentials', async () => {
      const user = buildUser();
      mockUsersService.findByEmail.mockResolvedValueOnce(user);
      (mockedBcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
      mockJwtService.signAsync
        .mockResolvedValueOnce('access-tok')
        .mockResolvedValueOnce('refresh-tok');

      const result = (await service.login({ email: 'a@b.com', password: 'pw' })) as SignedIn;

      expect(mockedBcrypt.compare).toHaveBeenCalledWith('pw', 'stored-hash');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens.accessToken).toBe('access-tok');
      expect(result.tokens.refreshToken).toBe('refresh-tok');
    });

    it('throws UnauthorizedException when user not found', async () => {
      mockUsersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        service.login({ email: 'none@example.com', password: 'pw' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Same work as a real account, so timing does not reveal which addresses exist.
      expect(mockedBcrypt.compare).toHaveBeenCalledTimes(1);
    });

    it('throws UnauthorizedException when the password does not match', async () => {
      mockUsersService.findByEmail.mockResolvedValueOnce(buildUser());
      (mockedBcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.login({ email: 'a@b.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('UnauthorizedException message is generic', async () => {
      mockUsersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        service.login({ email: 'a@b.com', password: 'pw' }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('refuses a suspended account with the right password, issuing no tokens', async () => {
      mockUsersService.findByEmail.mockResolvedValueOnce(
        buildUser({ suspendedAt: new Date('2026-11-01'), suspendedReason: 'abuse' }),
      );
      (mockedBcrypt.compare as jest.Mock).mockResolvedValueOnce(true);

      const attempt = service.login({ email: 'a@b.com', password: 'pw' });

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toThrow('Account suspended');
      expect(mockJwtService.signAsync).not.toHaveBeenCalled();
    });

    it('does not reveal suspension to someone without the password', async () => {
      mockUsersService.findByEmail.mockResolvedValueOnce(
        buildUser({ suspendedAt: new Date('2026-11-01') }),
      );
      (mockedBcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.login({ email: 'a@b.com', password: 'wrong' }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('allows an account whose suspension has been lifted', async () => {
      mockUsersService.findByEmail.mockResolvedValueOnce(
        buildUser({ suspendedAt: null, suspendedReason: null }),
      );
      (mockedBcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
      mockJwtService.signAsync.mockResolvedValue('token');

      await expect(service.login({ email: 'a@b.com', password: 'pw' })).resolves.toHaveProperty(
        'tokens',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // refresh
  // ---------------------------------------------------------------------------
  describe('refresh', () => {
    it('returns new tokens when the refresh token is valid', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        email: 'a@b.com',
        type: 'refresh',
        sid: 'session-1',
        jti: 'jti-1',
      });
      mockSessions.rotate.mockResolvedValueOnce({
        outcome: 'rotated',
        jti: 'jti-2',
        amr: ['pwd'],
        authenticatedAt: null,
        createdAt: new Date(),
      });
      mockUsersService.findById.mockResolvedValueOnce(buildUser());
      mockJwtService.signAsync
        .mockResolvedValueOnce('new-access')
        .mockResolvedValueOnce('new-refresh');

      const tokens = await service.refresh('refresh-token');

      // The refresh key, never the access one.
      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('refresh-token', {
        secret: 'test-refresh-secret-not-the-access-one',
        algorithms: ['HS256'],
      });
      expect(tokens).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
      expect(mockSessions.rotate).toHaveBeenCalledWith('session-1', 'user-1', 'jti-1', 30 * 86_400_000);
    });

    it('throws UnauthorizedException when payload.type is not "refresh"', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        email: 'a@b.com',
        type: 'access',
      });

      await expect(service.refresh('access-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when verifyAsync rejects (expired/invalid)', async () => {
      mockJwtService.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));

      await expect(service.refresh('bad-token')).rejects.toThrow(
        'Invalid or expired refresh token',
      );
    });

    it('throws UnauthorizedException when the referenced user no longer exists', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        email: 'a@b.com',
        type: 'refresh',
      });
      mockUsersService.findById.mockResolvedValueOnce(null);

      await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('preserves original UnauthorizedException thrown inside the try block', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        email: 'a@b.com',
        type: 'access', // triggers inner UnauthorizedException
      });

      await expect(service.refresh('tok')).rejects.toThrow('Invalid refresh token');
    });

    it('refuses a live refresh token once its account is suspended', async () => {
      mockJwtService.verifyAsync.mockResolvedValueOnce({
        sub: 'user-1',
        email: 'a@b.com',
        type: 'refresh',
      });
      mockUsersService.findById.mockResolvedValueOnce(
        buildUser({ suspendedAt: new Date('2026-11-01') }),
      );

      const attempt = service.refresh('refresh-token');

      // Stays a 403 through the catch that maps other errors to 401.
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toThrow('Account suspended');
      expect(mockJwtService.signAsync).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getProfile
  // ---------------------------------------------------------------------------
  describe('getProfile', () => {
    it('returns the sanitized user when found', async () => {
      mockUsersService.findById.mockResolvedValueOnce(buildUser());

      const result = await service.getProfile('user-1');

      expect(result).not.toHaveProperty('passwordHash');
      expect(result.email).toBe('a@b.com');
      expect(result.staffLinkPending).toBe(false);
    });

    it('throws UnauthorizedException when the user is missing', async () => {
      mockUsersService.findById.mockResolvedValueOnce(null);

      await expect(service.getProfile('user-1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // token generation expirations
  // ---------------------------------------------------------------------------
  describe('generateTokens (via completeSignup)', () => {
    it('passes access + refresh expirations from ConfigService to jwtService.signAsync', async () => {
      (mockedBcrypt.hash as jest.Mock).mockResolvedValueOnce('hashed');
      mockUsersService.create.mockResolvedValueOnce(buildUser());
      mockJwtService.signAsync
        .mockResolvedValueOnce('access')
        .mockResolvedValueOnce('refresh');

      await service.completeSignup(signupToken(), 'a-new-password');

      expect(mockJwtService.signAsync).toHaveBeenCalledTimes(2);
      expect(mockJwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'access',
          sub: 'user-1',
          email: 'a@b.com',
          session_max_age: 30 * 86_400,
        }),
        { expiresIn: '15m' },
      );
      // A new session is far from its limit, so the refresh lifetime decides, in seconds.
      expect(mockJwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'refresh', sub: 'user-1', email: 'a@b.com' }),
        { secret: 'test-refresh-secret-not-the-access-one', expiresIn: 7 * 86_400 },
      );
    });
  });

  describe('when recording an event fails', () => {
    it('still refuses an over-limit account without touching the password', async () => {
      mockEvents.recentLoginFailures.mockResolvedValueOnce(10);

      await expect(
        service.login({ email: 'a@b.com', password: 'pw' }),
      ).rejects.toMatchObject({ status: 429 });
      expect(mockUsersService.findByEmail).not.toHaveBeenCalled();
    });
  });
});
