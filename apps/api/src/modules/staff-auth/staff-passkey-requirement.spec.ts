import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { StaffAuthService } from './staff-auth.service';
import { StaffFactorsService } from './staff-factors.service';
import type { AuthenticatedStaff } from './staff-principal';
import { STAFF_ENROLMENT_BLOCKED_MESSAGE, STAFF_PASSKEY_NEEDED_MESSAGE } from './staff-messages';

/**
 * While passkeys are required for staff, an authenticator app must not sign in,
 * re-authenticate, or vouch for a new staff factor. Otherwise a password plus phished
 * codes could re-authenticate, add a passkey of the attacker's, re-authenticate with
 * it, add a second, and pass SuperAdminGuard.
 */

const config = (required: boolean) =>
  ({ get: (path: string) => (path === 'webauthn.superAdminPasskeyRequired' ? required : undefined) }) as any;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function staff(over: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff {
  return {
    userId: 'u1',
    email: 'staff@example.com',
    kind: 'staff',
    isSuperAdmin: true,
    sessionId: 's1',
    sessionVersion: 1,
    amr: ['pwd', 'totp'],
    enrolmentOnly: false,
    authTime: nowSeconds(),
    ...over,
  } as AuthenticatedStaff;
}

describe('StaffFactorsService.assertMayAdd while passkeys are required', () => {
  function build(required: boolean) {
    const proofs = { spend: jest.fn().mockResolvedValue(undefined), assertHeld: jest.fn().mockResolvedValue(undefined) };
    const none = {} as any;
    const service = new StaffFactorsService(
      none, none, none, none, none, none, proofs as any, none, none, none, none, config(required),
    );
    return { service, proofs };
  }

  it.each(['webauthn', 'totp'] as const)(
    'refuses a session that only ever showed a password and an authenticator code from adding %s',
    async (factor) => {
      const { service, proofs } = build(true);
      await expect(service.assertMayAdd(staff({ amr: ['pwd', 'totp'] }), true, factor)).rejects.toThrow(
        new ForbiddenException(STAFF_PASSKEY_NEEDED_MESSAGE),
      );
      expect(proofs.spend).not.toHaveBeenCalled();
    },
  );

  it.each(['webauthn', 'totp'] as const)('lets a session that showed a passkey add %s', async (factor) => {
    const { service, proofs } = build(true);
    await service.assertMayAdd(staff({ amr: ['pwd', 'webauthn'] }), true, factor);
    expect(proofs.spend).toHaveBeenCalledWith({ userId: 'u1', sessionId: 's1', audience: 'staff' });
  });

  it('lets an enrolment session (an operator code) add a passkey', async () => {
    const { service } = build(true);
    await expect(
      service.assertMayAdd(staff({ amr: ['pwd'], enrolmentOnly: true }), true, 'webauthn'),
    ).resolves.toBeUndefined();
  });

  it('does not let an enrolment session add an authenticator app, which could not then sign in', async () => {
    const { service } = build(true);
    await expect(service.assertMayAdd(staff({ amr: ['pwd'], enrolmentOnly: true }), false, 'totp')).rejects.toThrow(
      STAFF_PASSKEY_NEEDED_MESSAGE,
    );
  });

  it('leaves the authenticator app a staff factor when passkeys are not required', async () => {
    const { service, proofs } = build(false);
    await service.assertMayAdd(staff({ amr: ['pwd', 'totp'] }), true, 'webauthn');
    expect(proofs.spend).toHaveBeenCalled();
  });
});

describe('StaffAuthService while passkeys are required', () => {
  const PASSWORD = 'correct horse battery staple';

  async function build(required: boolean, methods: Array<'webauthn' | 'totp'>) {
    const user = {
      id: 'u1',
      email: 'staff@example.com',
      isSuperAdmin: true,
      suspendedAt: null,
      sessionVersion: 1,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    };
    const deps = {
      users: { findByEmail: jest.fn().mockResolvedValue(user), findById: jest.fn().mockResolvedValue(user) },
      auth: { assertUnderLoginLimit: jest.fn().mockResolvedValue(undefined) },
      events: { record: jest.fn().mockResolvedValue(undefined) },
      preAuth: {
        create: jest.fn().mockResolvedValue('handle-1'),
        peekFor: jest.fn().mockResolvedValue({ userId: 'u1' }),
      },
      secondFactors: {
        staffMethodsFor: jest.fn().mockResolvedValue(methods),
        hasAnyPasskey: jest.fn().mockResolvedValue(methods.includes('webauthn')),
      },
      totp: { acceptCode: jest.fn().mockResolvedValue(true) },
      audit: { record: jest.fn().mockResolvedValue(undefined) },
      alarms: { failedLater: jest.fn() },
    };
    const none = {} as any;
    const service = new StaffAuthService(
      deps.users as any,
      deps.auth as any,
      deps.events as any,
      deps.preAuth as any,
      deps.secondFactors as any,
      none,
      deps.alarms as any,
      none,
      deps.totp as any,
      none,
      deps.audit as any,
      none,
      none,
      config(required),
      none,
    );
    return { service, deps };
  }

  it('does not offer the authenticator app after the password', async () => {
    const { service } = await build(true, ['webauthn', 'totp']);
    await expect(service.login('staff@example.com', PASSWORD)).resolves.toMatchObject({
      step: 'second_factor',
      methods: ['webauthn'],
    });
  });

  it('sends someone whose only staff factor is an authenticator app to the operator enrolment code', async () => {
    const { service, deps } = await build(true, ['totp']);
    await expect(service.login('staff@example.com', PASSWORD)).rejects.toThrow(
      new ForbiddenException(STAFF_ENROLMENT_BLOCKED_MESSAGE),
    );
    expect(deps.preAuth.create).not.toHaveBeenCalled();
  });

  it('refuses an authenticator code at sign-in before the code is tried', async () => {
    const { service, deps } = await build(true, ['webauthn', 'totp']);
    await expect(service.loginWithTotp('handle-1', '123456')).rejects.toThrow(
      new UnauthorizedException(STAFF_PASSKEY_NEEDED_MESSAGE),
    );
    expect(deps.totp.acceptCode).not.toHaveBeenCalled();
  });

  it('refuses re-authentication with an authenticator code, so no factor-change proof is left', async () => {
    const { service, deps } = await build(true, ['webauthn', 'totp']);
    await expect(service.reauthWithTotp(staff(), '123456')).rejects.toThrow(
      new ForbiddenException(STAFF_PASSKEY_NEEDED_MESSAGE),
    );
    expect(deps.totp.acceptCode).not.toHaveBeenCalled();
  });

  it('still offers the authenticator app when passkeys are not required', async () => {
    const { service } = await build(false, ['webauthn', 'totp']);
    await expect(service.login('staff@example.com', PASSWORD)).resolves.toMatchObject({
      methods: ['webauthn', 'totp'],
    });
  });
});
