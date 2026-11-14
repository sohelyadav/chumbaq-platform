import type { DataSource } from 'typeorm';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { FakeBillingProvider } from '../../test-support/fake-billing-provider';
import { BILLING_PROVIDER, BillingProvider } from './providers/billing-provider';
import { NullBillingProvider } from './providers/null-billing.provider';

/**
 * Both APIs boot with no Razorpay keys (int-env.ts blanks them) and get the null
 * provider, and a spec can swap in the fake through `bootIntApp`.
 */
describe('BILLING_PROVIDER in the booted apps', () => {
  const booted: BootedApp[] = [];
  let ds: DataSource;

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    for (const { app } of booted) await app.close();
    await closeIntDb(ds);
  });

  async function boot(which: 'customer' | 'admin', providers?: Array<{ token: unknown; useValue: unknown }>) {
    const app = await bootIntApp(which, { providers });
    booted.push(app);
    return app.app.get<BillingProvider>(BILLING_PROVIDER, { strict: false });
  }

  it.each(['customer', 'admin'] as const)('is the null provider in the %s API with no keys', async (which) => {
    const provider = await boot(which);
    expect(provider).toBeInstanceOf(NullBillingProvider);
    expect(provider.enabled).toBe(false);
    expect(provider.keyId).toBeNull();
  });

  it('is the fake when a spec overrides it', async () => {
    const fake = new FakeBillingProvider();
    expect(await boot('customer', [{ token: BILLING_PROVIDER, useValue: fake }])).toBe(fake);
  });
});
