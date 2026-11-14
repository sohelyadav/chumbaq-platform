import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { effectivePlan, SubscriptionState } from './effective-plan';
import { BILLING_STATE_JOINS, effectivePlanCodeSql, toBillingState } from './effective-plan-sql';
import { EFFECTIVE_PLAN_CASES, now, RANKS, state } from './effective-plan.cases';
import { BillingAccountEntity } from './entities/billing-account.entity';
import { BillingSubscriptionEntity } from './entities/billing-subscription.entity';

/**
 * The SQL form of the effective plan, run against real rows built from every case
 * of the TypeScript rule, must give the same plan code as `effectivePlan` computed
 * from those same rows. Breaking either alone turns a row red.
 */
describe('effective plan in SQL (integration)', () => {
  let ds: DataSource;
  const suffix = randomBytes(5).toString('hex');
  /** The case table's plan codes, as fresh plans in the shared int database. */
  const codeOf: Record<string, string> = { free: 'free' };
  const priceOf: Record<string, string> = {};
  const users: Array<{ id: string; label: string; expected: string }> = [];

  beforeAll(async () => {
    ds = await openIntDb();
    for (const [code, sortOrder] of Object.entries(RANKS)) {
      if (code === 'free') continue;
      const real = `plan_scratch_${suffix}_${code}`;
      codeOf[code] = real;
      await ds.query(`INSERT INTO plans (code, name, sort_order) VALUES ($1, $2, $3)`, [real, code, sortOrder]);
      const [price] = await ds.query(
        `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id)
         VALUES ($1, 'monthly', 99900, 1800, 117882, $2) RETURNING id`,
        [real, `plan_${randomBytes(7).toString('hex')}`],
      );
      priceOf[real] = price.id;
    }

    const insertSubscription = async (userId: string, s: SubscriptionState): Promise<string> => {
      const planCode = codeOf[s.planCode];
      const [row] = await ds.query(
        `INSERT INTO billing_subscriptions
           (user_id, provider_subscription_id, price_id, plan_code, interval, status,
            current_end, start_at, grace_until, cancel_at_period_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          userId,
          `sub_${randomBytes(7).toString('hex')}`,
          priceOf[planCode],
          planCode,
          s.interval,
          s.status,
          s.currentEnd,
          s.startAt,
          s.graceUntil,
          s.cancelAtPeriodEnd,
        ],
      );
      return row.id;
    };

    const extraCases: Array<[string, ReturnType<typeof state>, string, boolean]> = [
      ['an account row with nothing set', state(), 'free', true],
    ];
    const all: Array<[string, ReturnType<typeof state>, string, boolean]> = [
      ...EFFECTIVE_PLAN_CASES.map(
        ([label, input, code]) =>
          [label, input, code, input.comp !== null || input.current !== null || input.next !== null] as [
            string,
            ReturnType<typeof state>,
            string,
            boolean,
          ],
      ),
      ...extraCases,
    ];

    for (const [label, input, code, withAccount] of all) {
      const userId = randomUUID();
      await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'plan')`, [
        userId,
        `plan-sql-${userId}@test.local`,
      ]);
      if (withAccount) {
        const current = input.current ? await insertSubscription(userId, input.current) : null;
        const next = input.next ? await insertSubscription(userId, input.next) : null;
        await ds.query(
          `INSERT INTO billing_accounts (user_id, current_subscription_id, next_subscription_id, comp_plan_code, comp_until)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, current, next, input.comp ? codeOf[input.comp.planCode] : null, input.comp?.until ?? null],
        );
      }
      users.push({ id: userId, label, expected: codeOf[code] });
    }
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  it('gives every case the plan the TypeScript rule gives on the same rows', async () => {
    const rows: Array<{ id: string; code: string }> = await ds.query(
      `SELECT u.id, ${effectivePlanCodeSql('$1')} AS code FROM users u ${BILLING_STATE_JOINS} WHERE u.id = ANY($2)`,
      [now, users.map((u) => u.id)],
    );
    const sqlCode = new Map(rows.map((r) => [r.id, r.code]));

    const accounts = ds.getRepository(BillingAccountEntity);
    const subscriptions = ds.getRepository(BillingSubscriptionEntity);
    const results: Array<{ label: string; sql: string | undefined; ts: string; expected: string }> = [];
    for (const user of users) {
      const account = await accounts.findOneBy({ userId: user.id });
      const cur = account?.currentSubscriptionId
        ? await subscriptions.findOneBy({ id: account.currentSubscriptionId })
        : null;
      const nxt = account?.nextSubscriptionId ? await subscriptions.findOneBy({ id: account.nextSubscriptionId }) : null;
      const ts = effectivePlan(toBillingState(account, cur, nxt), now).planCode;
      results.push({ label: user.label, sql: sqlCode.get(user.id), ts, expected: user.expected });
    }

    expect(results.filter((r) => r.sql !== r.ts || r.ts !== r.expected)).toEqual([]);
    expect(results).toHaveLength(EFFECTIVE_PLAN_CASES.length + 1);
  });

  it('gives a user with no billing row the free plan', async () => {
    const userId = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'plan')`, [
      userId,
      `plan-sql-${userId}@test.local`,
    ]);
    const [row] = await ds.query(
      `SELECT ${effectivePlanCodeSql('$1')} AS code FROM users u ${BILLING_STATE_JOINS} WHERE u.id = $2`,
      [now, userId],
    );
    expect(row.code).toBe('free');
    expect(toBillingState(null, null, null)).toEqual({ comp: null, current: null, next: null });
  });
});
