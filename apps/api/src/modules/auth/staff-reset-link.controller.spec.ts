import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { REAUTH_REQUIRED_MESSAGE, RecentAuthGuard } from './guards/recent-auth.guard';
import { StaffResetLinkController } from './staff-reset-link.controller';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

const owner: AuthenticatedUser = {
  userId: 'owner-1',
  email: 'owner@x.test',
  authTime: Math.floor(Date.now() / 1000),
} as AuthenticatedUser;
const req = { headers: { 'user-agent': 'test' }, socket: {} } as never;

describe('StaffResetLinkController', () => {
  // A stolen session must not be able to cancel the real owner's recovery link, so the
  // route needs a sign-in in the last 15 minutes, as other account changes do.
  it('needs a session and a recent re-authentication', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StaffResetLinkController)).toEqual([JwtAuthGuard, RecentAuthGuard]);
  });

  it('sends an old sign-in to re-authenticate first', () => {
    const stale = { ...owner, authTime: Math.floor(Date.now() / 1000) - 16 * 60 };
    const context = { switchToHttp: () => ({ getRequest: () => ({ user: stale }) }) } as ExecutionContext;
    expect(() => new RecentAuthGuard().canActivate(context)).toThrow(REAUTH_REQUIRED_MESSAGE);
  });

  it('refuses staff looking through the account, cancelling nothing', async () => {
    const cancelStaffLinksByOwner = jest.fn();
    const controller = new StaffResetLinkController({ cancelStaffLinksByOwner } as never);
    await expect(controller.cancel({ ...owner, impersonatedBy: 'staff-1' }, req)).rejects.toThrow(ForbiddenException);
    expect(cancelStaffLinksByOwner).not.toHaveBeenCalled();
  });

  it('cancels for the caller and says how many links it spent', async () => {
    const cancelStaffLinksByOwner = jest.fn(async () => 1);
    const controller = new StaffResetLinkController({ cancelStaffLinksByOwner } as never);
    await expect(controller.cancel(owner, req)).resolves.toEqual({ cancelled: 1 });
    expect(cancelStaffLinksByOwner).toHaveBeenCalledWith(owner, expect.objectContaining({ userAgent: 'test' }));
  });
});
