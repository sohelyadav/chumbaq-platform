import { UnauthorizedException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { UserEntity } from '../users/entities/user.entity';

export const SESSION_ENDED_MESSAGE = 'Session has been revoked';

/** The session adding a factor, as `JwtStrategy` built it from the access token. */
export interface EnrollingSession {
  userId: string;
  sessionId?: string;
  /** `sv` from the token. Absent on older tokens, read as 0, as `JwtStrategy` does. */
  sessionVersion?: number;
}

/**
 * Every check that the session is still the account's, made again inside the
 * transaction that adds a factor, after `findByIdForUpdate`. The proof and the guard
 * checked them before the lock, and a staff factor reset (`removeFactors`, which takes
 * the same lock) can commit in between: a request from a stolen session that waited on
 * the lock would then plant its factor after the reset and undo it.
 *
 * Under the lock the user row is the one the reset left, and a session it revoked reads
 * as revoked. `factors_reset_at` after the session began is checked too, in case a
 * reset ever ends sessions some other way than the version.
 */
export async function assertSessionStillCurrent(
  manager: EntityManager,
  locked: UserEntity | null,
  session: EnrollingSession,
): Promise<UserEntity> {
  const ended = () => new UnauthorizedException(SESSION_ENDED_MESSAGE);
  if (!locked || locked.id !== session.userId || !session.sessionId) throw ended();
  if ((session.sessionVersion ?? 0) !== locked.sessionVersion) throw ended();
  // Compared in SQL: a JS Date drops the microseconds both times carry.
  const [row] = await manager.query(
    `SELECT coalesce(u.factors_reset_at > s.created_at, false) AS before_reset
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL`,
    [session.sessionId, locked.id],
  );
  if (!row || row.before_reset) throw ended();
  return locked;
}
