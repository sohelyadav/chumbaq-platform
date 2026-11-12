import { createHash, randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';
import type { RequestContext } from '../auth-events/auth-events.service';
import { StaffSessionEntity } from './entities/staff-session.entity';
import { ROTATION_GRACE_MS } from './sessions.service';
import { DEFAULT_STAFF_SESSION_MAX_AGE_MS } from '../../config/staff.config';

export type StaffSessionRevokeReason =
  | 'signed_out'
  | 'replay'
  | 'staff_revoked'
  | 'factors_reset'
  | 'factor_changed'
  | 'enrolled'
  | 'idle'
  | 'expired'
  | 'session_version'
  /** A customer password reset: whoever reset it may hold only the mailbox. */
  | 'password_reset';

export interface StaffSessionLimits {
  idleMs: number;
  maxAgeMs: number;
}

export type StaffLiveness = 'live' | 'revoked' | 'idle' | 'expired';

export type StaffRotation =
  | {
      outcome: 'rotated' | 'retried';
      sessionId: string;
      userId: string;
      /**
       * The new token, or null for a retry within the grace period. Only hashes are
       * stored, so a retry cannot be handed the token the first refresh issued; it gets
       * an access token and leaves the cookie alone, and the first response's cookie
       * (two tabs refreshing at once) stands.
       */
      refreshToken: string | null;
      amr: string[];
      authenticatedAt: Date | null;
      createdAt: Date;
      sessionVersion: number;
    }
  | { outcome: 'revoked' | 'idle' | 'expired'; userId?: string; sessionId?: string }
  | { outcome: 'reused'; userId: string; sessionId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Once a minute is enough to tell 30 minutes of idleness, and spares a write per request. */
export const STAFF_TOUCH_INTERVAL_SECONDS = 60;

export const hashStaffToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** `<sessionId>.<32 random bytes>`: the id says which row to compare the hash with. */
const newRefreshToken = (sessionId: string) => `${sessionId}.${randomBytes(32).toString('base64url')}`;

const secs = (ms: number) => ms / 1000;

/**
 * Staff sessions on the admin app. The refresh token is opaque and only its sha256 is
 * stored. Idleness means no authenticated request: `StaffJwtStrategy` moves
 * `last_active_at`, refreshing never does, so an admin app left open (which refreshes on
 * its own) still ends after STAFF_IDLE_TIMEOUT. Age and idleness are judged by
 * Postgres's clock, the one that wrote the timestamps, in the same statement that acts.
 */
@Injectable()
export class StaffSessionsService {
  constructor(
    @InjectRepository(StaffSessionEntity)
    private readonly repository: Repository<StaffSessionEntity>,
    private readonly config: ConfigService,
  ) {}

  private get maxAgeMs(): number {
    return this.config.get<number>('staff.maxAgeMs') ?? DEFAULT_STAFF_SESSION_MAX_AGE_MS;
  }

  async create(
    userId: string,
    context: RequestContext,
    auth: { amr: string[]; authenticatedAt: Date },
    sessionVersion: number,
    enrolmentOnly: boolean,
  ): Promise<{ sessionId: string; refreshToken: string | null; createdAt: Date }> {
    const sessionId = randomUUID();
    // An enrolment session gets no refresh token: it lasts one short access token.
    const refreshToken = enrolmentOnly ? null : newRefreshToken(sessionId);
    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .into(StaffSessionEntity)
      .values({
        id: sessionId,
        userId,
        currentTokenHash: refreshToken ? hashStaffToken(refreshToken) : null,
        amr: auth.amr,
        authenticatedAt: auth.authenticatedAt,
        sessionVersion,
        enrolmentOnly,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 512) ?? null,
      })
      .returning('created_at')
      .execute();
    const [row] = result.raw as { created_at: Date }[];
    return { sessionId, refreshToken, createdAt: row.created_at };
  }

  /**
   * One conditional UPDATE, so of two refreshes with the same token exactly one rotates,
   * and neither can slip past the idle or age limit while the other decides it.
   */
  async rotate(refreshToken: string, limits: StaffSessionLimits): Promise<StaffRotation> {
    const [sessionId] = refreshToken.split('.', 1);
    if (!UUID.test(sessionId) || refreshToken.length > 200) return { outcome: 'revoked' };
    const presented = hashStaffToken(refreshToken);
    const next = newRefreshToken(sessionId);

    const result = await this.repository
      .createQueryBuilder()
      .update(StaffSessionEntity)
      .set({
        currentTokenHash: hashStaffToken(next),
        previousTokenHash: () => 'current_token_hash',
        rotatedAt: () => 'now()',
      })
      .where(
        `id = :sessionId AND current_token_hash = :presented AND revoked_at IS NULL
         AND enrolment_only = false
         AND created_at > now() - make_interval(secs => :maxAge)
         AND last_active_at > now() - make_interval(secs => :idle)`,
        { sessionId, presented, maxAge: secs(limits.maxAgeMs), idle: secs(limits.idleMs) },
      )
      .returning('user_id, amr, authenticated_at, created_at, session_version')
      .execute();
    if (result.affected) {
      const [row] = result.raw as {
        user_id: string;
        amr: string[];
        authenticated_at: Date | null;
        created_at: Date;
        session_version: number;
      }[];
      return {
        outcome: 'rotated',
        sessionId,
        userId: row.user_id,
        refreshToken: next,
        amr: row.amr,
        authenticatedAt: row.authenticated_at,
        createdAt: row.created_at,
        sessionVersion: row.session_version,
      };
    }

    const [row] = (await this.repository.query(
      `SELECT user_id, amr, authenticated_at, created_at, session_version, enrolment_only,
              revoked_at IS NOT NULL AS revoked,
              current_token_hash = $2 AS is_current,
              previous_token_hash = $2 AS is_previous,
              previous_token_hash = $2 AND rotated_at > now() - make_interval(secs => $5) AS in_grace,
              created_at <= now() - make_interval(secs => $3) AS expired,
              last_active_at <= now() - make_interval(secs => $4) AS idle
         FROM staff_sessions WHERE id = $1`,
      [sessionId, presented, secs(limits.maxAgeMs), secs(limits.idleMs), secs(ROTATION_GRACE_MS)],
    )) as {
      user_id: string;
      amr: string[];
      authenticated_at: Date | null;
      created_at: Date;
      session_version: number;
      enrolment_only: boolean;
      revoked: boolean;
      is_current: boolean | null;
      is_previous: boolean | null;
      in_grace: boolean | null;
      expired: boolean;
      idle: boolean;
    }[];
    // A token that matches nothing on the row is no token of ours: it says nothing about
    // who holds the real one, so it ends nothing either.
    if (!row || row.revoked || row.enrolment_only || !(row.is_current || row.is_previous)) {
      return { outcome: 'revoked', userId: row?.user_id, sessionId };
    }
    if (row.expired) {
      await this.revoke(sessionId, row.user_id, 'expired');
      return { outcome: 'expired', userId: row.user_id, sessionId };
    }
    if (row.idle) {
      await this.revoke(sessionId, row.user_id, 'idle');
      return { outcome: 'idle', userId: row.user_id, sessionId };
    }
    if (row.in_grace) {
      return {
        outcome: 'retried',
        sessionId,
        userId: row.user_id,
        refreshToken: null,
        amr: row.amr,
        authenticatedAt: row.authenticated_at,
        createdAt: row.created_at,
        sessionVersion: row.session_version,
      };
    }
    // The replaced token, after its grace: two parties hold this session's tokens.
    await this.revoke(sessionId, row.user_id, 'replay');
    return { outcome: 'reused', userId: row.user_id, sessionId };
  }

  /**
   * For every authenticated request. One indexed read; the limits for an enrolment
   * session are its own short lifetime.
   */
  async checkLive(
    sessionId: string,
    userId: string,
    limits: StaffSessionLimits,
    enrolmentOnly = false,
  ): Promise<StaffLiveness> {
    const [row] = (await this.repository.query(
      `SELECT revoked_at IS NOT NULL AS revoked, enrolment_only,
              created_at <= now() - make_interval(secs => $3) AS expired,
              last_active_at <= now() - make_interval(secs => $4) AS idle
         FROM staff_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId, secs(limits.maxAgeMs), secs(limits.idleMs)],
    )) as { revoked: boolean; enrolment_only: boolean; expired: boolean; idle: boolean }[];
    // The token's claim must agree with the row, or a full token could be minted for an
    // enrolment session (or the reverse) by a bug elsewhere and go unnoticed.
    if (!row || row.revoked || row.enrolment_only !== enrolmentOnly) return 'revoked';
    if (row.expired) return 'expired';
    if (row.idle) return 'idle';
    return 'live';
  }

  /** Moves `last_active_at` at most once a minute, so a busy session is not a write per request. */
  async touch(sessionId: string): Promise<void> {
    await this.repository.query(
      `UPDATE staff_sessions SET last_active_at = now()
        WHERE id = $1 AND revoked_at IS NULL
          AND last_active_at < now() - make_interval(secs => $2)`,
      [sessionId, STAFF_TOUCH_INTERVAL_SECONDS],
    );
  }

  /**
   * Whether a view-as started from this session may go on: not ended and within its
   * absolute end. Idleness is not checked, since the staff member is now working in the
   * customer app, where the admin app sees none of their requests.
   */
  isUsable(sessionId: string, userId: string): Promise<boolean> {
    return this.repository
      .query(
        `SELECT 1 FROM staff_sessions
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND enrolment_only = false
            AND created_at > now() - make_interval(secs => $3)`,
        [sessionId, userId, secs(this.maxAgeMs)],
      )
      .then((rows: unknown[]) => rows.length > 0);
  }

  /**
   * For a write that must not outlive the session (a view-as code), inside its
   * transaction: whether the session is still a full, unrevoked one of this person within
   * its absolute end, holding the row FOR SHARE until commit. FOR SHARE, not FOR KEY
   * SHARE, because it must conflict with a revoke's UPDATE: a revoke already under way
   * makes this wait and then see it revoked, and one arriving after waits for this commit,
   * so its sweep of unused codes sees what was written here.
   */
  async lockUsable(manager: EntityManager, sessionId: string, userId: string): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM staff_sessions
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND enrolment_only = false
          AND created_at > now() - make_interval(secs => $3)
        FOR SHARE`,
      [sessionId, userId, secs(this.maxAgeMs)],
    )) as unknown[];
    return rows.length > 0;
  }

  /** A fresh proof of identity. Null if the session has ended. */
  async markAuthenticated(
    sessionId: string,
    userId: string,
    method: 'webauthn' | 'totp',
  ): Promise<{ amr: string[]; authenticatedAt: Date; createdAt: Date } | null> {
    const result = await this.repository
      .createQueryBuilder()
      .update(StaffSessionEntity)
      .set({
        authenticatedAt: () => 'now()',
        lastActiveAt: () => 'now()',
        amr: () => `CASE WHEN amr @> CAST(:factor AS jsonb) THEN amr ELSE amr || CAST(:factor AS jsonb) END`,
      })
      .where('id = :sessionId AND user_id = :userId AND revoked_at IS NULL AND enrolment_only = false', {
        sessionId,
        userId,
      })
      .setParameter('factor', JSON.stringify([method]))
      .returning('amr, authenticated_at, created_at')
      .execute();
    if (!result.affected) return null;
    const [row] = result.raw as { amr: string[]; authenticated_at: Date; created_at: Date }[];
    return { amr: row.amr, authenticatedAt: row.authenticated_at, createdAt: row.created_at };
  }

  find(sessionId: string, userId: string): Promise<StaffSessionEntity | null> {
    return this.repository.findOne({ where: { id: sessionId, userId } });
  }

  /** False if there was no such session, or it had already ended. */
  async revoke(
    sessionId: string,
    userId: string,
    reason: StaffSessionRevokeReason,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repository = manager?.getRepository(StaffSessionEntity) ?? this.repository;
    const result = await repository.update(
      { id: sessionId, userId, revokedAt: IsNull() },
      { revokedAt: () => 'now()', revokedReason: reason },
    );
    await deleteUnusedHandoffsOfEndedSessions(manager ?? this.repository.manager, userId);
    return (result.affected ?? 0) > 0;
  }

  revokeAll(userId: string, reason: StaffSessionRevokeReason, manager?: EntityManager): Promise<number> {
    return revokeAllStaffSessions(manager ?? this.repository.manager, userId, reason);
  }

  async revokeOthers(
    userId: string,
    keepSessionId: string,
    reason: StaffSessionRevokeReason,
    manager?: EntityManager,
  ): Promise<number> {
    const repository = manager?.getRepository(StaffSessionEntity) ?? this.repository;
    const result = await repository.update(
      { userId, revokedAt: IsNull(), id: Not(keepSessionId) },
      { revokedAt: () => 'now()', revokedReason: reason },
    );
    await deleteUnusedHandoffsOfEndedSessions(manager ?? this.repository.manager, userId);
    return result.affected ?? 0;
  }
}

/**
 * For callers that hold only a transaction (`removeFactors`, the CLI), in the same
 * statement form as the service.
 */
export async function revokeAllStaffSessions(
  manager: EntityManager,
  userId: string,
  reason: StaffSessionRevokeReason,
): Promise<number> {
  const result = await manager.update(
    StaffSessionEntity,
    { userId, revokedAt: IsNull() },
    { revokedAt: () => 'now()', revokedReason: reason },
  );
  await deleteUnusedHandoffsOfEndedSessions(manager, userId);
  return result.affected ?? 0;
}

/**
 * Every revoke path ends with this. A view-as code made in a session that has ended can
 * never be exchanged (the exchange rechecks the session), so it should not sit in the
 * table either. Used codes stay, as the record of a view-as that happened. Per person,
 * so it also sweeps codes of that person's sessions that ended some other way.
 */
export async function deleteUnusedHandoffsOfEndedSessions(manager: EntityManager, userId: string): Promise<void> {
  await manager.query(
    `DELETE FROM impersonation_handoffs h USING staff_sessions s
      WHERE h.staff_session_id = s.id AND s.user_id = $1
        AND s.revoked_at IS NOT NULL AND h.used_at IS NULL`,
    [userId],
  );
}
