import { readBillingConfig } from '../../../config/billing.config';
import { createBillingProvider } from './create-billing-provider';
import { NullBillingProvider } from './null-billing.provider';
import { RazorpayProvider } from './razorpay.provider';

describe('createBillingProvider', () => {
  it('is the null provider with no keys, as a self-hosted install runs', () => {
    const provider = createBillingProvider(readBillingConfig({}));
    expect(provider).toBeInstanceOf(NullBillingProvider);
    expect(provider.enabled).toBe(false);
    expect(provider.keyId).toBeNull();
    expect(provider.verifyWebhook(Buffer.from('{}'), 'a'.repeat(64))).toBe(false);
  });

  it('is the null provider when the config is missing altogether', () => {
    expect(createBillingProvider(undefined)).toBeInstanceOf(NullBillingProvider);
  });

  it('is the null provider when billing is switched off, keys or not', () => {
    const config = readBillingConfig({
      BILLING_ENABLED: 'false',
      RAZORPAY_KEY_ID: 'rzp_test_AbC123xyz',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec',
    });
    expect(createBillingProvider(config)).toBeInstanceOf(NullBillingProvider);
  });

  it('is Razorpay when all three keys are set', () => {
    const provider = createBillingProvider(
      readBillingConfig({
        RAZORPAY_KEY_ID: 'rzp_test_AbC123xyz',
        RAZORPAY_KEY_SECRET: 'secret',
        RAZORPAY_WEBHOOK_SECRET: 'whsec',
      }),
    );
    expect(provider).toBeInstanceOf(RazorpayProvider);
    expect(provider.enabled).toBe(true);
    expect(provider.keyId).toBe('rzp_test_AbC123xyz');
  });

  it('refuses a config that says enabled but holds no keys', () => {
    expect(() =>
      createBillingProvider({ ...readBillingConfig({}), enabled: true }),
    ).toThrow('Billing is enabled without its keys');
  });

  it('refuses every call of the null provider', async () => {
    const provider = new NullBillingProvider();
    await expect(provider.fetchPlan()).rejects.toThrow('Billing is not configured');
    await expect(provider.createSubscription()).rejects.toThrow('Billing is not configured');
    expect(() => provider.parseWebhook()).toThrow('Billing is not configured');
  });
});
