import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOW_ENROLMENT_SESSION } from './allow-enrolment-session.decorator';
import type { AuthenticatedStaff } from './staff-principal';
import { STAFF_ENROLMENT_ONLY_MESSAGE } from './staff-messages';

/**
 * Every authenticated route on the admin API. Refuses an enrolment-only session unless
 * the handler or its controller says `@AllowEnrolmentSession()`: default deny, because
 * that session comes from a password alone.
 */
@Injectable()
export class StaffJwtAuthGuard extends AuthGuard('staff-jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedStaff }>();
    if (user?.enrolmentOnly) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_ENROLMENT_SESSION, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) throw new ForbiddenException(STAFF_ENROLMENT_ONLY_MESSAGE);
    }
    return true;
  }
}
