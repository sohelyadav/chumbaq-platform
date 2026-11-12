import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

export const RECENT_AUTH_WINDOW_SECONDS = 15 * 60;

/** Exact text the web client matches on, as it does for the other 403s it handles. */
export const REAUTH_REQUIRED_MESSAGE = 'Confirm it is you to continue.';

/**
 * For actions a stolen but live session should not reach. Goes after `JwtAuthGuard`.
 * A token with no `auth_time` is refused: not knowing when someone signed in is not
 * evidence that they did so recently. Impersonation tokens never carry one.
 */
@Injectable()
export class RecentAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    assertRecentAuth(user);
    return true;
  }
}

/** The guard's rule, for a route that needs it only for some requests. */
export function assertRecentAuth(user: AuthenticatedUser | undefined): void {
  const age = user?.authTime === undefined ? Infinity : Date.now() / 1000 - user.authTime;
  if (user?.impersonatedBy || age > RECENT_AUTH_WINDOW_SECONDS) {
    throw new ForbiddenException(REAUTH_REQUIRED_MESSAGE);
  }
}
