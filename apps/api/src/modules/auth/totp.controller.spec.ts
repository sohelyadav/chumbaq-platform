import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { AuthCookiesService } from './auth-cookies.service';
import { ClientHeaderGuard } from './guards/client-header.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RecentAuthGuard } from './guards/recent-auth.guard';
import type { AuthenticatedUser } from './strategies/jwt.strategy';
import { TotpController } from './totp.controller';
import type { TotpService } from './totp.service';

const guardsOf = (method: keyof TotpController): unknown[] =>
  Reflect.getMetadata(GUARDS_METADATA, TotpController.prototype[method]) ?? [];

describe('TotpController', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const signedIn = () => ({
    user: { id: 'u' },
    tokens: { accessToken: 'access', refreshToken: jwt.sign({ sub: 'u' }, { expiresIn: '7d' }) },
  });
  const totp = {
    status: jest.fn(async () => ({})),
    verifyTotpSignIn: jest.fn(async () => signedIn()),
    verifyRecoverySignIn: jest.fn(async () => signedIn()),
  };
  const controller = new TotpController(
    totp as unknown as TotpService,
    new AuthCookiesService({ get: () => true } as unknown as ConfigService, jwt),
  );
  const req = { headers: {} } as Request;
  const res = { cookie: jest.fn() } as unknown as Response;

  it.each(['setup', 'confirm', 'disable', 'regenerate'] as const)(
    '%s needs a session and a recent sign-in',
    (method) => {
      expect(guardsOf(method)).toEqual([JwtAuthGuard, RecentAuthGuard]);
    },
  );

  it.each(['verifySignIn', 'verifyRecoverySignIn'] as const)(
    '%s sets a cookie, so needs the client header',
    (method) => {
      expect(guardsOf(method)).toEqual([ClientHeaderGuard]);
    },
  );

  it.each(['reauth', 'reauthWithRecoveryCode', 'status'] as const)('%s needs a session', (method) => {
    expect(guardsOf(method)).toEqual([JwtAuthGuard]);
  });

  it.each([
    ['code', () => controller.verifySignIn({ handle: 'h', code: '1' }, req, res)],
    ['recovery code', () => controller.verifyRecoverySignIn({ handle: 'h', code: '1' }, req, res)],
  ])('a %s sign-in puts the refresh token in the cookie and not the body', async (_name, call) => {
    const body = await call();
    expect(body.tokens).toEqual({ accessToken: 'access' });
    expect(res.cookie).toHaveBeenCalledWith(
      'chumbaq_refresh',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'strict' }),
    );
  });

  it('shows staff viewing as a tenant nothing of how the tenant signs in', () => {
    const viewing = { userId: 'u', impersonatedBy: 'admin' } as unknown as AuthenticatedUser;
    expect(() => controller.status(viewing)).toThrow(ForbiddenException);
    expect(totp.status).not.toHaveBeenCalled();
  });
});
