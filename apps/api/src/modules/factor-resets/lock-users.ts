import { EntityManager } from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';

/**
 * The lock order for user rows, wherever a transaction here takes more than one:
 * ascending id, whatever part each row plays. A revoke locks the owners of its
 * requester's resets and the requester in one statement, and two revokes can each be
 * the other's requester, so no order by role (owner before staff) can serve them all.
 * Ids compare the same as text as Postgres compares them as uuids, both being lower-case
 * hex in the same byte order.
 */
export function inLockOrder(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((id) => id.toLowerCase()))].sort();
}

/**
 * Locks a reset's owner and the staff member acting on it, both FOR NO KEY UPDATE,
 * lower id first. The lock on staff is what makes a revoke, suspension or keys reset in
 * flight finish first and be seen, and makes one that starts later wait for this
 * transaction, so that it then finds the reset this one wrote. Either row may be
 * missing; the same person in both parts is locked once.
 *
 * Not FOR SHARE on staff, although this only reads that row: shared lockers do not
 * queue behind a waiting FOR NO KEY UPDATE, so a requester sending request after
 * request, each answered 409 but each holding the share for a moment, kept their own
 * revoke waiting for as long as they kept it up. In one mode every taker queues, and
 * the revoke waits only for the requests already ahead of it. Requests by one staff
 * member now run one at a time, which costs nothing anyone notices.
 */
export async function lockOwnerAndStaff(
  manager: EntityManager,
  ownerId: string,
  staffId: string | null,
): Promise<{ owner: UserEntity | null; staff: UserEntity | null }> {
  const found = new Map<string, UserEntity | null>();
  for (const id of inLockOrder(staffId ? [ownerId, staffId] : [ownerId])) {
    found.set(id, await manager.findOne(UserEntity, { where: { id }, lock: { mode: 'for_no_key_update' } }));
  }
  return {
    owner: found.get(ownerId.toLowerCase()) ?? null,
    staff: staffId ? (found.get(staffId.toLowerCase()) ?? null) : null,
  };
}
