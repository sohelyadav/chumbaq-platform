import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';

/**
 * The billing tables as the migration builds them: keys, the `free` plan and its
 * trigger, the price arithmetic CHECK, one current price per plan and interval,
 * the subscription status list, and what deleting a user does.
 *
 * The int database is shared and kept, so every case uses fresh plan codes,
 * provider ids and users.
 */
describe('billing schema (integration)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  const hex = (bytes = 5) => randomBytes(bytes).toString('hex');
  const scratchCode = () => `plan_scratch_${hex()}`;
  const providerPlanId = () => `plan_${hex(7)}`;

  const primaryKey = async (table: string): Promise<string[]> => {
    const rows: { column_name: string }[] = await ds.query(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [table],
    );
    return rows.map((r) => r.column_name);
  };

  const newUser = async (): Promise<string> => {
    const id = randomUUID();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'billing')`, [
      id,
      `billing-${id}@test.local`,
    ]);
    return id;
  };

  const newPlan = async (code = scratchCode()): Promise<string> => {
    await ds.query(`INSERT INTO plans (code, name, sort_order) VALUES ($1, 'Scratch', 50)`, [code]);
    return code;
  };

  const newPrice = async (
    planCode: string,
    overrides: Partial<{ interval: string; price: number; bps: number; amount: number; current: boolean; rzp: string }> = {},
  ): Promise<string> => {
    const price = overrides.price ?? 99900;
    const bps = overrides.bps ?? 1800;
    const [row] = await ds.query(
      `INSERT INTO plan_prices (plan_code, interval, price_paise, tax_rate_bps, amount_paise, razorpay_plan_id, is_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        planCode,
        overrides.interval ?? 'monthly',
        price,
        bps,
        overrides.amount ?? 117882,
        overrides.rzp ?? providerPlanId(),
        overrides.current ?? false,
      ],
    );
    return row.id;
  };

  const newSubscription = async (userId: string, priceId: string, planCode: string, status = 'created') => {
    const [row] = await ds.query(
      `INSERT INTO billing_subscriptions (user_id, provider_subscription_id, price_id, plan_code, interval, status)
       VALUES ($1, $2, $3, $4, 'monthly', $5) RETURNING id`,
      [userId, `sub_${hex(7)}`, priceId, planCode, status],
    );
    return row.id as string;
  };

  it('creates the four tables with their primary keys', async () => {
    expect(await primaryKey('plans')).toEqual(['code']);
    expect(await primaryKey('plan_prices')).toEqual(['id']);
    expect(await primaryKey('billing_accounts')).toEqual(['user_id']);
    expect(await primaryKey('billing_subscriptions')).toEqual(['id']);
  });

  it('matches the entities, so dev (synchronize) and migrated databases agree', async () => {
    const pending = await ds.driver.createSchemaBuilder().log();
    const tables = /"(plans|plan_prices|billing_accounts|billing_subscriptions)"/;
    expect(pending.upQueries.map((q) => q.query).filter((q) => tables.test(q))).toEqual([]);
  });

  it('seeds the free plan with no limits of its own', async () => {
    const [free] = await ds.query(
      `SELECT name, mau_limit, project_limit, seat_limit, sort_order, is_active FROM plans WHERE code = 'free'`,
    );
    expect(free).toEqual({
      name: 'Free',
      mau_limit: null,
      project_limit: null,
      seat_limit: null,
      sort_order: 0,
      is_active: true,
    });
  });

  it('keeps the free plan: no delete, no switching off, no rename', async () => {
    await expect(ds.query(`DELETE FROM plans WHERE code = 'free'`)).rejects.toThrow(/free plan cannot be deleted/);
    await expect(ds.query(`UPDATE plans SET is_active = false WHERE code = 'free'`)).rejects.toThrow(
      /free plan cannot be renamed or switched off/,
    );
    await expect(ds.query(`UPDATE plans SET code = 'gratis' WHERE code = 'free'`)).rejects.toThrow(
      /free plan cannot be renamed or switched off/,
    );
    // Its name and limits stay editable.
    await ds.query(`UPDATE plans SET name = name WHERE code = 'free'`);

    const code = await newPlan();
    await ds.query(`UPDATE plans SET is_active = false WHERE code = $1`, [code]);
    const [row] = await ds.query(`SELECT is_active FROM plans WHERE code = $1`, [code]);
    expect(row.is_active).toBe(false);
    await ds.query(`DELETE FROM plans WHERE code = $1`, [code]);
  });

  it('refuses truncating plans', async () => {
    await expect(ds.query(`TRUNCATE plans CASCADE`)).rejects.toThrow(/plans cannot be truncated/);
  });

  it('refuses a plan code or limit outside its rules', async () => {
    await expect(newPlan('Upper')).rejects.toThrow(/CHK_plans_code/);
    await expect(newPlan('x')).rejects.toThrow(/CHK_plans_code/);
    await expect(
      ds.query(`INSERT INTO plans (code, name, project_limit) VALUES ($1, 'x', 0)`, [scratchCode()]),
    ).rejects.toThrow(/CHK_plans_project_limit/);
    await expect(
      ds.query(`INSERT INTO plans (code, name, project_limit) VALUES ($1, 'x', 1001)`, [scratchCode()]),
    ).rejects.toThrow(/CHK_plans_project_limit/);
    await expect(
      ds.query(`INSERT INTO plans (code, name, seat_limit) VALUES ($1, 'x', 0)`, [scratchCode()]),
    ).rejects.toThrow(/CHK_plans_seat_limit/);
  });

  it('holds amount_paise to the price plus GST rounded half up', async () => {
    const code = await newPlan();
    await newPrice(code, { price: 99900, bps: 1800, amount: 117882 });
    await expect(newPrice(code, { price: 99900, bps: 1800, amount: 117881 })).rejects.toThrow(
      /CHK_plan_prices_amount/,
    );
    await expect(newPrice(code, { price: 99900, bps: 1800, amount: 117883 })).rejects.toThrow(
      /CHK_plan_prices_amount/,
    );
    // Half rounds up: 3 * 18% = 0.54 -> 1, so 4; 1 * 18% = 0.18 -> 0, so 1.
    await newPrice(code, { price: 3, bps: 1800, amount: 4 });
    await newPrice(code, { price: 1, bps: 1800, amount: 1 });
    // price * bps overflows int4 here; the CHECK is computed in bigint.
    await newPrice(code, { price: 2_000_000_000, bps: 0, amount: 2_000_000_000 });
    await newPrice(code, { price: 1_500_000_000, bps: 1800, amount: 1_770_000_000 });
    await expect(newPrice(code, { price: 0, bps: 1800, amount: 0 })).rejects.toThrow(
      /CHK_plan_prices_price_positive/,
    );
  });

  it('allows one current price per plan and interval', async () => {
    const code = await newPlan();
    await newPrice(code, { interval: 'monthly', current: true });
    await newPrice(code, { interval: 'yearly', current: true });
    await newPrice(code, { interval: 'monthly', current: false });
    await expect(newPrice(code, { interval: 'monthly', current: true })).rejects.toThrow(/UQ_plan_prices_current/);
    await expect(newPrice(code, { interval: 'weekly' })).rejects.toThrow(/CHK_plan_prices_interval/);
  });

  it('refuses a duplicate provider plan id and any price for free', async () => {
    const code = await newPlan();
    const rzp = providerPlanId();
    await newPrice(code, { rzp });
    await expect(newPrice(code, { rzp })).rejects.toThrow(/duplicate key/);
    await expect(newPrice('free')).rejects.toThrow(/CHK_plan_prices_not_free/);
  });

  it('accepts only the provider statuses and unique provider subscription ids', async () => {
    const user = await newUser();
    const code = await newPlan();
    const price = await newPrice(code);
    await expect(newSubscription(user, price, code, 'superseded')).rejects.toThrow(
      /CHK_billing_subscriptions_status/,
    );
    const providerId = `sub_${hex(7)}`;
    const insert = () =>
      ds.query(
        `INSERT INTO billing_subscriptions (user_id, provider_subscription_id, price_id, plan_code, interval, status)
         VALUES ($1, $2, $3, $4, 'monthly', 'created')`,
        [user, providerId, price, code],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('points an account at its subscriptions, checked unless deferred', async () => {
    const user = await newUser();
    const code = await newPlan();
    const price = await newPrice(code);
    await expect(
      ds.query(`INSERT INTO billing_accounts (user_id, current_subscription_id) VALUES ($1, $2)`, [user, randomUUID()]),
    ).rejects.toThrow(/FK_billing_accounts_current/);

    // Deferred, the pointer may be written before the row it names.
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET CONSTRAINTS "FK_billing_accounts_next" DEFERRED`);
      const subId = randomUUID();
      await qr.query(`INSERT INTO billing_accounts (user_id, next_subscription_id) VALUES ($1, $2)`, [user, subId]);
      await qr.query(
        `INSERT INTO billing_subscriptions (id, user_id, provider_subscription_id, price_id, plan_code, interval, status)
         VALUES ($1, $2, $3, $4, $5, 'monthly', 'created')`,
        [subId, user, `sub_${hex(7)}`, price, code],
      );
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
    const [account] = await ds.query(`SELECT next_subscription_id FROM billing_accounts WHERE user_id = $1`, [user]);
    expect(account.next_subscription_id).not.toBeNull();
  });

  it('deletes an account row with its user, and refuses deleting a user who has a subscription', async () => {
    const plain = await newUser();
    await ds.query(`INSERT INTO billing_accounts (user_id, legal_name) VALUES ($1, 'Acme')`, [plain]);
    await ds.query(`DELETE FROM users WHERE id = $1`, [plain]);
    const left = await ds.query(`SELECT 1 FROM billing_accounts WHERE user_id = $1`, [plain]);
    expect(left).toHaveLength(0);

    const subscribed = await newUser();
    const code = await newPlan();
    await newSubscription(subscribed, await newPrice(code), code);
    await expect(ds.query(`DELETE FROM users WHERE id = $1`, [subscribed])).rejects.toThrow(
      /FK_billing_subscriptions_user/,
    );
  });

  it('accepts MAU notice levels 80 and 100 only', async () => {
    const user = await newUser();
    await expect(
      ds.query(`INSERT INTO billing_accounts (user_id, mau_notice_level) VALUES ($1, 90)`, [user]),
    ).rejects.toThrow(/CHK_billing_accounts_mau_notice_level/);
    await ds.query(
      `INSERT INTO billing_accounts (user_id, mau_notice_month, mau_notice_level) VALUES ($1, '2026-11-01', 80)`,
      [user],
    );
    await ds.query(`DELETE FROM users WHERE id = $1`, [user]);
  });
});
