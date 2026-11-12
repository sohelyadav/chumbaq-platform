import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MIN_SUPER_ADMIN_PASSKEYS,
  SecondFactorsService,
} from '../../auth/second-factors.service';
import { isStaffPrincipal } from '../../staff-auth/staff-principal';

/** Exact text the web client matches on, to send staff to set up their keys. */
export const PASSKEY_REQUIRED_MESSAGE = 'Staff access needs two passkeys and a passkey sign-in.';

/**
 * Apply after StaffJwtAuthGuard, which puts `user` on the request. Needs a staff
 * principal (so no customer token, impersonation included, can ever pass), the super
 * admin flag the strategy read from the database (compared to `true`), and a full
 * session rather than an enrolment-only one.
 *
 * With SUPER_ADMIN_PASSKEY_REQUIRED on, the session must also have shown a passkey and
 * the account must hold two staff keys. Off by default, so it is turned on once each
 * admin has their keys, rather than locking everyone out.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly secondFactors: SecondFactorsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<{ user?: unknown }>();
    if (
      !isStaffPrincipal(user) ||
      user.isSuperAdmin !== true ||
      user.impersonatedBy ||
      user.enrolmentOnly !== false
    ) {
      throw new ForbiddenException('Super admin access required');
    }
    if (this.config.get<boolean>('webauthn.superAdminPasskeyRequired')) {
      const shownPasskey = user.amr?.includes('webauthn') === true;
      if (
        !shownPasskey ||
        (await this.secondFactors.passkeyCount(user.userId, 'staff')) < MIN_SUPER_ADMIN_PASSKEYS
      ) {
        throw new ForbiddenException(PASSKEY_REQUIRED_MESSAGE);
      }
    }
    return true;
  }
}
