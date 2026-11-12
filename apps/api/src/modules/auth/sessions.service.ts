import { randomUUID } from 'crypto';
import UAParser = require('ua-parser-js');
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Not, Repository } from 'typeorm';
import type { RequestContext } from '../auth-events/auth-events.service';
import { AuthSessionEntity } from './entities/auth-session.entity';

/**
 * Two tabs can refresh at once, and a response can be lost on the network, so the
 * token just replaced still works this long. Past it, a replay means two parties
 * hold the same token, and one of them should not.
 */
export const ROTATION_GRACE_MS = 30_000;

const DEVICE_HISTORY_LIMIT = 50;
const SESSION_LIST_LIMIT = 100;

/** "Chrome on Mac OS", or null if the user agent does not say. Versions change; devices do not. */
export function deviceFamily(userAgent?: string | null): string | null {
  if (!userAgent) return null;
  const { browser, os } = new UAParser(userAgent).getResult();
  return browser.name && os.name ? `${browser.name} on ${os.name}` : null;
}

/** What the session's tokens say about how it was authenticated. */
export interface SessionAuth {
  amr: string[];
  authenticatedAt: Date | null;
}

/** `created_at` is when the session began, which bounds how long it can last. */
export type RotationResult =
  | ({ outcome: 'rotated'; jti: string; createdAt: Date } & SessionAuth)
  | ({ outcome: 'retried'; jti: string; createdAt: Date } & SessionAuth)
  | { outcome: 'reused' }
  | { outcome: 'revoked' }
  | { outcome: 'expired' };

// Postgres works the age out against its own clock, the one that wrote `created_at`.
const WITHIN_MAX_AGE = 'created_at > now() - make_interval(secs => :maxAgeSeconds)';

