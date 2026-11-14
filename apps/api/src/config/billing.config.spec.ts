import { readBillingConfig } from './billing.config';

const KEYS = {
  RAZORPAY_KEY_ID: 'rzp_test_AbC123xyz',
  RAZORPAY_KEY_SECRET: 's',
  RAZORPAY_WEBHOOK_SECRET: 'w',
};

describe('readBillingConfig', () => {
  it('is off with nothing set', () => {
    expect(readBillingConfig({})).toEqual({
      enabled: false,
      keyId: null,
      keySecret: null,
      webhookSecret: null,
      graceDays: 14,
      keyMode: null,
      taxRateBps: 0,
    });
  });

  it('is on when all three keys are set', () => {
    expect(readBillingConfig(KEYS)).toEqual({
      enabled: true,
      keyId: 'rzp_test_AbC123xyz',
      keySecret: 's',
      webhookSecret: 'w',
      graceDays: 14,
      keyMode: 'test',
      taxRateBps: 0,
    });
  });

  it('stays off with all three keys and BILLING_ENABLED=false, holding no secret', () => {
    const config = readBillingConfig({ ...KEYS, BILLING_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
    expect(config.keySecret).toBeNull();
    expect(config.webhookSecret).toBeNull();
  });

  it('refuses some keys without the others', () => {
    const together = /RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET must be set together/;
    expect(() => readBillingConfig({ RAZORPAY_KEY_ID: KEYS.RAZORPAY_KEY_ID })).toThrow(together);
    expect(() =>
      readBillingConfig({ RAZORPAY_KEY_ID: KEYS.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: 's' }),
    ).toThrow(together);
    expect(() => readBillingConfig({ RAZORPAY_WEBHOOK_SECRET: 'w' })).toThrow(together);
    // An empty value counts as unset, not as a key.
    expect(() => readBillingConfig({ ...KEYS, RAZORPAY_WEBHOOK_SECRET: '  ' })).toThrow(together);
  });

  it('lets BILLING_ENABLED=false keep partial keys from stopping the app', () => {
    expect(readBillingConfig({ RAZORPAY_KEY_ID: KEYS.RAZORPAY_KEY_ID, BILLING_ENABLED: 'false' }).enabled).toBe(
      false,
    );
  });

  it('refuses BILLING_ENABLED=true without keys, and anything but true or false', () => {
    expect(() => readBillingConfig({ BILLING_ENABLED: 'true' })).toThrow(/BILLING_ENABLED/);
    expect(() => readBillingConfig({ ...KEYS, BILLING_ENABLED: 'yes' })).toThrow(
      /BILLING_ENABLED must be true or false/,
    );
    expect(readBillingConfig({ ...KEYS, BILLING_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('refuses a key id that is not a Razorpay key id', () => {
    for (const id of ['key_123', 'rzp_test_', 'rzp_prod_AbC123xyz', 'rzp_test_AbC12', 'rzp_test_AbC-123xyz']) {
      expect(() => readBillingConfig({ ...KEYS, RAZORPAY_KEY_ID: id })).toThrow(
        /RAZORPAY_KEY_ID must look like rzp_test_… or rzp_live_…/,
      );
    }
  });

  it('reads BILLING_TAX_RATE_BPS as a whole number from 0 to 10000, default 0, billing on or off', () => {
    for (const raw of ['-1', '10001', '18.5', '18%', 'gst', '1e3', '0x10']) {
      expect(() => readBillingConfig({ BILLING_TAX_RATE_BPS: raw })).toThrow(
        /BILLING_TAX_RATE_BPS must be a whole number from 0 to 10000/,
      );
      expect(() => readBillingConfig({ ...KEYS, BILLING_TAX_RATE_BPS: raw })).toThrow(/BILLING_TAX_RATE_BPS/);
    }
    expect(readBillingConfig({}).taxRateBps).toBe(0);
    expect(readBillingConfig({ BILLING_TAX_RATE_BPS: ' ' }).taxRateBps).toBe(0);
    expect(readBillingConfig({ BILLING_TAX_RATE_BPS: '0' }).taxRateBps).toBe(0);
    expect(readBillingConfig({ ...KEYS, BILLING_TAX_RATE_BPS: '1800' }).taxRateBps).toBe(1800);
    expect(readBillingConfig({ BILLING_TAX_RATE_BPS: '10000' }).taxRateBps).toBe(10000);
  });

  it('reads BILLING_GRACE_DAYS as a whole number from 1 to 60', () => {
    for (const raw of ['0', '61', '7.5', '-1', 'two', '1e1']) {
      expect(() => readBillingConfig({ BILLING_GRACE_DAYS: raw })).toThrow(/BILLING_GRACE_DAYS/);
    }
    expect(readBillingConfig({ BILLING_GRACE_DAYS: '30' }).graceDays).toBe(30);
    expect(readBillingConfig({ BILLING_GRACE_DAYS: '1' }).graceDays).toBe(1);
    expect(readBillingConfig({ BILLING_GRACE_DAYS: '60' }).graceDays).toBe(60);
    expect(readBillingConfig({ BILLING_GRACE_DAYS: ' ' }).graceDays).toBe(14);
  });

  it('trims values', () => {
    const config = readBillingConfig({
      RAZORPAY_KEY_ID: ' rzp_live_X1y2Z3 ',
      RAZORPAY_KEY_SECRET: ' s ',
      RAZORPAY_WEBHOOK_SECRET: '\tw\n',
    });
    expect(config).toMatchObject({ keyMode: 'live', keyId: 'rzp_live_X1y2Z3', keySecret: 's', webhookSecret: 'w' });
  });

  it('never puts a secret in an error message', () => {
    const SECRET = 'SUPERSECRET';
    const cases: Array<Record<string, string>> = [
      { RAZORPAY_KEY_SECRET: SECRET },
      { RAZORPAY_WEBHOOK_SECRET: SECRET },
      { RAZORPAY_KEY_ID: 'key_123', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: SECRET },
      { ...KEYS, RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: SECRET, BILLING_ENABLED: 'yes' },
      { ...KEYS, RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: SECRET, BILLING_GRACE_DAYS: '0' },
    ];
    for (const env of cases) {
      let message = '';
      try {
        readBillingConfig(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(SECRET);
    }
  });
});
