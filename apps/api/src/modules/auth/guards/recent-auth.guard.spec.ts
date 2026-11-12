import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  REAUTH_REQUIRED_MESSAGE,
  RECENT_AUTH_WINDOW_SECONDS,
  RecentAuthGuard,
} from './recent-auth.guard';

const contextFor = (user: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

const secondsAgo = (seconds: number) => Math.floor(Date.now() / 1000) - seconds;

describe('RecentAuthGuard', () => {
  const guard = new RecentAuthGuard();

  it('lets a recent sign-in through', () => {
    expect(guard.canActivate(contextFor({ authTime: secondsAgo(RECENT_AUTH_WINDOW_SECONDS - 5) }))).toBe(true);
  });

  it.each([
    ['too old', { authTime: secondsAgo(RECENT_AUTH_WINDOW_SECONDS + 5) }],
    ['unknown, as on a token from before this existed', {}],
    ['impersonating, however recent', { authTime: secondsAgo(1), impersonatedBy: 'admin' }],
    ['no user at all', undefined],
  ])('refuses %s', (_name, user) => {
    expect(() => guard.canActivate(contextFor(user))).toThrow(
      new ForbiddenException(REAUTH_REQUIRED_MESSAGE),
    );
  });
});
