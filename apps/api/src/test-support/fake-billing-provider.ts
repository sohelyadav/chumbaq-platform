import {
  BillingEvent,
  BillingProvider,
  BillingProviderError,
  ProviderInvoice,
  ProviderPlan,
  ProviderSubscription,
} from '../modules/billing/providers/billing-provider';
import { RAZORPAY_ID_PATTERN, parseRazorpayEvent } from '../modules/billing/providers/razorpay-payload';
import { verifyRazorpaySignature } from '../modules/billing/providers/razorpay-signature';
import { InvalidProviderIdError } from '../modules/billing/providers/razorpay.provider';

type Method = Exclude<keyof BillingProvider, 'enabled' | 'keyId'>;

export const FAKE_BILLING_KEY_ID = 'rzp_test_FakeKey000001';
export const FAKE_BILLING_WEBHOOK_SECRET = 'fake_webhook_secret';

/**
 * A billing provider for integration specs, held in memory: no request leaves the
 * process. Override `BILLING_PROVIDER` with it through `bootIntApp`'s `providers`.
 *
 * It answers as Razorpay would where billing depends on it: ids it does not know
 * are a 400 `BillingProviderError`, ids that are not Razorpay-shaped are refused
 * before anything else, and webhooks are checked with the real signature check
 * and read by the real parser, so a spec signs the bodies it posts.
 */
export class FakeBillingProvider implements BillingProvider {
  readonly enabled = true;
  readonly keyId: string;
  readonly calls: Array<{ method: Method; args: unknown[] }> = [];
  readonly subscriptions = new Map<string, ProviderSubscription>();
  readonly plans = new Map<string, ProviderPlan>();
  readonly invoices = new Map<string, ProviderInvoice>();
  readonly customers = new Map<string, { name: string; email: string; gstin: string | null; accountRef: string }>();
  private readonly failures = new Map<Method, Error[]>();
  private readonly webhookSecret: string;
  private sequence = 0;

  constructor({
    keyId = FAKE_BILLING_KEY_ID,
    webhookSecret = FAKE_BILLING_WEBHOOK_SECRET,
  }: { keyId?: string; webhookSecret?: string } = {}) {
    this.keyId = keyId;
    this.webhookSecret = webhookSecret;
  }

  seedPlan(plan: ProviderPlan): void {
    this.plans.set(plan.id, { ...plan });
  }

  setSubscription(subscription: ProviderSubscription): void {
    this.subscriptions.set(subscription.id, { ...subscription });
  }

  addInvoice(invoice: ProviderInvoice): void {
    this.invoices.set(invoice.id, { ...invoice });
  }

  /** The next call of `method` throws `error` (queued: call it twice for two failures). */
  failNext(method: Method, error: Error): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  callsOf(method: Method): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  reset(): void {
    this.calls.length = 0;
    this.subscriptions.clear();
    this.plans.clear();
    this.invoices.clear();
    this.customers.clear();
    this.failures.clear();
  }

  async createCustomer(input: {
    name: string;
    email: string;
    gstin: string | null;
    accountRef: string;
  }): Promise<{ id: string }> {
    this.enter('createCustomer', [input]);
    const id = this.newId('cust');
    this.customers.set(id, { ...input });
    return { id };
  }

  async createSubscription(input: {
    planId: string;
    totalCount: number;
    startAt: Date | null;
    expireBy: Date;
    accountRef: string;
  }): Promise<ProviderSubscription> {
    this.enter('createSubscription', [input]);
    checkedId(input.planId, 'planId');
    if (!this.plans.has(input.planId)) throw notFound();
    const subscription: ProviderSubscription = {
      id: this.newId('sub'),
      planId: input.planId,
      customerId: null,
      status: 'created',
      currentStart: null,
      currentEnd: null,
      startAt: input.startAt,
      chargeAt: input.startAt,
      endedAt: null,
      paidCount: 0,
      shortUrl: `https://rzp.io/i/fake${this.sequence}`,
    };
    this.subscriptions.set(subscription.id, subscription);
    return { ...subscription };
  }

  async cancelSubscription(id: string, atCycleEnd: boolean): Promise<ProviderSubscription> {
    this.enter('cancelSubscription', [id, atCycleEnd]);
    const subscription = this.known(id);
    if (['cancelled', 'completed', 'expired'].includes(subscription.status)) {
      throw new BillingProviderError(400, 'BAD_REQUEST_ERROR', `Subscription is not cancellable in ${subscription.status} status.`);
    }
    // At cycle end Razorpay keeps the status until the period ends, then sends `cancelled`.
    if (!atCycleEnd) {
      subscription.status = 'cancelled';
      subscription.endedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    }
    return { ...subscription };
  }

  async fetchSubscription(id: string): Promise<ProviderSubscription> {
    this.enter('fetchSubscription', [id]);
    return { ...this.known(id) };
  }

  async fetchPlan(id: string): Promise<ProviderPlan> {
    this.enter('fetchPlan', [id]);
    checkedId(id, 'planId');
    const plan = this.plans.get(id);
    if (!plan) throw notFound();
    return { ...plan };
  }

  async listSubscriptionInvoices(subscriptionId: string): Promise<ProviderInvoice[]> {
    this.enter('listSubscriptionInvoices', [subscriptionId]);
    checkedId(subscriptionId, 'subscriptionId');
    return [...this.invoices.values()]
      .filter((invoice) => invoice.subscriptionId === subscriptionId)
      .map((invoice) => ({ ...invoice }));
  }

  async notifyInvoiceByEmail(invoiceId: string): Promise<void> {
    this.enter('notifyInvoiceByEmail', [invoiceId]);
    checkedId(invoiceId, 'invoiceId');
    if (!this.invoices.has(invoiceId)) throw notFound();
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    this.calls.push({ method: 'verifyWebhook', args: [rawBody, signature] });
    return verifyRazorpaySignature(rawBody, signature, this.webhookSecret);
  }

  parseWebhook(body: unknown): BillingEvent {
    this.calls.push({ method: 'parseWebhook', args: [body] });
    return parseRazorpayEvent(body);
  }

  private enter(method: Method, args: unknown[]): void {
    this.calls.push({ method, args });
    const queued = this.failures.get(method);
    const failure = queued?.shift();
    if (queued && queued.length === 0) this.failures.delete(method);
    if (failure) throw failure;
  }

  private known(id: string): ProviderSubscription {
    checkedId(id, 'subscriptionId');
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw notFound();
    return subscription;
  }

  private newId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake${String(this.sequence).padStart(10, '0')}`;
  }
}

function checkedId(value: string, field: string): void {
  if (typeof value !== 'string' || !RAZORPAY_ID_PATTERN.test(value)) throw new InvalidProviderIdError(field);
}

function notFound(): BillingProviderError {
  return new BillingProviderError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
}
