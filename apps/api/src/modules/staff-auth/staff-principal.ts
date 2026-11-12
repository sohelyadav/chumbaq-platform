import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

/**
 * Who a staff request is from, as `StaffJwtStrategy` built it. Structurally an
 * `AuthenticatedUser`, so `@CurrentUser()`, `assertRecentAuth` and the admin services
 * work unchanged; `kind` is what `SuperAdminGuard` checks, so a customer principal can
 * never pass for this one. `impersonatedBy` is never set.
 */
export interface AuthenticatedStaff extends AuthenticatedUser {
  kind: 'staff';
  isSuperAdmin: true;
  sessionId: string;
  sessionVersion: number;
  amr: string[];
  enrolmentOnly: boolean;
  /** The access token's `exp`, in seconds, for the session info the admin app shows. */
  accessExp?: number;
}

export const isStaffPrincipal = (user: unknown): user is AuthenticatedStaff =>
  (user as AuthenticatedStaff | undefined)?.kind === 'staff';
