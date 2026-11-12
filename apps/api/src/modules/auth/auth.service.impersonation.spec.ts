import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { UserEntity } from '../users/entities/user.entity';
import { SessionsService } from './sessions.service';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthEventsService } from '../auth-events/auth-events.service';

const SECRET = 'test-secret';

describe('AuthService.refresh and impersonation tokens', () => {
  const user = {
    id: 'tenant-id',
    email: 'tenant@example.com',
    suspendedAt: null,
    sessionVersion: 0,
  } as UserEntity;
  const findById = jest.fn(async (id: string) => (id === user.id ? user : null));
  const jwt = new JwtService({ secret: SECRET });
  const service = new AuthService(
    { findById } as unknown as UsersService,
    jwt,
    {
      get: (key: string, fallback?: string) =>
        key === 'jwt.refreshSecret' ? 'test-refresh-secret-not-the-access-one' : key === 'jwt.secret' ? SECRET : fallback,
    } as unknown as ConfigService,
    {
      create: async () => ({ sessionId: 'session-1', jti: 'jti-1', createdAt: new Date() }),
      rotate: async () => ({
        outcome: 'rotated',
        jti: 'jti-2',
        amr: ['pwd'],
        authenticatedAt: null,
        createdAt: new Date(),
      }),
    } as unknown as SessionsService,
    { record: async () => undefined } as unknown as AuthEventsService,
    { sendVerificationAfterRegister: () => undefined } as unknown as AccountRecoveryService,
    {} as never,
    { methodsFor: async () => [], hasAnyPasskey: async () => false } as never,
    { inBackground: () => undefined, sessionReplayed: () => undefined } as never,
    { cancelOnFactorUse: async () => undefined, voidStaffLinksOnSignIn: async () => false, staffLinkPending: async () => false } as never, { findAccount: async () => null, trippedAccount: async () => undefined } as never);
  const REFRESH_SECRET = 'test-refresh-secret-not-the-access-one';
  const sign = (type: 'access' | 'refresh', extra: object = {}, secret = REFRESH_SECRET) =>
    jwt.signAsync({ sub: user.id, email: user.email, type, ...extra }, { expiresIn: '5m', secret });

  beforeEach(() => findById.mockClear());

  // The control: without it, the refusal below could be the secret or the
  // signature being wrong rather than the token type.
  it('exchanges an ordinary refresh token signed the same way', async () => {
    const tokens = await service.refresh(await sign('refresh', { sid: 'session-1', jti: 'jti-1' }));
    expect(tokens.refreshToken).toEqual(expect.any(String));
  });

  it('refuses an impersonation token: it is signed with the access key', async () => {
    const token = await sign('access', { imp: 'actor-id' }, SECRET);

    await expect(service.refresh(token)).rejects.toThrow(
      new UnauthorizedException('Invalid or expired refresh token'),
    );
    expect(findById).not.toHaveBeenCalled();
  });

  it('refuses a token typed access even under the refresh key', async () => {
    const token = await sign('access', { imp: 'actor-id' });

    await expect(service.refresh(token)).rejects.toThrow(
      new UnauthorizedException('Invalid refresh token'),
    );
    expect(findById).not.toHaveBeenCalled();
  });

  it('refuses a refresh token signed with the access key', async () => {
    await expect(service.refresh(await sign('refresh', {}, SECRET))).rejects.toThrow(
      new UnauthorizedException('Invalid or expired refresh token'),
    );
  });
});
