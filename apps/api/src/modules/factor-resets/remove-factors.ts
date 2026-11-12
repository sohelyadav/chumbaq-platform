import { EntityManager, IsNull } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { AuthEventEntity } from '../auth-events/entities/auth-event.entity';
import { AuthSessionEntity } from '../auth/entities/auth-session.entity';
import { RecoveryCodeEntity } from '../auth/entities/recovery-code.entity';
import { TotpSecretEntity } from '../auth/entities/totp-secret.entity';
import { WebauthnCredentialEntity } from '../auth/entities/webauthn-credential.entity';
import { revokeAllStaffSessions } from '../auth/staff-sessions.service';
import { UserEntity } from '../users/entities/user.entity';
import { FactorResetEntity } from './entities/factor-reset.entity';

/** Who removed the factors, for the audit entry of a waiting reset this supersedes. */
export interface RemoveFactorsActor {
  userId: string | null;
  email: string;
}

export interface RemovedFactors {
  /** How many passkeys went. */
  passkeys: number;
  /** The waiting staff reset this cancelled, if there was one. Tell the owner once committed. */
  supersededResetIds: string[];
}

/**
 * Everything that could sign in with what was lost, including whoever is signed in now.
 * Shared by the CLI and the delayed staff reset, so both remove exactly the same things.
 *
 * Also cancels a staff reset still waiting: once this has run, a later one would only
 * remove whatever the owner set up afterwards. That cancel is audited and recorded in
 * the owner's history here, in the caller's transaction, as every other cancel is: the
 * owner was warned of it and the history must not say it is still coming. Call with
 * the user row already locked.
 */
export async function removeFactors(
  manager: EntityManager,
  user: Pick<UserEntity, 'id' | 'email'>,
  actor: RemoveFactorsActor,
): Promise<RemovedFactors> {
  const userId = user.id;
  const removed = await manager.delete(WebauthnCredentialEntity, { userId });
  await manager.delete(TotpSecretEntity, { userId });
  await manager.delete(RecoveryCodeEntity, { userId });
  await manager.increment(UserEntity, { id: userId }, 'sessionVersion', 1);
  await manager.update(AuthSessionEntity, { userId, revokedAt: IsNull() }, { revokedAt: () => 'now()' });
  // The version bump already ends staff tokens; this ends the rows, so a view-as started
  // from one of them ends too and the admin app's refresh cookie is dead at once.
  await revokeAllStaffSessions(manager, userId, 'factors_reset');
  const superseded = await manager
    .createQueryBuilder()
    .update(FactorResetEntity)
    .set({ status: 'cancelled', cancelledAt: () => 'now()', cancelledBy: 'superseded' })
    .where(`user_id = :userId AND status = 'pending'`, { userId })
    .returning(['id'])
    .execute();
  const supersededResetIds = ((superseded.raw ?? []) as { id: string }[]).map((row) => row.id);

  const audit = new AdminAuditService(manager.getRepository(AdminAuditLogEntity));
  for (const resetId of supersededResetIds) {
    await audit.record(
      {
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'account.factors_reset_cancelled',
        targetType: 'tenant',
        targetId: userId,
        targetLabel: user.email,
        ipAddress: null,
        metadata: { resetId, cancelledBy: 'superseded' },
      },
      manager,
    );
    await manager.insert(AuthEventEntity, {
      type: 'factors_reset.cancelled',
      userId,
      email: user.email,
      reason: 'superseded',
    });
  }
  return { passkeys: removed.affected ?? 0, supersededResetIds };
}

/**
 * Records that staff removed every factor, for the delayed reset and both CLI resets
 * (`admin:factors-reset`, `admin:passkeys-reset`), in the same transaction. Password
 * resets by email and by team admins are refused for `PASSWORD_RESET_WINDOW_DAYS` after
 * this, because whoever asked staff may hold only the mailbox. Signing in with the
 * existing password is not affected, which is how a super admin recovers. Kept apart
 * from `removeFactors` so each caller says it.
 *
 * The statement's own time, not the transaction's: a staff reset is refused if its
 * requester's keys were reset after it was asked for (`requester_keys_reset`), and a
 * request that committed while this transaction waited for the user row started after
 * this transaction did. Call with the row already locked, so every request that got in
 * first is earlier than this.
 */
export async function markFactorsReset(manager: EntityManager, userId: string): Promise<void> {
  await manager.update(UserEntity, { id: userId }, { factorsResetAt: () => 'clock_timestamp()' });
}
