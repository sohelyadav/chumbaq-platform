import type { BillingEvent, BillingProvider, ProviderInvoice, ProviderPlan, ProviderSubscription } from './billing-provider';

const NOT_CONFIGURED = 'Billing is not configured';

/**
 * The provider while billing is off (no Razorpay keys, or `BILLING_ENABLED=false`).
 * Every billing route answers 404 before reaching it; should anything call it
 * anyway, it refuses rather than reach a provider, and no webhook verifies.
 */
export class NullBillingProvider implements BillingProvider {
  readonly enabled = false;
  readonly keyId = null;

  async createCustomer(): Promise<{ id: string }> {
    throw new Error(NOT_CONFIGURED);
  }

  async createSubscription(): Promise<ProviderSubscription> {
    throw new Error(NOT_CONFIGURED);
  }

  async cancelSubscription(): Promise<ProviderSubscription> {
    throw new Error(NOT_CONFIGURED);
  }

  async fetchSubscription(): Promise<ProviderSubscription> {
    throw new Error(NOT_CONFIGURED);
  }

  async fetchPlan(): Promise<ProviderPlan> {
    throw new Error(NOT_CONFIGURED);
  }

  async listSubscriptionInvoices(): Promise<ProviderInvoice[]> {
    throw new Error(NOT_CONFIGURED);
  }

  async notifyInvoiceByEmail(): Promise<void> {
    throw new Error(NOT_CONFIGURED);
  }

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): BillingEvent {
    throw new Error(NOT_CONFIGURED);
  }
}
