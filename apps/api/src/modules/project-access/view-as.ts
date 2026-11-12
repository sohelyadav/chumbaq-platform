import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

/** The text JwtStrategy uses for the same refusal, which the dashboard matches. */
export const IMPERSONATION_READ_ONLY = 'Impersonation sessions are read-only';

/** The text identity's do-not-track routes refuse view-as with today, kept as it is. */
export const VIEW_AS_NOT_AVAILABLE = 'Not available while viewing as another account';

/**
 * Refuses staff viewing as a tenant, for the routes that stay refused even when they
 * are reads (exporting a person's data is not "viewing"). `message` keeps a route's
 * existing text: identity passes `VIEW_AS_NOT_AVAILABLE`.
 */
export function refuseViewAs(user: AuthenticatedUser, message: string = IMPERSONATION_READ_ONLY): void {
  if (user?.impersonatedBy) throw new ForbiddenException(message);
}
