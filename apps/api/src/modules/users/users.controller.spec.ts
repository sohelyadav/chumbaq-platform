import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersController } from './users.controller';

/** The current password on the change route is a guess, held to the sign-in limit. */
describe('UsersController.changePassword and the sign-in failure limit', () => {
  const req = { headers: { 'user-agent': 'ua' }, socket: {} } as never;

  async function build(limited: boolean) {
    const user = { id: 'u1', email: 'owner@example.com', passwordHash: await bcrypt.hash('right-password', 4) };
    const users = { findById: jest.fn(async () => user), changeOwnPassword: jest.fn() };
    const events = { record: jest.fn() };
    const auth = {
      assertUnderLoginLimit: jest.fn(async () => {
        if (limited) throw new HttpException('Too many failed attempts.', HttpStatus.TOO_MANY_REQUESTS);
      }),
    };
    const controller = new UsersController(
      users as never,
      events as never,
      { passwordChangedByOwner: jest.fn() } as never,
      { voidStaffLinksOnSignIn: jest.fn(async () => false) } as never,
      auth as never,
    );
    return { controller, users, events, auth };
  }

  it('records a wrong current password as a failed sign-in', async () => {
    const { controller, events } = await build(false);
    await expect(
      controller.changePassword('u1', { currentPassword: 'guess', newPassword: 'new-password-1' } as never, req),
    ).rejects.toThrow(UnauthorizedException);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'login.failed', email: 'owner@example.com', reason: 'wrong_password' }),
    );
  });

  it('refuses before trying the password once the address is over the limit', async () => {
    const { controller, users } = await build(true);
    await expect(
      controller.changePassword('u1', { currentPassword: 'right-password', newPassword: 'new-password-1' } as never, req),
    ).rejects.toMatchObject({ status: 429 });
    expect(users.changeOwnPassword).not.toHaveBeenCalled();
  });
});
