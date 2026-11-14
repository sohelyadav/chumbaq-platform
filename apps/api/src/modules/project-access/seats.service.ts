import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccountLimitsService } from '../billing/account-limits.service';

export const SEAT_LIMIT_MESSAGE = 'Your plan has no free seats. Upgrade to invite teammates.';

/**
 * $1 the billing owner, $2 an extra project billed to them for the count (or null).
 * `counted` is every user with a seat: the owner and the members of billed projects.
 */
const COUNTED_PEOPLE_SQL = `
  WITH billed AS (
    SELECT id FROM projects WHERE owner_id = $1 OR id = $2::uuid
  ), counted AS (
    SELECT u.id, lower(u.email) AS email FROM users u
     WHERE u.id = $1
        OR u.id IN (SELECT m.user_id FROM project_members m WHERE m.project_id IN (SELECT id FROM billed))
  )`;

/** A pending invitation that has not lapsed. Emails are stored lower-case. */
const LIVE_INVITE_SQL = `i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`;

export interface SeatOptions {
  /** A project that is about to be billed to this account (a transfer), counted as if it already were. */
  extraProjectId?: string;
}

/**
 * The people on one billing account: its owner, everyone who is a member of a project
 * billed to it, and everyone with a live invitation to one. The same person across
 * several of its projects is one seat.
 *
 * Lock order for callers (mutations that call `assertRoomFor`): the `projects` row
 * first, then `users` rows in ascending id (`inLockOrder`).
 */
@Injectable()
export class SeatsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly limits: AccountLimitsService,
  ) {}

  async count(
    billingOwnerId: string,
    manager: EntityManager = this.dataSource.manager,
    opts: SeatOptions = {},
  ): Promise<number> {
    const [row] = await manager.query(
      `${COUNTED_PEOPLE_SQL}
       SELECT (SELECT count(*) FROM counted)
            + (SELECT count(DISTINCT i.email) FROM project_invitations i
                WHERE i.project_id IN (SELECT id FROM billed)
                  AND ${LIVE_INVITE_SQL}
                  AND i.email NOT IN (SELECT email FROM counted)) AS n`,
      [billingOwnerId, opts.extraProjectId ?? null],
    );
    return Number(row.n);
  }

  /**
   * Refuses (403 `SEAT_LIMIT_MESSAGE`) giving `email` a place on the account when it
   * would go over the limit. Someone already counted needs no new seat. When accepting
   * a live invitation of this account it is itself already counted, so the check is
   * `count <= limit`; an id that is not a live invitation on the account's projects is
   * treated as a plain new invitation.
   *
   * The caller must already hold the lock on the billing owner's users row (and the
   * project row before it), so a concurrent invite cannot slip past the count.
   */
  async assertRoomFor(
    manager: EntityManager,
    billingOwnerId: string,
    email: string,
    opts: {
      acceptingInvitationId?: string;
      /**
       * Set when the caller is not the billing owner: the only project whose people they
       * may know about. Whether someone already holds a seat through the account's
       * other projects then plays no part, so the answer cannot tell an admin of one
       * project who belongs to, or is invited to, the others. Such an admin at the
       * limit is refused even for someone who would take no new seat.
       */
      visibleProjectId?: string;
    } = {},
  ): Promise<void> {
    const limit = await this.seatLimitOf(manager, billingOwnerId);
    if (limit === null) return;

    const address = email.trim().toLowerCase();
    const visible = opts.visibleProjectId ?? null;
    const [{ is_member: isMember, is_invited: isInvited, is_accepting: isAccepting }] = await manager.query(
      `${COUNTED_PEOPLE_SQL}
       SELECT EXISTS (SELECT 1 FROM counted c WHERE c.email = $3
                        AND ($5::uuid IS NULL OR c.id = $1 OR c.id IN (
                          SELECT m.user_id FROM project_members m WHERE m.project_id = $5::uuid))) AS is_member,
              EXISTS (SELECT 1 FROM project_invitations i
                       WHERE i.project_id IN (SELECT id FROM billed)
                         AND ($5::uuid IS NULL OR i.project_id = $5::uuid)
                         AND ${LIVE_INVITE_SQL} AND i.email = $3) AS is_invited,
              EXISTS (SELECT 1 FROM project_invitations i
                       WHERE i.id = $4::uuid AND i.project_id IN (SELECT id FROM billed)
                         AND ${LIVE_INVITE_SQL}) AS is_accepting`,
      [billingOwnerId, null, address, opts.acceptingInvitationId ?? null, visible],
    );
    if (isMember) return;

    const used = await this.count(billingOwnerId, manager);
    if (isAccepting) {
      if (used > limit) throw new ForbiddenException(SEAT_LIMIT_MESSAGE);
      return;
    }
    if (isInvited) return;
    if (used + 1 > limit) throw new ForbiddenException(SEAT_LIMIT_MESSAGE);
  }

  /**
   * Refuses (403 `SEAT_LIMIT_MESSAGE`) billing `projectId` to `newBillingOwnerId` when
   * its people, added to that account's own (a person on both counted once), would
   * exceed the new owner's limit. Same lock contract as `assertRoomFor`: the project
   * row, then users rows in ascending id, the new owner's among them.
   */
  async assertRoomForTransfer(
    manager: EntityManager,
    newBillingOwnerId: string,
    projectId: string,
  ): Promise<void> {
    const limit = await this.seatLimitOf(manager, newBillingOwnerId);
    if (limit === null) return;
    const used = await this.count(newBillingOwnerId, manager, { extraProjectId: projectId });
    if (used > limit) throw new ForbiddenException(SEAT_LIMIT_MESSAGE);
  }

  /**
   * The account's seat limit (`AccountLimitsService`): the staff override or
   * `MAX_SEATS_PER_ACCOUNT`, or with billing on its effective plan's. Null is no limit,
   * which is also what self-hosted installs (variable unset) get.
   */
  async seatLimitOf(manager: EntityManager, billingOwnerId: string): Promise<number | null> {
    return (await this.limits.limitsFor(manager, billingOwnerId)).seatLimit;
  }
}
