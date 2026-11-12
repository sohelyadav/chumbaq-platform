import { ConfigService } from '@nestjs/config';
import { DataSource, FindOperator } from 'typeorm';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { ProjectInvitationEntity } from './entities/project-invitation.entity';
import { ProjectMemberEntity } from './entities/project-member.entity';
import {
  BILLING_OFFER_GONE,
  BILLING_SUSPENDED,
  BILLING_TARGET_NOT_OWNER,
  BillingTransferService,
} from './billing-transfer.service';
import { LAST_OWNER, MEMBER_NOT_FOUND, MOVE_BILLING_FIRST, ProjectMembersService } from './project-members.service';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL, type ProjectRole } from './project-permissions';
import { SEAT_LIMIT_MESSAGE, SeatsService } from './seats.service';
import type { ProjectActivityService } from '../project-activity/project-activity.service';

/** Where the request came from; the entries themselves are proved in team-activity.int-spec.ts. */
const CTX = { ipAddress: null, userAgent: null };

/**
 * A manager over in-memory rows that behaves like the database for what these services
 * ask: `where` matches every listed column, `count` counts what matches, and
 * update/delete change only matching rows. Locks are recorded, not enforced (the
 * integration specs race real connections).
 */
type Row = Record<string, unknown>;
class FakeManager {
  readonly tables = new Map<unknown, Row[]>([
    [ProjectEntity, []],
    [ProjectMemberEntity, []],
    [UserEntity, []],
    [ProjectInvitationEntity, []],
  ]);
  readonly locks: string[] = [];
  /** The database's `now()`, kept apart from `Date.now()` so a test can make the API's clock wrong. */
  dbNow = (): number => Date.now();

  /**
   * The one raw query these services make: the project's live offer, the 7 days judged
   * by the database clock (`BILLING_OFFER_SQL`).
   */
  async query(sql: string, params: unknown[]): Promise<Row[]> {
    // The members listing's join is not modelled: no rows.
    if (!sql.includes('pending_billing_offered_at')) return [];
    const p = this.rows(ProjectEntity).find((r) => r.id === params[0]);
    const at = p?.pendingBillingOfferedAt as Date | null | undefined;
    if (!p?.pendingBillingOwnerId || !at) return [];
    if (!(at.getTime() > this.dbNow() - 7 * 24 * 3600 * 1000)) return [];
    return [{ toUserId: p.pendingBillingOwnerId, offeredAt: at, expiresAt: new Date(at.getTime() + 7 * 24 * 3600 * 1000) }];
  }

  private rows(entity: unknown): Row[] {
    const rows = this.tables.get(entity);
    if (!rows) throw new Error(`No fake table for ${String((entity as { name?: string }).name)}`);
    return rows;
  }

  private matches(row: Row, where: Row): boolean {
    // `IsNull()` as the database reads it; any other operator is not something these services use.
    return Object.entries(where).every(([k, v]) => {
      if (v instanceof FindOperator) {
        if (v.type !== 'isNull') throw new Error(`Fake manager: unsupported operator ${v.type}`);
        return row[k] === null || row[k] === undefined;
      }
      return row[k] === v;
    });
  }

  async findOne(entity: unknown, opts: { where: Row; lock?: { mode: string } }): Promise<Row | null> {
    if (opts.lock) this.locks.push(`${(entity as { name: string }).name}:${String(opts.where.id)}`);
    const row = this.rows(entity).find((r) => this.matches(r, opts.where));
    return row ? { ...row } : null;
  }

  async count(entity: unknown, opts: { where: Row }): Promise<number> {
    return this.rows(entity).filter((r) => this.matches(r, opts.where)).length;
  }

  async update(entity: unknown, where: Row, values: Row): Promise<void> {
    for (const r of this.rows(entity)) if (this.matches(r, where)) Object.assign(r, values);
  }

  async delete(entity: unknown, where: Row): Promise<void> {
    const rows = this.rows(entity);
    for (let i = rows.length - 1; i >= 0; i--) if (this.matches(rows[i], where)) rows.splice(i, 1);
  }
}

const P = '00000000-0000-4000-8000-0000000000aa';
// Ids out of alphabetical order with their roles, so lock order is tested on the ids.
const BILLING = '00000000-0000-4000-8000-000000000009';
const OWNER2 = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000003';
const MEMBER = '00000000-0000-4000-8000-000000000004';
const STRANGER = '00000000-0000-4000-8000-000000000005';

