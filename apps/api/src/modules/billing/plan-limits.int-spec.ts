import { randomBytes, randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminTenantsService } from '../admin/admin-tenants.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { UserEntity } from '../users/entities/user.entity';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { BillingTransferService } from '../project-access/billing-transfer.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { SEAT_LIMIT_MESSAGE, SeatsService } from '../project-access/seats.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ProjectsService } from '../projects/projects.service';
import { AccountLimitsService, projectLimitMessage } from './account-limits.service';

/**
 * Project and seat limits from the effective plan, through the real services and
 * database, with billing on and off over the same rows. Billing off is exactly the
 * staff override or the install default; billing on is the plan, where the free
 * plan takes the override either way and a paid plan only upwards. Going over a
 * limit, by billing being switched on or a plan changing, removes nothing: only
 * the next create, invite or transfer is refused.
 *
 * Sets limits on the shared `free` plan for the run and clears them afterwards.
 */
describe('plan limits (integration)', () => {
  const DOMAIN = '@plan-limits-int.test';
  const ENV_PROJECTS = 10;
  const CTX = { ipAddress: '203.0.113.9', userAgent: 'jest' };
  let ds: DataSource;
  const suffix = randomBytes(5).toString('hex');
  const PAID = `plan_scratch_${suffix}_paid`;
  const UNLIMITED_SEATS = `plan_scratch_${suffix}_open`;
  const priceOf: Record<string, string> = {};
  const users: string[] = [];

  interface Services {
    projects: ProjectsService;
    seats: SeatsService;
    transfer: BillingTransferService;
    tenants: AdminTenantsService;
  }

  const build = (billingEnabled: boolean, maxSeatsPerAccount: number | null = null): Services => {
    const limits = new AccountLimitsService(
      new ConfigService({
        billing: { enabled: billingEnabled },
        projects: { maxPerAccount: ENV_PROJECTS, maxSeatsPerAccount },
      }),
    );
    const seats = new SeatsService(ds, limits);
    const activity = new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({}));
    return {
      projects: new ProjectsService(
        ds.getRepository(ProjectEntity),
        limits,
        new ProjectAccessService(null as never, null as never, null as never, null as never),
        seats,
        activity,
      ),
      seats,
      transfer: new BillingTransferService(ds, seats, activity, limits),
      tenants: new AdminTenantsService(
        ds.getRepository(UserEntity),
        ds.getRepository(AdminAuditLogEntity),
        new AdminAuditService(ds.getRepository(AdminAuditLogEntity)),
        { factorResetCancelled: () => undefined } as never,
        seats,
        limits,
      ),
    };
  };
  let on: Services;
  let off: Services;

  const account = async (opts: { projectLimit?: number | null; seatLimit?: number | null } = {}): Promise<string> => {
    const id = randomUUID();
    users.push(id);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, project_limit, seat_limit) VALUES ($1, $2, 'x', 'plan', $3, $4)`,
      [id, `${id}${DOMAIN}`, opts.projectLimit ?? null, opts.seatLimit ?? null],
    );
    return id;
  };

  const subscribe = async (userId: string, planCode: string): Promise<void> => {
    const [sub] = await ds.query(
      `INSERT INTO billing_subscriptions
         (user_id, provider_subscription_id, price_id, plan_code, interval, status, current_end)
       VALUES ($1, $2, $3, $4, 'monthly', 'active', now() + interval '20 days') RETURNING id`,
      [userId, `sub_${randomBytes(7).toString('hex')}`, priceOf[planCode], planCode],
    );
    await ds.query(`INSERT INTO billing_accounts (user_id, current_subscription_id) VALUES ($1, $2)`, [userId, sub.id]);
  };

  /** Straight into the table, as projects made before billing was on would be. */
  const existing = async (ownerId: string, count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const [{ id }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`, [
        `old ${i}`,
        ownerId,
      ]);
      await addOwnerMember(ds, id, ownerId);
      ids.push(id);
    }
    return ids;
  };

  const emailOf = (id: string) => `${id}${DOMAIN}`;
  const caller = (userId: string) => ({ userId, email: emailOf(userId), isSuperAdmin: false });
  const create = (s: Services, ownerId: string) => s.projects.create(ownerId, { name: 'app', domain: 'example.com' } as never);
  const countOf = async (ownerId: string): Promise<number> =>
    Number((await ds.query(`SELECT count(*) AS n FROM projects WHERE owner_id = $1`, [ownerId]))[0].n);
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error,
    );
  const assertRoom = (s: Services, owner: string, email: string) =>
    ds.transaction((manager) => s.seats.assertRoomFor(manager, owner, email));
  const pagination = () => Object.assign(new PaginationDto(), { page: 1, limit: 50 });

  beforeAll(async () => {
    ds = await openIntDb();
    on = build(true);
    off = build(false);
    await ds.query(`UPDATE plans SET project_limit = 1, seat_limit = 2 WHERE code = 'free'`);
    for (const [code, projectLimit, seatLimit, sortOrder] of [
      [PAID, 3, 5, 10],
      [UNLIMITED_SEATS, 4, null, 20],
    ] as const) {
      await ds.query(
        `INSERT INTO plans (code, name, project_limit, seat_limit, sort_order) VALUES ($1, 'Scratch', $2, $3, $4)`,
        [code, projectLimit, seatLimit, sortOrder],
      );
      const [price] = await ds.query(
        `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
         VALUES ($1, 'monthly', 99900, 1800, 117882, $2, true) RETURNING id`,
        [code, `plan_${randomBytes(7).toString('hex')}`],
      );
      priceOf[code] = price.id;
    }
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`UPDATE plans SET project_limit = NULL, seat_limit = NULL WHERE code = 'free'`);
      await ds.query(`DELETE FROM billing_accounts WHERE user_id = ANY($1)`, [users]);
      await ds.query(`DELETE FROM billing_subscriptions WHERE user_id = ANY($1)`, [users]);
      await ds.query(`DELETE FROM projects WHERE owner_id = ANY($1)`, [users]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    }
    await closeIntDb(ds);
  });

  describe('projects', () => {
    it('billing on, free plan: the plan limit applies, with the plan wording', async () => {
      const owner = await account();
      await create(on, owner);
      const error = await refusal(create(on, owner));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as Error).message).toBe(projectLimitMessage(1, true));
      expect((error as Error).message).toBe(
        'You can have up to 1 projects on your plan. Upgrade your plan or delete one.',
      );
      expect(await countOf(owner)).toBe(1);
    });

    it('billing off over the same rows: the install default, as before plans', async () => {
      const owner = await account();
      await create(off, owner);
      await create(off, owner);
      expect(await countOf(owner)).toBe(2);
      await existing(owner, ENV_PROJECTS - 2);
      const error = await refusal(create(off, owner));
      expect((error as Error).message).toBe(projectLimitMessage(ENV_PROJECTS));
    });

    it('billing on, paid: the plan limit, which a lower override does not cut', async () => {
      const owner = await account({ projectLimit: 2 });
      await subscribe(owner, PAID);
      await existing(owner, 2);
      await create(on, owner);
      const error = await refusal(create(on, owner));
      expect((error as Error).message).toBe(projectLimitMessage(3, true));
      expect(await countOf(owner)).toBe(3);
      // Billing off, the override is the limit again.
      expect((await refusal(create(off, owner)) as Error).message).toBe(projectLimitMessage(2));
    });

    it('billing on, free: a staff override replaces the plan limit', async () => {
      const owner = await account({ projectLimit: 5 });
      await existing(owner, 4);
      await create(on, owner);
      expect(await countOf(owner)).toBe(5);
      expect((await refusal(create(on, owner)) as Error).message).toBe(projectLimitMessage(5, true));
    });

    it('the list shows the limit that create checks', async () => {
      const owner = await account();
      await subscribe(owner, PAID);
      const listed = await on.projects.findAllByUser(caller(owner), pagination());
      expect(listed.meta).toMatchObject({ projectLimit: 3, seats: { limit: 5 } });
      expect((await off.projects.findAllByUser(caller(owner), pagination())).meta).toMatchObject({
        projectLimit: ENV_PROJECTS,
        seats: { limit: null },
      });
    });
  });

  describe('the tenant page', () => {
    it('shows the effective plan and the limits create and invite check', async () => {
      const owner = await account({ projectLimit: 2 });
      await subscribe(owner, PAID);
      expect(await on.tenants.findOne(owner)).toMatchObject({
        plan: PAID,
        projectLimit: 2,
        effectiveProjectLimit: 3,
        effectiveSeatLimit: 5,
      });
      expect(await off.tenants.findOne(owner)).toMatchObject({
        plan: 'free',
        projectLimit: 2,
        effectiveProjectLimit: 2,
        effectiveSeatLimit: null,
      });
      const freeOwner = await account();
      expect(await on.tenants.findOne(freeOwner)).toMatchObject({
        plan: 'free',
        effectiveProjectLimit: 1,
        effectiveSeatLimit: 2,
      });
    });
  });

  describe('seats', () => {
    it('billing on, free plan: a third person is refused; a plan with no seat limit takes them', async () => {
      const owner = await account();
      const [projectId] = await existing(owner, 1);
      const colleague = await account();
      await addOwnerMember(ds, projectId, colleague, 'member');

      await expect(assertRoom(on, owner, 'third@plan-limits-int.test')).rejects.toThrow(SEAT_LIMIT_MESSAGE);
      // Billing off, no install seat limit: no limit at all.
      await expect(assertRoom(off, owner, 'third@plan-limits-int.test')).resolves.toBeUndefined();

      await subscribe(owner, UNLIMITED_SEATS);
      await expect(assertRoom(on, owner, 'third@plan-limits-int.test')).resolves.toBeUndefined();
    });
  });

  describe('the free plan with no seat limit of its own', () => {
    const ENV_SEATS = 2;
    afterEach(async () => {
      await ds.query(`UPDATE plans SET seat_limit = 2 WHERE code = 'free'`);
    });

    it('keeps the install seat default when billing goes on; a paid plan with none stays unlimited', async () => {
      await ds.query(`UPDATE plans SET seat_limit = NULL WHERE code = 'free'`);
      const withDefault = build(true, ENV_SEATS);
      const owner = await account();
      const [projectId] = await existing(owner, 1);
      await addOwnerMember(ds, projectId, await account(), 'member');

      await expect(assertRoom(withDefault, owner, 'third@plan-limits-int.test')).rejects.toThrow(SEAT_LIMIT_MESSAGE);
      expect((await withDefault.projects.findAllByUser(caller(owner), pagination())).meta.seats).toEqual({
        used: 2,
        limit: ENV_SEATS,
      });
      expect(await withDefault.tenants.findOne(owner)).toMatchObject({ plan: 'free', effectiveSeatLimit: ENV_SEATS });
      // The same as billing off over the same rows.
      await expect(assertRoom(build(false, ENV_SEATS), owner, 'third@plan-limits-int.test')).rejects.toThrow(
        SEAT_LIMIT_MESSAGE,
      );

      await subscribe(owner, UNLIMITED_SEATS);
      await expect(assertRoom(withDefault, owner, 'third@plan-limits-int.test')).resolves.toBeUndefined();
    });
  });

  describe('billing transfer', () => {
    /** X bills a project with R as another owner, and has offered billing to R. */
    const offered = async (receiverPlan: string | null) => {
      const x = await account();
      const r = await account();
      if (receiverPlan) await subscribe(r, receiverPlan);
      const [p] = await existing(x, 1);
      await addOwnerMember(ds, p, r, 'owner');
      await ds.query(
        `UPDATE projects SET pending_billing_owner_id = $2, pending_billing_offered_at = now() WHERE id = $1`,
        [p, r],
      );
      await existing(r, 1);
      return { x, r, p };
    };

    it("the receiver's effective plan decides the project limit at accept", async () => {
      const free = await offered(null);
      const error = await refusal(on.transfer.acceptBilling(caller(free.r) as never, free.p, CTX));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as Error).message).toBe(projectLimitMessage(1, true));
      expect(await countOf(free.r)).toBe(1);

      const paid = await offered(PAID);
      await on.transfer.acceptBilling(caller(paid.r) as never, paid.p, CTX);
      expect(await countOf(paid.r)).toBe(2);

      // Billing off, the free receiver is within the install default.
      await off.transfer.acceptBilling(caller(free.r) as never, free.p, CTX);
      expect(await countOf(free.r)).toBe(2);
    });
  });

  describe('over limit keeps', () => {
    it('projects: an account past the free limit when billing goes on keeps them all', async () => {
      const owner = await account();
      const made = [await create(off, owner), await create(off, owner), await create(off, owner)];
      expect(made).toHaveLength(3);

      const listed = await on.projects.findAllByUser(caller(owner), pagination());
      expect(listed.data).toHaveLength(3);
      expect(listed.meta).toMatchObject({ projectLimit: 1, billedProjects: 3 });

      const error = await refusal(create(on, owner));
      expect((error as Error).message).toBe(projectLimitMessage(1, true));
      expect(await countOf(owner)).toBe(3);
    });

    it('projects: a downgrade below current use removes nothing', async () => {
      const owner = await account();
      await subscribe(owner, PAID);
      await create(on, owner);
      await create(on, owner);
      await create(on, owner);
      await ds.query(`UPDATE billing_subscriptions SET status = 'cancelled' WHERE user_id = $1`, [owner]);
      expect((await on.projects.findAllByUser(caller(owner), pagination())).data).toHaveLength(3);
      expect((await refusal(create(on, owner)) as Error).message).toBe(projectLimitMessage(1, true));
      expect(await countOf(owner)).toBe(3);
    });

    it('seats: people already on the account stay, and only someone new is refused', async () => {
      const owner = await account();
      const [projectId] = await existing(owner, 1);
      const a = await account();
      const b = await account();
      await addOwnerMember(ds, projectId, a, 'member');
      await addOwnerMember(ds, projectId, b, 'member');

      const listed = await on.projects.findAllByUser(caller(owner), pagination());
      expect(listed.meta.seats).toEqual({ used: 3, limit: 2 });
      await expect(assertRoom(on, owner, 'new@plan-limits-int.test')).rejects.toThrow(SEAT_LIMIT_MESSAGE);
      // Someone already counted needs no new seat.
      await expect(assertRoom(on, owner, emailOf(a))).resolves.toBeUndefined();
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM project_members WHERE project_id = $1`, [
        projectId,
      ]);
      expect(n).toBe(3);
    });
  });
});
