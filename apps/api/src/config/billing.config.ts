import { registerAs } from '@nestjs/config';

/**
 * Paid plans through Razorpay Subscriptions. Billing is off unless all three keys are
 * set, so a self-hosted install that sets none of them runs with no plans, no plan
 * limits and no billing routes. Some keys without the others stop the app rather than
 * quietly meaning off, unless `BILLING_ENABLED=false` says off on purpose.
 *
 * Error messages name variables only, never a value: a secret pasted into the wrong
 * variable must not reach a boot log.
 */
export interface BillingConfig {
  enabled: boolean;
  keyId: string | null;
  keySecret: string | null;
  webhookSecret: string | null;
  /** Days a halted subscription keeps its plan while the customer fixes the payment. */
  graceDays: number;
  /** From the key id: Razorpay's test mode or live mode. Null while billing is off. */
  keyMode: 'test' | 'live' | null;
}

export const DEFAULT_BILLING_GRACE_DAYS = 14;
export const MAX_BILLING_GRACE_DAYS = 60;

const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/;

function read(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function graceDays(raw: string | null): number {
  if (raw === null) return DEFAULT_BILLING_GRACE_DAYS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_BILLING_GRACE_DAYS) {
    throw new Error(`BILLING_GRACE_DAYS must be a whole number from 1 to ${MAX_BILLING_GRACE_DAYS}`);
  }
  return Number(raw);
}

export function readBillingConfig(env: Record<string, string | undefined>): BillingConfig {
  const days = graceDays(read(env, 'BILLING_GRACE_DAYS'));
  const off: BillingConfig = {
    enabled: false,
    keyId: null,
    keySecret: null,
    webhookSecret: null,
    graceDays: days,
    keyMode: null,
  };

  const switchValue = read(env, 'BILLING_ENABLED');
  if (switchValue !== null && switchValue !== 'true' && switchValue !== 'false') {
    throw new Error('BILLING_ENABLED must be true or false');
  }
  // Off on purpose: keep no key in memory, so nothing downstream can use one.
  if (switchValue === 'false') return off;

  const keyId = read(env, 'RAZORPAY_KEY_ID');
  const keySecret = read(env, 'RAZORPAY_KEY_SECRET');
  const webhookSecret = read(env, 'RAZORPAY_WEBHOOK_SECRET');
  const set = [keyId, keySecret, webhookSecret].filter((value) => value !== null).length;

  if (set === 0) {
    if (switchValue === 'true') {
      throw new Error(
        'BILLING_ENABLED is true, but RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are not set',
      );
    }
    return off;
  }
  if (set < 3) {
    throw new Error(
      'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET must be set together ' +
        '(or set BILLING_ENABLED=false to keep billing off)',
    );
  }

  const match = KEY_ID_PATTERN.exec(keyId as string);
  if (!match) {
    throw new Error('RAZORPAY_KEY_ID must look like rzp_test_… or rzp_live_…');
  }

  return {
    enabled: true,
    keyId,
    keySecret,
    webhookSecret,
    graceDays: days,
    keyMode: match[1] as 'test' | 'live',
  };
}

export default registerAs('billing', () => readBillingConfig(process.env));
