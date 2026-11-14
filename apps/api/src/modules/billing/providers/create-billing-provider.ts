import type { BillingConfig } from '../../../config/billing.config';
import type { BillingProvider } from './billing-provider';
import { NullBillingProvider } from './null-billing.provider';
import { RazorpayProvider } from './razorpay.provider';

/** Razorpay when billing is on (all three keys set), otherwise the null provider. */
export function createBillingProvider(config: BillingConfig | undefined): BillingProvider {
  if (!config?.enabled) return new NullBillingProvider();
  if (!config.keyId || !config.keySecret || !config.webhookSecret) {
    throw new Error('Billing is enabled without its keys');
  }
  return new RazorpayProvider({
    keyId: config.keyId,
    keySecret: config.keySecret,
    webhookSecret: config.webhookSecret,
  });
}
