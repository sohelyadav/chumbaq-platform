import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SecondFactorsService } from '../../auth/second-factors.service';
import { PASSKEY_REQUIRED_MESSAGE, SuperAdminGuard } from './super-admin.guard';

const contextFor = (user: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const scopesAsked: string[] = [];
const guardWith = (required: boolean, passkeys = 2) =>
  new SuperAdminGuard(
    { get: () => required } as unknown as ConfigService,
    {
      passkeyCount: async (_userId: string, scope: string) => {
        scopesAsked.push(scope);
        return passkeys;
      },
    } as unknown as SecondFactorsService,
  );

/** What StaffJwtStrategy puts on the request for a full staff session. */
const staff = (over: Record<string, unknown> = {}) => ({
  kind: 'staff',
  userId: 'u',
  isSuperAdmin: true,
  sessionId: 's',
  sessionVersion: 0,
  amr: ['webauthn', 'uv'],
  enrolmentOnly: false,
  ...over,
});

describe('SuperAdminGuard', () => {
  const guard = guardWith(false);

  it('allows a staff session of a super admin', async () => {
    await expect(guard.canActivate(contextFor(staff()))).resolves.toBe(true);
  });

  it.each([
    ['no user', undefined],
    ['a plain tenant', staff({ isSuperAdmin: false })],
    ['a user object from before the flag existed', staff({ isSuperAdmin: undefined })],
    ['a truthy value that is not the flag', staff({ isSuperAdmin: 'true' })],
    ['a super admin impersonating', staff({ impersonatedBy: 'admin' })],
    // What the customer JwtStrategy builds: a super admin's customer session is not staff.
    ['a customer session of a super admin', { userId: 'u', isSuperAdmin: true, amr: ['webauthn'] }],
    ['an enrolment-only staff session', staff({ enrolmentOnly: true })],
    ['a principal that does not say whether it is enrolment-only', staff({ enrolmentOnly: undefined })],
  ])('refuses %s', async (_label, user) => {
    await expect(guard.canActivate(contextFor(user))).rejects.toThrow(ForbiddenException);
  });

  describe('with passkeys required', () => {
    const admin = (amr?: string[]) => contextFor(staff({ amr }));

    it('allows a session that showed a passkey, on an account with two staff keys', async () => {
      scopesAsked.length = 0;
      await expect(guardWith(true).canActivate(admin(['pwd', 'webauthn']))).resolves.toBe(true);
      await expect(guardWith(true).canActivate(admin(['webauthn', 'uv']))).resolves.toBe(true);
      // Customer keys belong to the customer app's relying party and cannot sign in here.
      expect(scopesAsked).toEqual(['staff', 'staff']);
    });

    it.each([
      ['a password session, however many keys', guardWith(true, 5), ['pwd']],
      ['a token from before amr existed', guardWith(true), undefined],
      ['an account with one key', guardWith(true, 1), ['pwd', 'webauthn']],
      ['an account with none', guardWith(true, 0), ['webauthn', 'uv']],
    ])('refuses %s', async (_label, subject, amr) => {
      await expect(subject.canActivate(admin(amr))).rejects.toThrow(
        new ForbiddenException(PASSKEY_REQUIRED_MESSAGE),
      );
    });

    it('does not ask a tenant for any of this', async () => {
      await expect(
        guardWith(true).canActivate(contextFor(staff({ isSuperAdmin: false }))),
      ).rejects.toThrow('Super admin access required');
    });
  });
});
