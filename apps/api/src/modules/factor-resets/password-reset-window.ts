import { EntityManager } from 'typeorm';

/**
 * Whoever holds the mailbox can reset the password, and with the factors gone too they
 * would own the account. So, in either order, the two must not come this close together:
 * a password reset this recent stops a factor reset unless staff justify it, and a
 * completed factor reset this recent stops any password reset by email or team admin.
 */
export const PASSWORD_RESET_WINDOW_DAYS = 14;

/** The shortest justification accepted for removing factors soon after a password reset. */
export const RECENT_RESET_JUSTIFICATION_MIN = 10;
export const RECENT_RESET_JUSTIFICATION_MAX = 500;

export interface LastPasswordReset {
  at: Date | null;
  /** Inside `PASSWORD_RESET_WINDOW_DAYS`, by the database's clock. */
  recent: boolean;
}

/**
 * The latest password reset by any route. From `users.password_reset_at`, which is
 * written with the new password, not from `auth_events`, which is written after it
 * commits and may be lost. Shared by the panel's `request` and both CLI resets, so
 * none of them can be the easier way round. Call it with the user row already locked,
 * so a reset cannot slip in between.
 */
export async function lastPasswordReset(manager: EntityManager, userId: string): Promise<LastPasswordReset> {
  const [row] = await manager.query(
    `SELECT password_reset_at AS at,
            coalesce(password_reset_at > now() - make_interval(days => $2), false) AS recent
       FROM users
      WHERE id = $1`,
    [userId, PASSWORD_RESET_WINDOW_DAYS],
  );
  return { at: row?.at ? new Date(row.at) : null, recent: Boolean(row?.recent) };
}

/**
 * When staff last removed the user's factors, if within `PASSWORD_RESET_WINDOW_DAYS`
 * (`users.factors_reset_at`), else null. Password resets by email and team are refused
 * then (`passwordResetBlockedSince`), and `admin:password-reset-link` needs its own
 * justification. Call with the user row already locked, so a factor reset completing
 * at the same moment is either seen here or waits.
 */
export async function recentFactorReset(manager: EntityManager, userId: string): Promise<Date | null> {
  const [row] = await manager.query(
    `SELECT factors_reset_at AS at
       FROM users
      WHERE id = $1 AND factors_reset_at > now() - make_interval(days => $2)`,
    [userId, PASSWORD_RESET_WINDOW_DAYS],
  );
  return row?.at ? new Date(row.at) : null;
}
