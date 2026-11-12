import { EntityManager, In } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import type { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { FactorResetEntity } from './entities/factor-reset.entity';
import { inLockOrder } from './lock-users';
import { retryTransient } from './retry-transient';

/** Why a reset was refused, in its audit entry. Every one is `cancelledBy: 'refused'`. */
export type FactorResetRefusal =
  | 'target_super_admin'
  | 'requester_not_staff'
  | 'requester_suspended'
  | 'requester_missing'
  /** The CLI reset the requester's keys after they asked: whoever asked may have held a lost key. */
  | 'requester_keys_reset';

/**
 * Which of a requester's waiting resets to take: all of them (revoked or suspended), or
 * only those asked for before their keys were reset (`admin:passkeys-reset`), since a
 * later one was asked for with a key enrolled after the reset.
 */
export type ResetTargetScope = 'all' | 'before_keys_reset';

/** The owners' rows `lockResetTargetsOf` holds (with the requester's), which are all that may be cancelled. */
export interface LockedResetTargets {
  requesterId: string;
  scope: ResetTargetScope;
  userIds: string[];
}

/** A reset cancelled here, for the owner's notice once the transaction commits. */
export interface RequesterResetCancelled {
  resetId: string;
  userId: string;
  email: string;
  name: string;
}

/**
 * Locks, FOR NO KEY UPDATE, the requester's own row and the rows of everyone they have
 * a reset waiting for, all in one statement in ascending id order (`inLockOrder`).
 *
 * Call it only once no new reset can be asked for in the requester's name: in its own
 * transaction, after one that has already committed whatever makes `request` refuse
 * them (revoked, suspended, keys removed). `request` checks the requester under a lock,
 * so from that commit on the set of waiting resets can only shrink, and new requests
 * cannot keep this from finishing. With the change and the locking in one transaction,
 * as before, a requester who kept asking could make every attempt find a new reset
 * until the revoke gave up, leaving them a super admin.
 *
 * One order for every row, rather than owners and then the requester, because two
 * requesters revoked at once may each have a reset on the other: owners-first had each
 * revoke hold the other's row and wait for its own. `request` and `execute`, which
 * hold an owner and read the requester, lock in the same order (`lockOwnerAndStaff`).
 * Reset rows are only touched once these are held.
 *
 * The waiting resets are read again once the locks are held. One found only then was
 * written by something that did not wait for the change (`request` holds the
 * requester's row, so it always commits before the change does; anything else that
 * writes resets may not). Its owner's row may sort before one already held, so the
 * locks are given back (to a savepoint) and taken again in order with it included,
 * rather than taken out of order. Only as many of those exist as were in flight at the
 * commit, so this ends, and it never gives up.
 */
export async function lockResetTargetsOf(
  manager: EntityManager,
  requesterId: string,
  scope: ResetTargetScope = 'all',
): Promise<LockedResetTargets> {
  for (;;) {
    await manager.query('SAVEPOINT lock_reset_targets');
    const before = await pendingTargetsOf(manager, requesterId, scope);
    // ORDER BY applies to the locking too, so every caller takes shared rows in one order.
    await manager.query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`, [
      inLockOrder([...before, requesterId]),
    ]);
    const after = await pendingTargetsOf(manager, requesterId, scope);
    if (after.every((id) => before.includes(id))) {
      await manager.query('RELEASE SAVEPOINT lock_reset_targets');
      return { requesterId, scope, userIds: after };
    }
    await manager.query('ROLLBACK TO SAVEPOINT lock_reset_targets');
  }
}

/** The extra condition on `factor_resets` for a scope, with the requester as `requested_by_id`. */
function scopeSql(scope: ResetTargetScope): string {
  return scope === 'all'
    ? ''
    : `AND requested_at < (SELECT factors_reset_at FROM users WHERE users.id = factor_resets.requested_by_id)`;
}

async function pendingTargetsOf(
  manager: EntityManager,
  requesterId: string,
  scope: ResetTargetScope,
): Promise<string[]> {
  const rows: { user_id: string }[] = await manager.query(
    `SELECT DISTINCT user_id FROM factor_resets
      WHERE requested_by_id = $1 AND status = 'pending' ${scopeSql(scope)}`,
    [requesterId],
  );
  return inLockOrder(rows.map((row) => row.user_id));
}

/**
 * Cancels every reset still waiting that the requester asked for: they have just
 * stopped being active staff (or lost their keys), and a reset they started must not
 * run on their word. Run with `targets` from `lockResetTargetsOf` at the start of the
 * same transaction.
 *
 * Only resets on the locked rows are cancelled; `execute` checks the requester again
 * in any case. Each reset row is changed by one conditional UPDATE, so a worker that
 * already claimed one is left alone.
 *
 * Returns what was cancelled: pass it to `announceRequesterResetsCancelled` once the
 * transaction commits, so each owner warned in this requester's name hears it stopped.
 */
export async function cancelResetsRequestedBy(
  manager: EntityManager,
  targets: LockedResetTargets,
  refusal: FactorResetRefusal,
  actor: { userId: string | null; email: string; ipAddress?: string | null },
): Promise<RequesterResetCancelled[]> {
  const { requesterId, userIds, scope } = targets;
  if (userIds.length === 0) return [];
  const result = await manager
    .createQueryBuilder()
    .update(FactorResetEntity)
    .set({ status: 'cancelled', cancelledAt: () => 'now()', cancelledBy: 'refused' })
    .where(`requested_by_id = :requesterId AND status = 'pending' AND user_id IN (:...userIds) ${scopeSql(scope)}`, {
      requesterId,
      userIds,
    })
    .returning(['id', 'userId'])
    .execute();
  const rows = (result.raw ?? []) as { id: string; user_id: string }[];
  if (rows.length === 0) return [];

  const owners = await manager.find(UserEntity, {
    select: { id: true, email: true, name: true },
    where: { id: In(rows.map((row) => row.user_id)) },
  });
  const ownerOf = new Map(owners.map((user) => [user.id, user]));
  const audit = new AdminAuditService(manager.getRepository(AdminAuditLogEntity));
  const cancelled: RequesterResetCancelled[] = [];
  for (const row of rows) {
    const owner = ownerOf.get(row.user_id);
    const email = owner?.email ?? null;
    await audit.record(
      {
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'account.factors_reset_cancelled',
        targetType: 'tenant',
        targetId: row.user_id,
        targetLabel: email,
        ipAddress: actor.ipAddress ?? null,
        metadata: { resetId: row.id, cancelledBy: 'refused', refusal, requestedById: requesterId },
      },
      manager,
    );
    // In the transaction, so the owner's history cannot say a reset is still coming.
    await manager.insert(AuthEventEntity, {
      type: 'factors_reset.cancelled',
      userId: row.user_id,
      email,
      reason: 'refused',
    });
    if (owner) cancelled.push({ resetId: row.id, userId: owner.id, email: owner.email, name: owner.name });
  }
  return cancelled;
}

/**
 * The second step of a revoke, suspension or keys reset, once its first transaction
 * has committed and `request` refuses this requester: locks and cancels what they
 * asked for, in a transaction of its own. Retried on deadlocks and lock timeouts,
 * since the change it follows has already landed and must not be reported as failed
 * over this. If it still fails, `execute` refuses those resets anyway.
 */
export function cancelAllRequestedBy(
  run: <T>(work: (manager: EntityManager) => Promise<T>) => Promise<T>,
  requesterId: string,
  scope: ResetTargetScope,
  refusal: FactorResetRefusal,
  actor: { userId: string | null; email: string; ipAddress?: string | null },
): Promise<RequesterResetCancelled[]> {
  return retryTransient(() =>
    run(async (manager) => {
      const targets = await lockResetTargetsOf(manager, requesterId, scope);
      return cancelResetsRequestedBy(manager, targets, refusal, actor);
    }),
  );
}

/** Emails each owner that the reset they were warned of has stopped. Never throws. */
export function announceRequesterResetsCancelled(
  notices: Pick<SecurityNoticesService, 'factorResetCancelled'>,
  cancelled: RequesterResetCancelled[],
): void {
  for (const reset of cancelled) {
    notices.factorResetCancelled({ id: reset.userId, email: reset.email, name: reset.name });
  }
}
