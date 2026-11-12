import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { AuthCookiesService } from './auth-cookies.service';
import { ClientHeaderGuard } from './guards/client-header.guard';
import { PasskeysController } from './passkeys.controller';
import type { PasskeysService } from './passkeys.service';

describe('PasskeysController', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const signedIn = () => ({
    user: { id: 'u' },
    tokens: { accessToken: 'access', refreshToken: jwt.sign({ sub: 'u' }, { expiresIn: '7d' }) },
  });
  const passkeys = {
    verifySecondFactor: jest.fn(async () => signedIn()),
    verifyPasswordless: jest.fn(async () => signedIn()),
  };
  const controller = new PasskeysController(
    passkeys as unknown as PasskeysService,
    new AuthCookiesService({ get: () => true } as unknown as ConfigService, jwt),
  );
  const req = { headers: {} } as Request;

  it.each([
    ['second factor', () => controller.verifySecondFactor({ handle: 'h', response: {} } as never, req, res)],
    ['passwordless', () => controller.verifyPasswordless({ flowId: 'f', response: {} } as never, req, res)],
  ])('%s puts the refresh token in the cookie and not the body', async (_name, call) => {
    (res.cookie as jest.Mock).mockClear();

    const body = await call();

    expect(body.tokens).toEqual({ accessToken: 'access' });
    expect(res.cookie).toHaveBeenCalledWith(
      'chumbaq_refresh',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', secure: true }),
    );
  });
});

const res = { cookie: jest.fn() } as unknown as Response;

describe('PasskeysController guards', () => {
  it.each(['verifySecondFactor', 'verifyPasswordless'] as const)(
    '%s needs the client header, since it sets the cookie',
    (handler) => {
      const guards = Reflect.getMetadata('__guards__', PasskeysController.prototype[handler]);
      expect(guards).toContain(ClientHeaderGuard);
    },
  );
});

describe('PasskeysController autofill', () => {
  // The throttler counts per handler, so a separate route is a separate allowance.
  it('is its own route with its own limit, so page loads cannot use up the button’s', () => {
    const limitOf = (handler: 'autofillOptions' | 'passwordlessOptions') =>
      Reflect.getMetadata('THROTTLER:LIMITdefault', PasskeysController.prototype[handler]);
    expect(limitOf('autofillOptions')).toBe(20);
    expect(limitOf('passwordlessOptions')).toBe(10);
  });

  it('sets no cookie, so needs no client header', () => {
    const guards = Reflect.getMetadata('__guards__', PasskeysController.prototype.autofillOptions);
    expect(guards ?? []).not.toContain(ClientHeaderGuard);
  });
});
