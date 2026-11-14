import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { SEAT_LIMIT_MESSAGE, SeatsService } from './seats.service';
import { AccountLimitsService } from '../billing/account-limits.service';

const DOMAIN = '@seats-int.test';

describe('Seats (integration)', () => {
  let ds: DataSource;
  let seats: SeatsService;

  const user = async (name: string, seatLimit: number | null = null): Promise<string> => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, seat_limit) VALUES ($1, $2, 'x', $3, $4)`,
      [id, `${name}${DOMAIN}`, name, seatLimit],
    );
    return id;
  };

  const project = async (ownerId: string): Promise<string> => {
    const [{ id }] = await ds.query(
      `INSERT INTO projects (name, owner_id) VALUES ('p', $1) RETURNING id`,
      [ownerId],
    );
    await ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId]);
    return id;
  };

  const member = (projectId: string, userId: string, role = 'member') =>
    ds.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)`, [projectId, userId, role]);

  const invite = async (
    projectId: string,
    email: string,
    state: 'pending' | 'expired' | 'revoked' | 'accepted' = 'pending',
  ): Promise<string> => {
    const [{ id }] = await ds.query(
      `INSERT INTO project_invitations (project_id, email, role, token_hash, expires_at, accepted_at, revoked_at)
       VALUES ($1, $2, 'member', $3,
         now() + (CASE WHEN $4 = 'expired' THEN interval '-1 day' ELSE interval '7 days' END),
         CASE WHEN $4 = 'accepted' THEN now() END, CASE WHEN $4 = 'revoked' THEN now() END)
       RETURNING id`,
      [projectId, email, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), state],
    );
    return id;
  };

  const cleanUp = async () => {
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const assertRoom = (owner: string, email: string, opts = {}) =>
    ds.transaction((manager) => seats.assertRoomFor(manager, owner, email, opts));

  beforeAll(async () => {
    ds = await openIntDb();
    seats = new SeatsService(ds, new AccountLimitsService(new ConfigService({ projects: { maxSeatsPerAccount: null } })));
  });
  afterAll(async () => {
    await cleanUp();
    await closeIntDb(ds);
  });
  beforeEach(cleanUp);

  describe('count', () => {
    it('is 1 for an owner alone, even with no project', async () => {
      const owner = await user('alone');
      expect(await seats.count(owner)).toBe(1);
      await project(owner);
      expect(await seats.count(owner)).toBe(1);
    });

    it('counts a person who is on two billed projects once', async () => {
      const owner = await user('o');
      const dev = await user('dev');
      const [a, b] = [await project(owner), await project(owner)];
      await member(a, dev);
      await member(b, dev, 'admin');
      expect(await seats.count(owner)).toBe(2);
    });

    it('counts a pending invite to a new email', async () => {
      const owner = await user('o');
      const p = await project(owner);
      await invite(p, `new${DOMAIN}`);
      expect(await seats.count(owner)).toBe(2);
    });

    it('counts two invites to the same new email on two projects once', async () => {
      const owner = await user('o');
      const [a, b] = [await project(owner), await project(owner)];
      await invite(a, `new${DOMAIN}`);
      await invite(b, `new${DOMAIN}`);
      expect(await seats.count(owner)).toBe(2);
    });

    it('does not count a pending invite to an existing member or to the owner', async () => {
      const owner = await user('o');
      const dev = await user('dev');
      const p = await project(owner);
      await member(p, dev);
      await invite(p, `dev${DOMAIN}`);
      await invite(p, `o${DOMAIN}`);
      expect(await seats.count(owner)).toBe(2);
    });

    it('does not count an expired, revoked or accepted invite', async () => {
      const owner = await user('o');
      const p = await project(owner);
      await invite(p, `expired${DOMAIN}`, 'expired');
      await invite(p, `revoked${DOMAIN}`, 'revoked');
      await invite(p, `accepted${DOMAIN}`, 'accepted');
      expect(await seats.count(owner)).toBe(1);
    });

    it('does not count membership of a project billed to someone else', async () => {
      const mine = await user('mine');
      const other = await user('other');
      const theirs = await project(other);
      await project(mine);
      await member(theirs, mine);
      await invite(theirs, `guest${DOMAIN}`);
      expect(await seats.count(mine)).toBe(1);
      expect(await seats.count(other)).toBe(3);
    });

    it('counts a project about to be transferred in, when asked to', async () => {
      const owner = await user('o');
      const other = await user('other');
      const dev = await user('dev');
      await project(owner);
      const incoming = await project(other);
      await member(incoming, dev);
      expect(await seats.count(owner)).toBe(1);
      expect(await seats.count(owner, undefined, { extraProjectId: incoming })).toBe(3);
    });
  });

  describe('assertRoomFor', () => {
    const limited = async (limit: number, name = 'o') => {
      const owner = await user(name, limit);
      const p = await project(owner);
      return { owner, p };
    };
    const refused = (promise: Promise<unknown>) =>
      expect(promise).rejects.toThrow(new ForbiddenException(SEAT_LIMIT_MESSAGE));

    it('allows anyone when there is no limit', async () => {
      const owner = await user('o');
      const p = await project(owner);
      for (let i = 0; i < 5; i++) await invite(p, `n${i}${DOMAIN}`);
      await assertRoom(owner, `another${DOMAIN}`);
    });

    it('allows a new person while a seat is free and refuses when full', async () => {
      const { owner } = await limited(2);
      await assertRoom(owner, `first${DOMAIN}`);
      const { owner: full, p } = await limited(2, 'full');
      await invite(p, `taken${DOMAIN}`);
      await refused(assertRoom(full, `second${DOMAIN}`));
    });

    it('needs no new seat for an existing member, the owner, or someone already invited', async () => {
      const { owner, p } = await limited(2);
      const dev = await user('dev');
      await member(p, dev);
      await assertRoom(owner, `DEV${DOMAIN}`);
      await assertRoom(owner, `o${DOMAIN}`.toUpperCase());
      const { owner: o2, p: p2 } = await limited(2, 'o2');
      await invite(p2, `invited${DOMAIN}`);
      await assertRoom(o2, `Invited${DOMAIN}`);
    });

    it('counts an expired invite as a free seat', async () => {
      const { owner, p } = await limited(2);
      await invite(p, `stale${DOMAIN}`, 'expired');
      await assertRoom(owner, `fresh${DOMAIN}`);
    });

    it('lets a pending invite be accepted at the limit, but not past it', async () => {
      const { owner, p } = await limited(2);
      const id = await invite(p, `joiner${DOMAIN}`);
      await assertRoom(owner, `joiner${DOMAIN}`, { acceptingInvitationId: id });

      await ds.query(`UPDATE users SET seat_limit = 1 WHERE id = $1`, [owner]);
      await refused(assertRoom(owner, `joiner${DOMAIN}`, { acceptingInvitationId: id }));
    });

    it('treats an accept with an id that is not a live invitation as a new invitation', async () => {
      const { owner, p } = await limited(2, 'acc');
      const revoked = await invite(p, `gone${DOMAIN}`, 'revoked');
      await invite(p, `taken${DOMAIN}`);
      await refused(assertRoom(owner, `gone${DOMAIN}`, { acceptingInvitationId: revoked }));
      await refused(assertRoom(owner, `other${DOMAIN}`, { acceptingInvitationId: randomUUID() }));
    });

    it('does not take an invitation of another account as the one being accepted', async () => {
      const { owner } = await limited(1, 'mine');
      const { p: theirs } = await limited(5, 'theirs');
      const foreign = await invite(theirs, `joiner${DOMAIN}`);
      await refused(assertRoom(owner, `joiner${DOMAIN}`, { acceptingInvitationId: foreign }));
    });

    it('uses the environment limit when the account has no override', async () => {
      const capped = new SeatsService(ds, new AccountLimitsService(new ConfigService({ projects: { maxSeatsPerAccount: 1 } })));
      const owner = await user('o');
      await project(owner);
      await expect(
        ds.transaction((m) => capped.assertRoomFor(m, owner, `x${DOMAIN}`)),
      ).rejects.toThrow(SEAT_LIMIT_MESSAGE);
    });
  });

  describe('assertRoomForTransfer', () => {
    const transfer = (receiver: string, projectId: string) =>
      ds.transaction((m) => seats.assertRoomForTransfer(m, receiver, projectId));
    const refused = (promise: Promise<unknown>) =>
      expect(promise).rejects.toThrow(new ForbiddenException(SEAT_LIMIT_MESSAGE));

    const incomingProject = async () => {
      const seller = await user('seller');
      const p = await project(seller);
      await member(p, await user('m1'));
      await member(p, await user('m2'));
      return p; // seller + m1 + m2
    };

    it('refuses a receiver at one seat taking a project with other members', async () => {
      const p = await incomingProject();
      const receiver = await user('receiver', 1);
      await refused(transfer(receiver, p));
    });

    it('allows it when the limit covers receiver plus everyone on the project', async () => {
      const p = await incomingProject();
      const small = await user('small', 3);
      await refused(transfer(small, p)); // receiver + 3 = 4
      const receiver = await user('receiver', 4);
      await transfer(receiver, p);
    });

    it('counts a person on both accounts once', async () => {
      const p = await incomingProject();
      const receiver = await user('receiver', 4);
      const own = await project(receiver);
      await member(own, (await ds.query(`SELECT id FROM users WHERE email = $1`, [`m1${DOMAIN}`]))[0].id);
      // receiver, seller, m1 (shared), m2 = 4
      await transfer(receiver, p);
      await ds.query(`UPDATE users SET seat_limit = 3 WHERE id = $1`, [receiver]);
      await refused(transfer(receiver, p));
    });

    it('allows any transfer when the receiver has no limit', async () => {
      const p = await incomingProject();
      await transfer(await user('free'), p);
    });
  });
});
