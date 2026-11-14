import { ConfigService } from '@nestjs/config';
import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { AccountLimitsService, projectLimitMessage } from './account-limits.service';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';
import { PlanEntity } from './entities/plan.entity';

const NOW = new Date('2026-12-15T00:00:00Z');
const DAY = 24 * 3600_000;

/**
 * A manager that answers like the tables: `findOne` matches a row only when every
 * key of `where` equals the row's value (so an unknown id matches nothing), and
 * `find` returns the rows matching `where`, or all of them.
 */
function tablesManager(tables: Map<EntityTarget<ObjectLiteral>, ObjectLiteral[]>): EntityManager {
  const matching = (entity: EntityTarget<ObjectLiteral>, where: Record<string, unknown> = {}) =>
    (tables.get(entity) ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
  return {
    findOne: async (entity: EntityTarget<ObjectLiteral>, options: { where: Record<string, unknown> }) =>
      matching(entity, options.where)[0] ?? null,
    find: async (entity: EntityTarget<ObjectLiteral>, options: { where?: Record<string, unknown> } = {}) =>
      matching(entity, options.where),
  } as unknown as EntityManager;
}

function config(billingEnabled: boolean, seatDefault: number | null = 25): ConfigService {
  return new ConfigService({
    billing: { enabled: billingEnabled },
    projects: { maxPerAccount: 10, maxSeatsPerAccount: seatDefault },
  });
}

const USER = '0d5a3b9e-6e3e-4a59-9d2f-4b8f2f3b1a01';

function plans(free: Partial<PlanEntity> | null = { projectLimit: 2, seatLimit: 3, mauLimit: 1000 }) {
  const rows: Partial<PlanEntity>[] = [
    { code: 'pro', sortOrder: 2, projectLimit: 5, seatLimit: null, mauLimit: 50_000 },
    { code: 'team', sortOrder: 1, projectLimit: 3, seatLimit: 8, mauLimit: 10_000 },
  ];
  if (free) rows.push({ code: 'free', sortOrder: 0, projectLimit: null, seatLimit: null, mauLimit: null, ...free });
  return rows;
}

function subscription(id: string, overrides: Partial<BillingSubscriptionEntity> = {}): Partial<BillingSubscriptionEntity> {
  return {
    id,
    userId: USER,
    planCode: 'pro',
    interval: 'monthly',
    status: 'active',
    currentEnd: new Date(NOW.getTime() + 10 * DAY),
    startAt: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function manager(opts: {
  user?: Partial<UserEntity>;
  account?: Partial<BillingAccountEntity> | null;
  subscriptions?: Partial<BillingSubscriptionEntity>[];
  plans?: Partial<PlanEntity>[];
}): EntityManager {
  return tablesManager(
    new Map<EntityTarget<ObjectLiteral>, ObjectLiteral[]>([
      [UserEntity, [{ id: USER, projectLimit: null, seatLimit: null, ...opts.user }]],
      [BillingAccountEntity, opts.account ? [{ userId: USER, ...opts.account }] : []],
      [BillingSubscriptionEntity, opts.subscriptions ?? []],
      [PlanEntity, opts.plans ?? plans()],
    ]),
  );
}

const PRO_ACCOUNT = { currentSubscriptionId: 'sub-1', nextSubscriptionId: null, compPlanCode: null, compUntil: null };

describe('AccountLimitsService', () => {
  describe('billing off', () => {
    const service = new AccountLimitsService(config(false));

    it('gives the install default whatever the billing rows say', async () => {
      const m = manager({ account: PRO_ACCOUNT, subscriptions: [subscription('sub-1')] });
      expect(await service.limitsFor(m, USER, NOW)).toEqual({
        projectLimit: 10,
        seatLimit: 25,
        mauLimit: null,
        plan: { planCode: 'free', source: 'free', until: null },
        billingEnabled: false,
      });
    });

    it('gives the staff override, even below a plan', async () => {
      const m = manager({ user: { projectLimit: 3, seatLimit: 0 }, account: { ...PRO_ACCOUNT, compPlanCode: 'pro' } });
      expect(await service.limitsFor(m, USER, NOW)).toMatchObject({ projectLimit: 3, seatLimit: 0, mauLimit: null });
    });

    it('has no seat limit when the install sets none', async () => {
      const off = new AccountLimitsService(config(false, null));
      expect((await off.limitsFor(manager({}), USER, NOW)).seatLimit).toBeNull();
    });

    it('falls back to the built-in project default with no config at all', async () => {
      const bare = new AccountLimitsService(new ConfigService({}));
      expect(await bare.limitsFor(manager({}), USER, NOW)).toMatchObject({
        projectLimit: 10,
        seatLimit: null,
        billingEnabled: false,
      });
    });
  });

  describe('billing on', () => {
    const service = new AccountLimitsService(config(true));

    it('gives an account with no billing row the free plan', async () => {
      expect(await service.limitsFor(manager({}), USER, NOW)).toEqual({
        projectLimit: 2,
        seatLimit: 3,
        mauLimit: 1000,
        plan: { planCode: 'free', source: 'free', until: null },
        billingEnabled: true,
      });
    });

    it('gives an unknown account the free plan, with no override', async () => {
      expect(await service.limitsFor(manager({}), 'e3b7a1f0-0000-4000-8000-000000000000', NOW)).toMatchObject({
        projectLimit: 2,
        seatLimit: 3,
        plan: { planCode: 'free', source: 'free' },
      });
    });

    it('gives the install defaults when there is no free plan row (a dev database)', async () => {
      expect(await service.limitsFor(manager({ plans: plans(null) }), USER, NOW)).toMatchObject({
        projectLimit: 10,
        seatLimit: 25,
        mauLimit: null,
      });
    });

    it('gives a live subscription its plan, and a lower override does not cut it', async () => {
      const m = manager({
        user: { projectLimit: 1, seatLimit: 1 },
        account: PRO_ACCOUNT,
        subscriptions: [subscription('sub-1')],
      });
      expect(await service.limitsFor(m, USER, NOW)).toEqual({
        projectLimit: 5,
        seatLimit: null,
        mauLimit: 50_000,
        plan: { planCode: 'pro', source: 'subscription', until: null },
        billingEnabled: true,
      });
    });

    it('reads the subscription the account points at, not another of the user', async () => {
      const m = manager({
        account: { ...PRO_ACCOUNT, currentSubscriptionId: 'sub-2' },
        subscriptions: [subscription('sub-1'), subscription('sub-2', { planCode: 'team' })],
      });
      expect(await service.limitsFor(m, USER, NOW)).toMatchObject({ projectLimit: 3, seatLimit: 8, plan: { planCode: 'team' } });
    });

    it('gives a comp its plan', async () => {
      const m = manager({ account: { ...PRO_ACCOUNT, currentSubscriptionId: null, compPlanCode: 'team' } });
      expect(await service.limitsFor(m, USER, NOW)).toMatchObject({
        projectLimit: 3,
        seatLimit: 8,
        plan: { planCode: 'team', source: 'comp', until: null },
      });
    });

    it('takes the time it is given: a halted subscription past its grace is free', async () => {
      const m = manager({
        account: PRO_ACCOUNT,
        subscriptions: [subscription('sub-1', { status: 'halted', graceUntil: new Date(NOW.getTime() + DAY) })],
      });
      expect((await service.limitsFor(m, USER, NOW)).plan.planCode).toBe('pro');
      expect((await service.limitsFor(m, USER, new Date(NOW.getTime() + 2 * DAY))).plan.planCode).toBe('free');
    });

    it('ranks plans by sort order, unknown codes with nothing', async () => {
      const rank = await service.planRanks(manager({}));
      expect([rank('free'), rank('team'), rank('pro'), rank('gone')]).toEqual([0, 1, 2, 0]);
    });
  });

  it('words the project limit for each mode', () => {
    expect(projectLimitMessage(10)).toBe(
      'You can have up to 10 projects. Delete one or contact support to raise the limit.',
    );
    expect(projectLimitMessage(1, true)).toBe(
      'You can have up to 1 projects on your plan. Upgrade your plan or delete one.',
    );
  });
});
