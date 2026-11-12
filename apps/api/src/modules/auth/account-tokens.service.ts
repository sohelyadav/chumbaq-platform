import { createHash, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { AccountTokenEntity, AccountTokenPurpose } from './entities/account-token.entity';

const MINUTE_MS = 60_000;

export const TOKEN_LIFETIME_MS: Record<AccountTokenPurpose, number> = {
  reset_password: 30 * MINUTE_MS,
  verify_email: 24 * 60 * MINUTE_MS,
};

/** Each one is an email to an address nobody has proved they own, so it is limited. */
export const MAX_SENDS_PER_HOUR = 3;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AccountTokensService {
  constructor(
    @InjectRepository(AccountTokenEntity)
    private readonly repository: Repository<AccountTokenEntity>,
  ) {}

  /**
   * Replaces any earlier unused emailed token of this purpose. Returns the raw token,
   * which exists nowhere else after this, or null if the address has had its limit.
   *
   * A link staff issued (`issueByStaff`) is neither counted nor replaced: it was never
   * emailed, so it is no send to limit, and whoever holds the mailbox could otherwise
   * void the link support handed over just by asking for one of their own.
   *
   * The user row is locked for the count and the insert, so simultaneous requests
   * cannot all see room under the limit, or each leave a live token behind.
   */
  async issue(userId: string, purpose: AccountTokenPurpose): Promise<string | null> {
    return this.repository.manager.transaction(async (manager) => {
      await manager.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [userId]);

      const [{ sends }] = await manager.query(
        `SELECT count(*)::int AS sends FROM account_tokens
          WHERE user_id = $1 AND purpose = $2 AND NOT staff_issued
            AND created_at > now() - interval '1 hour'`,
        [userId, purpose],
      );
      if (sends >= MAX_SENDS_PER_HOUR) return null;

      const repository = manager.getRepository(AccountTokenEntity);
      await repository.update(
        { userId, purpose, usedAt: IsNull(), staffIssued: false },
        { usedAt: () => 'now()' },
      );

      const token = randomBytes(32).toString('base64url');
      await repository.insert({
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS[purpose]),
      });
      return token;
    });
  }

  /** So a token is spent in the same transaction as what it authorises. */
  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.repository.manager.transaction(work);
  }

  /** Reads only, so a caller can lock the user before spending the token. */
  async ownerOf(token: string, manager: EntityManager): Promise<string | null> {
    const row = await manager
      .getRepository(AccountTokenEntity)
      .findOne({ select: { userId: true }, where: { tokenHash: hashToken(token) } });
    return row?.userId ?? null;
  }

  /**
   * Returns the token's user, or null if it is unknown, used, expired or for another
   * purpose. Decided by one conditional UPDATE, so of two simultaneous uses exactly
   * one succeeds, which a read followed by a write could not promise.
   */
  async consume(
    token: string,
    purpose: AccountTokenPurpose,
    manager: EntityManager = this.repository.manager,
  ): Promise<string | null> {
    return (await this.spend(token, purpose, manager))?.userId ?? null;
  }

  /** As `consume`, also saying whether staff issued the token (`issueByStaff`). */
  async spend(
    token: string,
    purpose: AccountTokenPurpose,
    manager: EntityManager = this.repository.manager,
  ): Promise<{ userId: string; staffIssued: boolean } | null> {
    const result = await manager
      .createQueryBuilder()
      .update(AccountTokenEntity)
      .set({ usedAt: () => 'now()' })
      .where('token_hash = :tokenHash AND purpose = :purpose', {
        tokenHash: hashToken(token),
        purpose,
      })
      .andWhere('used_at IS NULL AND expires_at > now()')
      // A staff link waiting out its delay is left unspent: see `usableAt`.
      .andWhere('(usable_after IS NULL OR usable_after <= now())')
      .returning(['userId', 'staffIssued'])
      .execute();
    const [row] = result.raw as { user_id: string; staff_issued: boolean }[];
    return row ? { userId: row.user_id, staffIssued: row.staff_issued } : null;
  }

  /**
   * A password reset link issued by staff through the CLI (`admin:password-reset-link`)
   * after checking who is asking some other way than email. It is never emailed, so it
   * is not counted against the address's limit, and it is the one link that still works
   * within the window after a staff factor reset (`passwordResetBlockedSince`): the
   * mailbox alone still cannot set the password. In the caller's transaction, with the
   * user row already locked.
   *
   * Replaces nothing itself: the caller commits this row, tells the owner, and only then
   * calls `replaceResetLinks`, so a notice that fails leaves the links that were there.
   *
   * It does nothing for `delayMs` (`usable_after`), the owner's time to see the notice
   * and sign in, which voids it (`voidStaffLinks`), then works for `usableForMs`. Times
   * from the database's clock, which is the one `spend` compares with.
   */
  async issueByStaff(
    userId: string,
    manager: EntityManager,
    delayMs: number,
    usableForMs: number,
  ): Promise<{ id: string; token: string; usableAt: Date; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const [row] = await manager.query(
      `INSERT INTO account_tokens (user_id, purpose, token_hash, staff_issued, usable_after, expires_at)
       VALUES ($1, 'reset_password', $2, true,
               now() + make_interval(secs => $3::float8),
               now() + make_interval(secs => $3::float8 + $4::float8))
       RETURNING id, usable_after, expires_at`,
      [userId, hashToken(token), delayMs / 1000, usableForMs / 1000],
    );
    return { id: row.id, token, usableAt: new Date(row.usable_after), expiresAt: new Date(row.expires_at) };
  }

  /** Spends every other unused reset link the user has, as `issue` does. Lock the user first. */
  async replaceResetLinks(userId: string, keepId: string, manager: EntityManager): Promise<void> {
    await manager.query(
      `UPDATE account_tokens SET used_at = now()
        WHERE user_id = $1 AND purpose = 'reset_password' AND used_at IS NULL AND id <> $2`,
      [userId, keepId],
    );
  }

  /** Spends one staff link by id. True if it was still unused. Lock the user first. */
  async spendStaffLink(userId: string, id: string, manager: EntityManager): Promise<boolean> {
    // TypeORM answers an UPDATE's raw query with [rows, rowCount].
    const [rows] = (await manager.query(
      `UPDATE account_tokens SET used_at = now()
        WHERE id = $1 AND user_id = $2 AND staff_issued AND used_at IS NULL RETURNING id`,
      [id, userId],
    )) as [{ id: string }[], number];
    return rows.length > 0;
  }

  /** Whether the user has a staff link that is unused and unexpired, waiting or not. */
  async hasLiveStaffLink(userId: string, manager: EntityManager = this.repository.manager): Promise<boolean> {
    const [row] = await manager.query(
      `SELECT 1 FROM account_tokens
        WHERE user_id = $1 AND purpose = 'reset_password' AND staff_issued
          AND used_at IS NULL AND expires_at > now()
        LIMIT 1`,
      [userId],
    );
    return Boolean(row);
  }

  /**
   * When an unused staff link that is still waiting out its delay becomes usable, or
   * null for any other token, known or not. Only someone holding the link can ask, so it
   * tells nobody else anything.
   */
  async usableAt(token: string, manager: EntityManager = this.repository.manager): Promise<Date | null> {
    const [row] = await manager.query(
      `SELECT usable_after FROM account_tokens
        WHERE token_hash = $1 AND purpose = 'reset_password' AND used_at IS NULL
          AND expires_at > now() AND usable_after > now()`,
      [hashToken(token)],
    );
    return row ? new Date(row.usable_after) : null;
  }

  /**
   * Spends every unused staff link the user has, returning their ids. For a sign-in by
   * the owner: someone who can still sign in was never locked out, so a link support
   * handed over in their name is going to someone else.
   *
   * Locks the user row first (users before tokens, as everywhere), in the caller's
   * transaction. A link being issued holds that lock until its row commits, so this
   * waits and then sees it, rather than voiding nothing and leaving it to go live.
   */
  async voidStaffLinks(userId: string, manager: EntityManager): Promise<string[]> {
    await manager.query(`SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE`, [userId]);
    const result = await manager
      .createQueryBuilder()
      .update(AccountTokenEntity)
      .set({ usedAt: () => 'now()' })
      .where(`user_id = :userId AND purpose = 'reset_password' AND staff_issued`, { userId })
      .andWhere('used_at IS NULL AND expires_at > now()')
      .returning(['id'])
      .execute();
    return ((result.raw ?? []) as { id: string }[]).map((row) => row.id);
  }

  async invalidateAll(
    userId: string,
    manager: EntityManager = this.repository.manager,
  ): Promise<void> {
    await manager
      .getRepository(AccountTokenEntity)
      .update({ userId, usedAt: IsNull() }, { usedAt: () => 'now()' });
  }
}
