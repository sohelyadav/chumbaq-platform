import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { assertRecentAuth, REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { isStaffPrincipal } from './staff-principal';

/**
 * `RecentAuthGuard` for the admin API: the same 15 minutes and the same message, against
 * the staff session's `auth_time`. Goes after `StaffJwtAuthGuard`. Refuses anything that
 * is not a staff principal, so it cannot be satisfied by a customer token's `auth_time`
 * even if a route were wired wrongly.
 */
@Injectable()
export class StaffRecentAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{ user?: unknown }>();
    if (!isStaffPrincipal(user)) throw new ForbiddenException(REAUTH_REQUIRED_MESSAGE);
    assertRecentAuth(user);
    return true;
  }
}