const now = Math.floor(Date.now() / 1000);
const userOf = (userId: string, fresh = true): AuthenticatedUser => ({
  userId,
  email: `${userId}@example.com`,
  isSuperAdmin: false,
  authTime: fresh ? now : now - 3600,
});

describe('ProjectMembersService and BillingTransferService', () => {
  let m: FakeManager;
  let members: ProjectMembersService;
  let billing: BillingTransferService;
  let seats: { assertRoomForTransfer: jest.Mock };
  let activity: { record: jest.Mock };

  const member = (userId: string, role: ProjectRole) =>
    m.tables.get(ProjectMemberEntity)!.push({ id: `m-${userId}`, projectId: P, userId, role });
  const roleOf = (userId: string) =>
    m.tables.get(ProjectMemberEntity)!.find((r) => r.userId === userId)?.role as ProjectRole | undefined;
  const project = () => m.tables.get(ProjectEntity)!.find((r) => r.id === P)!;
  const owners = () => m.tables.get(ProjectMemberEntity)!.filter((r) => r.role === 'owner').length;

  beforeEach(() => {
    m = new FakeManager();
    m.tables.get(ProjectEntity)!.push({
      id: P,
      ownerId: BILLING,
      pendingBillingOwnerId: null,
      pendingBillingOfferedAt: null,
    });
    for (const id of [BILLING, OWNER2, ADMIN, MEMBER, STRANGER]) {
      m.tables.get(UserEntity)!.push({ id, suspendedAt: null, projectLimit: null, seatLimit: null });
    }
    member(BILLING, 'owner');
    member(OWNER2, 'owner');
    member(ADMIN, 'admin');
    member(MEMBER, 'member');
    const ds = { transaction: (cb: (x: unknown) => unknown) => cb(m), manager: m } as unknown as DataSource;
    activity = { record: jest.fn().mockResolvedValue(undefined) };
    members = new ProjectMembersService(ds, activity as unknown as ProjectActivityService);
    seats = { assertRoomForTransfer: jest.fn().mockResolvedValue(undefined) };
    billing = new BillingTransferService(
      ds,
      seats as unknown as SeatsService,
      activity as unknown as ProjectActivityService,
      new ConfigService({ projects: { maxPerAccount: 10 } }),
    );
  });

  describe('invites a person sent, when their place changes', () => {
    /** A pending invite from `invitedBy`, shaped like the rows InvitationsService writes. */
    const sent = (invitedBy: string, role: ProjectRole, projectId = P) => {
      const row = { id: `i-${invitedBy}-${role}-${projectId}`, projectId, invitedBy, role, acceptedAt: null, revokedAt: null };
      m.tables.get(ProjectInvitationEntity)!.push(row);
      return row;
    };
    const revoked = (row: Row) => Boolean(row.revokedAt);

    it('revokes every pending invite of someone removed, and only theirs, only in this project', async () => {
      const mine = [sent(ADMIN, 'member'), sent(ADMIN, 'admin')];
      const elsewhere = sent(ADMIN, 'member', 'another-project');
      const others = sent(OWNER2, 'member');
      const accepted = { ...sent(ADMIN, 'member'), id: 'accepted' };
      m.tables.get(ProjectInvitationEntity)!.splice(-1, 1, { ...accepted, acceptedAt: new Date() });

      await members.remove(userOf(OWNER2), P, ADMIN, CTX);

      expect(mine.map(revoked)).toEqual([true, true]);
      expect(revoked(elsewhere)).toBe(false);
      expect(revoked(others)).toBe(false);
      expect(m.tables.get(ProjectInvitationEntity)!.find((r) => r.id === 'accepted')!.revokedAt).toBeNull();
    });

    it('revokes them when the person leaves', async () => {
      const mine = sent(ADMIN, 'member');
      await members.leave(userOf(ADMIN), P, CTX);
      expect(revoked(mine)).toBe(true);
    });

    it('revokes all of an admin\'s invites when made a member, and none when made an owner', async () => {
      const mine = sent(ADMIN, 'admin');
      await members.changeRole(userOf(OWNER2), P, ADMIN, 'owner', CTX);
      expect(revoked(mine)).toBe(false);
      await members.changeRole(userOf(OWNER2), P, ADMIN, 'member', CTX);
      expect(revoked(mine)).toBe(true);
    });

    it('revokes only the owner invites of an owner demoted to admin', async () => {
      const [ownerInvite, memberInvite] = [sent(OWNER2, 'owner'), sent(OWNER2, 'member')];
      await members.changeRole(userOf(BILLING), P, OWNER2, 'admin', CTX);
      expect(revoked(ownerInvite)).toBe(true);
      expect(revoked(memberInvite)).toBe(false);
    });
  });

  describe('changeRole', () => {
    it('lets an admin change a member to admin, after locking the project row', async () => {
      await members.changeRole(userOf(ADMIN), P, MEMBER, 'admin', CTX);
      expect(roleOf(MEMBER)).toBe('admin');
      expect(m.locks[0]).toBe(`ProjectEntity:${P}`);
    });

    it('refuses an admin changing an owner, or granting owner', async () => {
      await expect(members.changeRole(userOf(ADMIN), P, OWNER2, 'admin', CTX)).rejects.toThrow(ROLE_REFUSAL);
      await expect(members.changeRole(userOf(ADMIN), P, MEMBER, 'owner', CTX)).rejects.toThrow(ROLE_REFUSAL);
      expect(roleOf(OWNER2)).toBe('owner');
      expect(roleOf(MEMBER)).toBe('member');
    });

    it('lets an owner grant owner, with a recent sign-in only', async () => {
      await expect(members.changeRole(userOf(OWNER2, false), P, MEMBER, 'owner', CTX)).rejects.toThrow(
        REAUTH_REQUIRED_MESSAGE,
      );
      expect(roleOf(MEMBER)).toBe('member');
      await members.changeRole(userOf(OWNER2), P, MEMBER, 'owner', CTX);
      expect(roleOf(MEMBER)).toBe('owner');
    });

    it('needs a recent sign-in to demote an owner, not to change an admin', async () => {
      await expect(members.changeRole(userOf(BILLING, false), P, OWNER2, 'admin', CTX)).rejects.toThrow(
        REAUTH_REQUIRED_MESSAGE,
      );
      await members.changeRole(userOf(BILLING, false), P, ADMIN, 'member', CTX);
      expect(roleOf(ADMIN)).toBe('member');
      await members.changeRole(userOf(BILLING), P, OWNER2, 'admin', CTX);
      expect(roleOf(OWNER2)).toBe('admin');
    });

    it('refuses demoting the billing owner (409)', async () => {
      await expect(members.changeRole(userOf(OWNER2), P, BILLING, 'admin', CTX)).rejects.toThrow(MOVE_BILLING_FIRST);
      expect(roleOf(BILLING)).toBe('owner');
    });

    it('asks a stale session to sign in again before any 409 about owners', async () => {
      await expect(members.changeRole(userOf(OWNER2, false), P, BILLING, 'admin', CTX)).rejects.toThrow(
        REAUTH_REQUIRED_MESSAGE,
      );
      await expect(members.remove(userOf(OWNER2, false), P, BILLING, CTX)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      project().ownerId = STRANGER;
      await members.remove(userOf(OWNER2), P, BILLING, CTX);
      // OWNER2 is now the last owner: still the re-auth prompt first.
      await expect(members.changeRole(userOf(OWNER2, false), P, OWNER2, 'admin', CTX)).rejects.toThrow(
        REAUTH_REQUIRED_MESSAGE,
      );
      expect(roleOf(OWNER2)).toBe('owner');
    });

    it('refuses demoting the last owner, counting owners from the rows', async () => {
      // Out of step with owner_id (never left so by the code, but the count is what guards it).
      project().ownerId = STRANGER;
      await members.changeRole(userOf(OWNER2), P, BILLING, 'member', CTX);
      expect(owners()).toBe(1);
      await expect(members.changeRole(userOf(OWNER2), P, OWNER2, 'admin', CTX)).rejects.toThrow(LAST_OWNER);
      expect(roleOf(OWNER2)).toBe('owner');
    });

    it('is a no-op for the same role, and 404 for someone not in the project', async () => {
      await expect(members.changeRole(userOf(OWNER2, false), P, BILLING, 'owner', CTX)).resolves.toBeUndefined();
      await expect(members.changeRole(userOf(ADMIN), P, STRANGER, 'member', CTX)).rejects.toThrow(MEMBER_NOT_FOUND);
    });

    it('re-reads the caller under the lock: an owner demoted meanwhile cannot demote another owner', async () => {
      // The guard saw OWNER2 as owner; by the time the lock is held they are an admin.
      m.tables.get(ProjectMemberEntity)!.find((r) => r.userId === OWNER2)!.role = 'admin';
      member(STRANGER, 'owner');
      await expect(members.changeRole(userOf(OWNER2), P, STRANGER, 'admin', CTX)).rejects.toThrow(ROLE_REFUSAL);
      // An admin made a member meanwhile no longer manages members at all.
      m.tables.get(ProjectMemberEntity)!.find((r) => r.userId === ADMIN)!.role = 'member';
      await expect(members.changeRole(userOf(ADMIN), P, MEMBER, 'admin', CTX)).rejects.toThrow(ROLE_REFUSAL);
      await expect(members.remove(userOf(ADMIN), P, MEMBER, CTX)).rejects.toThrow(ROLE_REFUSAL);
      expect(roleOf(MEMBER)).toBe('member');
      // And one removed meanwhile is not in the project at all.
      await expect(members.changeRole(userOf('00000000-0000-4000-8000-0000000000ff'), P, MEMBER, 'admin', CTX)).rejects.toThrow(
        PROJECT_NOT_FOUND,
      );
    });

    it('clears a pending billing offer to an owner it demotes', async () => {
      Object.assign(project(), { pendingBillingOwnerId: OWNER2, pendingBillingOfferedAt: new Date() });
      await members.changeRole(userOf(BILLING), P, OWNER2, 'admin', CTX);
      expect(project().pendingBillingOwnerId).toBeNull();
      expect(project().pendingBillingOfferedAt).toBeNull();
    });
  });

  describe('remove', () => {
    it('lets an admin remove a member, never an owner', async () => {
      await members.remove(userOf(ADMIN), P, MEMBER, CTX);
      expect(roleOf(MEMBER)).toBeUndefined();
      await expect(members.remove(userOf(ADMIN), P, OWNER2, CTX)).rejects.toThrow(ROLE_REFUSAL);
      expect(roleOf(OWNER2)).toBe('owner');
    });

    it('needs a recent sign-in to remove an owner, and clears an offer to them', async () => {
      Object.assign(project(), { pendingBillingOwnerId: OWNER2, pendingBillingOfferedAt: new Date() });
      await expect(members.remove(userOf(BILLING, false), P, OWNER2, CTX)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      expect(roleOf(OWNER2)).toBe('owner');
      await members.remove(userOf(BILLING), P, OWNER2, CTX);
      expect(roleOf(OWNER2)).toBeUndefined();
      expect(project().pendingBillingOwnerId).toBeNull();
    });

    it('refuses removing the billing owner, and the last owner', async () => {
      await expect(members.remove(userOf(OWNER2), P, BILLING, CTX)).rejects.toThrow(MOVE_BILLING_FIRST);
      project().ownerId = STRANGER;
      await members.remove(userOf(OWNER2), P, BILLING, CTX);
      await expect(members.remove(userOf(OWNER2), P, OWNER2, CTX)).rejects.toThrow(LAST_OWNER);
      expect(owners()).toBe(1);
    });

    it('is 404 for someone not in the project', async () => {
      await expect(members.remove(userOf(BILLING), P, STRANGER, CTX)).rejects.toThrow(MEMBER_NOT_FOUND);
    });
  });

  describe('leave', () => {
    it('needs a recent sign-in for an owner leaving, not for a member or an admin', async () => {
      await expect(members.leave(userOf(OWNER2, false), P, CTX)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
      expect(roleOf(OWNER2)).toBe('owner');
      await members.leave(userOf(MEMBER, false), P, CTX);
      await members.leave(userOf(ADMIN, false), P, CTX);
      expect(roleOf(MEMBER)).toBeUndefined();
      expect(roleOf(ADMIN)).toBeUndefined();
      await members.leave(userOf(OWNER2), P, CTX);
      expect(roleOf(OWNER2)).toBeUndefined();
    });

    it('asks a stale owner to sign in again before saying they are the billing or last owner', async () => {
      await expect(members.leave(userOf(BILLING, false), P, CTX)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
    });

    it('lets a member, an admin and a second owner leave', async () => {
      await members.leave(userOf(MEMBER), P, CTX);
      await members.leave(userOf(ADMIN), P, CTX);
      await members.leave(userOf(OWNER2), P, CTX);
      expect(m.tables.get(ProjectMemberEntity)!.map((r) => r.userId)).toEqual([BILLING]);
    });

    it('refuses the billing owner, and the last owner', async () => {
      await expect(members.leave(userOf(BILLING), P, CTX)).rejects.toThrow(MOVE_BILLING_FIRST);
      project().ownerId = STRANGER;
      await members.leave(userOf(BILLING), P, CTX);
      await expect(members.leave(userOf(OWNER2), P, CTX)).rejects.toThrow(LAST_OWNER);
    });

    it('clears an offer to whoever leaves, and is 404 for a non-member', async () => {
      Object.assign(project(), { pendingBillingOwnerId: OWNER2, pendingBillingOfferedAt: new Date() });
      await members.leave(userOf(OWNER2), P, CTX);
      expect(project().pendingBillingOwnerId).toBeNull();
      await expect(members.leave(userOf(STRANGER), P, CTX)).rejects.toThrow(PROJECT_NOT_FOUND);
    });
  });

  describe('billing transfer', () => {
    const offer = (to = OWNER2, at = new Date()) =>
      Object.assign(project(), { pendingBillingOwnerId: to, pendingBillingOfferedAt: at });

    it('offers to another owner, replacing an earlier offer', async () => {
      member(STRANGER, 'owner');
      await billing.offerBilling(userOf(BILLING), P, STRANGER, CTX);
      await billing.offerBilling(userOf(BILLING), P, OWNER2, CTX);
      expect(project().pendingBillingOwnerId).toBe(OWNER2);
      expect(project().pendingBillingOfferedAt).toBeInstanceOf(Date);
    });

    it('refuses an offer from an owner who is not the billing owner', async () => {
      await expect(billing.offerBilling(userOf(OWNER2), P, BILLING, CTX)).rejects.toThrow(ROLE_REFUSAL);
      await expect(billing.cancelBillingOffer(userOf(OWNER2), P, CTX)).rejects.toThrow(ROLE_REFUSAL);
    });

    it('refuses an offer to self, to a non-owner, or to a non-member', async () => {
      await expect(billing.offerBilling(userOf(BILLING), P, BILLING, CTX)).rejects.toThrow(BILLING_TARGET_NOT_OWNER);
      await expect(billing.offerBilling(userOf(BILLING), P, ADMIN, CTX)).rejects.toThrow(BILLING_TARGET_NOT_OWNER);
      await expect(billing.offerBilling(userOf(BILLING), P, STRANGER, CTX)).rejects.toThrow(MEMBER_NOT_FOUND);
      expect(project().pendingBillingOwnerId).toBeNull();
    });

    it('cancels an offer', async () => {
      offer();
      await billing.cancelBillingOffer(userOf(BILLING), P, CTX);
      expect(project().pendingBillingOwnerId).toBeNull();
    });

    it('moves owner_id on accept, locking the project then both users in ascending id', async () => {
      offer();
      await billing.acceptBilling(userOf(OWNER2), P, CTX);
      expect(project()).toMatchObject({ ownerId: OWNER2, pendingBillingOwnerId: null, pendingBillingOfferedAt: null });
      // OWNER2 (…02) sorts before BILLING (…09) whatever their parts.
      expect(m.locks).toEqual([`ProjectEntity:${P}`, `UserEntity:${OWNER2}`, `UserEntity:${BILLING}`]);
      expect(seats.assertRoomForTransfer).toHaveBeenCalledWith(m, OWNER2, P);
    });

    it('refuses accept with no offer, someone else\'s offer, or one older than 7 days', async () => {
      await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
      member(STRANGER, 'owner');
      offer(STRANGER);
      await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
      offer(OWNER2, new Date(Date.now() - 8 * 24 * 3600 * 1000));
      await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
      offer(OWNER2, new Date(Date.now() - 6 * 24 * 3600 * 1000));
      await billing.acceptBilling(userOf(OWNER2), P, CTX);
      expect(project().ownerId).toBe(OWNER2);
    });

    it('judges the offer by the database clock, not by Date.now()', async () => {
      // The API's clock is a month ahead; the database says the offer is a day old.
      const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 24 * 3600 * 1000);
      try {
        m.dbNow = () => spy.getMockImplementation()!() - 30 * 24 * 3600 * 1000;
        offer(OWNER2, new Date(m.dbNow() - 24 * 3600 * 1000));
        expect((await members.list(P, m as never)).billingOffer?.toUserId).toBe(OWNER2);
        await billing.acceptBilling(userOf(OWNER2), P, CTX);
        expect(project().ownerId).toBe(OWNER2);

        // And the other way: the API thinks it is fresh, the database says it lapsed.
        Object.assign(project(), { ownerId: BILLING });
        m.dbNow = () => spy.getMockImplementation()!() + 24 * 3600 * 1000;
        offer(OWNER2, new Date(m.dbNow() - 7 * 24 * 3600 * 1000 - 1000));
        expect((await members.list(P, m as never)).billingOffer).toBeNull();
        await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
      } finally {
        spy.mockRestore();
      }
    });

    describe('declining', () => {
      it('clears the offer to the caller and leaves the billing owner alone', async () => {
        offer();
        await billing.declineBilling(userOf(OWNER2), P, CTX);
        expect(project()).toMatchObject({ ownerId: BILLING, pendingBillingOwnerId: null, pendingBillingOfferedAt: null });
        expect(m.locks[0]).toBe(`ProjectEntity:${P}`);
      });

      it('refuses with no offer, an offer to someone else, or the billing owner, and changes nothing', async () => {
        await expect(billing.declineBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
        member(STRANGER, 'owner');
        const at = new Date();
        offer(STRANGER, at);
        for (const who of [OWNER2, BILLING]) {
          await expect(billing.declineBilling(userOf(who), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
        }
        expect(project()).toMatchObject({ ownerId: BILLING, pendingBillingOwnerId: STRANGER, pendingBillingOfferedAt: at });
      });
    });

    it('refuses accept by a receiver who is no longer an owner', async () => {
      offer();
      m.tables.get(ProjectMemberEntity)!.find((r) => r.userId === OWNER2)!.role = 'admin';
      await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_OFFER_GONE);
      expect(project().ownerId).toBe(BILLING);
    });

    it('refuses accept while either account is suspended', async () => {
      const users = m.tables.get(UserEntity)!;
      for (const suspended of [BILLING, OWNER2]) {
        offer();
        users.forEach((u) => (u.suspendedAt = u.id === suspended ? new Date() : null));
        await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(BILLING_SUSPENDED);
      }
      expect(project().ownerId).toBe(BILLING);
    });

    it('refuses accept that would take the receiver over their project limit, counting their billed projects', async () => {
      offer();
      m.tables.get(UserEntity)!.find((u) => u.id === OWNER2)!.projectLimit = 2;
      m.tables.get(ProjectEntity)!.push({ id: 'p-other-1', ownerId: OWNER2 });
      // Billed to someone else: does not count.
      m.tables.get(ProjectEntity)!.push({ id: 'p-other-2', ownerId: STRANGER });
      await billing.acceptBilling(userOf(OWNER2), P, CTX);
      expect(project().ownerId).toBe(OWNER2);

      // Back, and now at the limit.
      Object.assign(project(), { ownerId: BILLING });
      m.tables.get(ProjectEntity)!.push({ id: 'p-other-3', ownerId: OWNER2 });
      offer();
      await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(
        'You can have up to 2 projects. Delete one or contact support to raise the limit.',
      );
      expect(project().ownerId).toBe(BILLING);
    });

    it('refuses accept when the seat check refuses', async () => {
      offer();
      const { ForbiddenException } = await import('@nestjs/common');
      seats.assertRoomForTransfer.mockRejectedValueOnce(new ForbiddenException(SEAT_LIMIT_MESSAGE));
      await expect(billing.acceptBilling(userOf(OWNER2), P, CTX)).rejects.toThrow(SEAT_LIMIT_MESSAGE);
      expect(project().ownerId).toBe(BILLING);
    });
  });
});