@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(AuthSessionEntity)
    private readonly repository: Repository<AuthSessionEntity>,
  ) {}

  async create(
    userId: string,
    context: RequestContext,
    auth: SessionAuth,
    sessionVersion = 0,
  ): Promise<{ sessionId: string; jti: string; createdAt: Date }> {
    const sessionId = randomUUID();
    const jti = randomUUID();
    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .into(AuthSessionEntity)
      .values({
        id: sessionId,
        userId,
        sessionVersion,
        currentJti: jti,
        amr: auth.amr,
        authenticatedAt: auth.authenticatedAt,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 512) ?? null,
      })
      .returning('created_at')
      .execute();
    const [row] = result.raw as { created_at: Date }[];
    return { sessionId, jti, createdAt: row.created_at };
  }

  /**
   * Whether this browser and operating system are new to the account. Not the address:
   * those change daily on a phone, and a notice for every change would train people to
   * ignore it. False when nothing can be said, either because the device cannot be named
   * or because the account has no earlier sessions to compare with, as with one from
   * before this table existed, which would otherwise be told on its first sign-in.
   */
  async isNewDevice(userId: string, sessionId: string, userAgent?: string | null): Promise<boolean> {
    const device = deviceFamily(userAgent);
    if (!device) return false;
    const earlier = await this.repository.find({
      select: { userAgent: true },
      where: { userId, id: Not(sessionId) },
      order: { createdAt: 'DESC' },
      take: DEVICE_HISTORY_LIMIT,
    });
    if (earlier.length === 0) return false;
    return !earlier.some((session) => deviceFamily(session.userAgent) === device);
  }

  /**
   * Conditional on the presented `jti`, so of two simultaneous refreshes exactly
   * one rotates. A read before a write could let both through. The session's age is
   * part of the same condition, so one refresh cannot slip past the limit while another
   * is deciding it has been reached.
   */
  async rotate(
    sessionId: string,
    userId: string,
    jti: string,
    maxAgeMs: number,
  ): Promise<RotationResult> {
    const next = randomUUID();
    const result = await this.repository
      .createQueryBuilder()
      .update(AuthSessionEntity)
      .set({
        currentJti: next,
        previousJti: jti,
        rotatedAt: () => 'now()',
        lastUsedAt: () => 'now()',
      })
      .where(
        `id = :sessionId AND user_id = :userId AND current_jti = :jti AND revoked_at IS NULL AND ${WITHIN_MAX_AGE}`,
        { sessionId, userId, jti, maxAgeSeconds: maxAgeMs / 1000 },
      )
      .returning('amr, authenticated_at, created_at')
      .execute();
    if (result.affected) {
      const [row] = result.raw as { amr: string[]; authenticated_at: Date | null; created_at: Date }[];
      return {
        outcome: 'rotated',
        jti: next,
        amr: row.amr,
        authenticatedAt: row.authenticated_at,
        createdAt: row.created_at,
      };
    }

    const session = await this.repository.findOne({ where: { id: sessionId, userId } });
    if (!session || session.revokedAt) return { outcome: 'revoked' };

    // The current token failing the update can only mean age. Otherwise the clocks may
    // differ by a moment, which matters less than calling an old session a stolen one.
    if (session.currentJti === jti || Date.now() - session.createdAt.getTime() >= maxAgeMs) {
      await this.revoke(sessionId, userId);
      return { outcome: 'expired' };
    }

    const withinGrace =
      session.previousJti === jti &&
      session.rotatedAt !== null &&
      Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;
    if (withinGrace) {
      return {
        outcome: 'retried',
        jti: session.currentJti,
        amr: session.amr,
        authenticatedAt: session.authenticatedAt,
        createdAt: session.createdAt,
      };
    }

    await this.revoke(sessionId, userId);
    return { outcome: 'reused' };
  }

  /**
   * Records a fresh proof of identity. Null if the session has ended. A passkey adds to
   * `amr`, since the session has now shown it, but a password never removes anything.
   */
  async markAuthenticated(
    sessionId: string,
    userId: string,
    method?: 'webauthn' | 'totp' | 'recovery_code',
  ): Promise<SessionAuth | null> {
    const result = await this.repository
      .createQueryBuilder()
      .update(AuthSessionEntity)
      .set({
        authenticatedAt: () => 'now()',
        lastUsedAt: () => 'now()',
        ...(method
          ? { amr: () => `CASE WHEN amr @> CAST(:factor AS jsonb) THEN amr ELSE amr || CAST(:factor AS jsonb) END` }
          : {}),
      })
      .where('id = :sessionId AND user_id = :userId AND revoked_at IS NULL', { sessionId, userId })
      .setParameter('factor', JSON.stringify(method ? [method] : []))
      .returning('amr, authenticated_at')
      .execute();
    if (!result.affected) return null;
    const [row] = result.raw as { amr: string[]; authenticated_at: Date }[];
    return { amr: row.amr, authenticatedAt: row.authenticated_at };
  }

  isLive(sessionId: string, userId: string): Promise<boolean> {
    return this.repository.existsBy({ id: sessionId, userId, revokedAt: IsNull() });
  }

  /**
   * Sessions whose tokens could still be used: not ended, begun under the account's
   * current session version, refreshed recently enough that the refresh token has not
   * expired, and younger than the maximum session length. Most recently used first.
   */
  listLive(
    userId: string,
    sessionVersion: number,
    refreshLifetimeMs: number,
    maxAgeMs: number,
  ): Promise<AuthSessionEntity[]> {
    const now = Date.now();
    return this.repository.find({
      where: {
        userId,
        sessionVersion,
        revokedAt: IsNull(),
        lastUsedAt: MoreThan(new Date(now - refreshLifetimeMs)),
        createdAt: MoreThan(new Date(now - maxAgeMs)),
      },
      order: { lastUsedAt: 'DESC' },
      take: SESSION_LIST_LIMIT,
    });
  }

  /** False if there was no such session, or it had already ended. */
  async revoke(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.repository.update(
      { id: sessionId, userId, revokedAt: IsNull() },
      { revokedAt: () => 'now()' },
    );
    return (result.affected ?? 0) > 0;
  }

  /** Everything but `keepSessionId`. Their access tokens stop at their next request. */
  async revokeOthers(userId: string, keepSessionId: string): Promise<number> {
    const result = await this.repository.update(
      { userId, revokedAt: IsNull(), id: Not(keepSessionId) },
      { revokedAt: () => 'now()' },
    );
    return result.affected ?? 0;
  }

  async revokeAll(userId: string, manager?: EntityManager): Promise<void> {
    const repository = manager?.getRepository(AuthSessionEntity) ?? this.repository;
    await repository.update({ userId, revokedAt: IsNull() }, { revokedAt: () => 'now()' });
  }
}
