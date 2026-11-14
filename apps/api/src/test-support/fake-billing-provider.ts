import { randomBytes } from 'crypto';
import {
  BillingEvent,
  BillingProvider,
  BillingProviderError,
  ProviderCustomer,
  ProviderInvoice,
  ProviderPlan,
  ProviderSubscription,
} from '../modules/billing/providers/billing-provider';
import { razorpayCustomerEmail, razorpayCustomerName } from '../modules/billing/providers/razorpay-customer';
import { RAZORPAY_ID_PATTERN, parseRazorpayEvent } from '../modules/billing/providers/razorpay-payload';
import { verifyRazorpaySignature } from '../modules/billing/providers/razorpay-signature';
import { InvalidProviderIdError, RazorpayProvider } from '../modules/billing/providers/razorpay.provider';

type Method = Exclude<keyof BillingProvider, 'enabled' | 'keyId'>;

export const FAKE_BILLING_KEY_ID = 'rzp_test_FakeKey000001';
export const FAKE_BILLING_WEBHOOK_SECRET = 'fake_webhook_secret';

/** Razorpay's list defaults: 10 items a page unless `count` asks for more, and never over 100. */
const LIST_DEFAULT_COUNT = 10;
const LIST_MAX_COUNT = 100;

/**
 * A billing provider for integration specs, held in memory: no request leaves the
 * process. Override `BILLING_PROVIDER` with it through `bootIntApp`'s `providers`.
 *
 * It answers as Razorpay would where billing depends on it: ids it does not know
 * are a 400 `BillingProviderError`, ids that are not Razorpay-shaped are refused
 * before anything else, and webhooks are checked with the real signature check
 * and read by the real parser, so a spec signs the bodies it posts.
 *
 * Invoices are listed the way Razorpay lists them, not handed over whole: the real
 * `RazorpayProvider.listSubscriptionInvoices` runs against an in-memory
 * `GET /v1/invoices` that answers newest first, 10 a page unless `count` asks for
 * more (at most 100, a 400 beyond), from `skip`. So a spec with more invoices than
 * one page holds goes red if the provider stops paging. Their times come back in
 * whole seconds, as Razorpay's do. Customer names and emails go through Razorpay's
 * rules (`razorpay-customer.ts`), so the fake refuses what Razorpay would.
 */
export class FakeBillingProvider implements BillingProvider {
  readonly enabled = true;
  readonly keyId: string;
  readonly calls: Array<{ method: Method; args: unknown[] }> = [];
  readonly subscriptions = new Map<string, ProviderSubscription>();
  readonly plans = new Map<string, ProviderPlan>();
  readonly invoices = new Map<string, ProviderInvoice>();
  readonly customers = new Map<string, { name: string; email: string; gstin: string | null; accountRef: string | null }>();
  /** Every `GET /v1/invoices` URL the listing asked for, in order. */
  readonly invoiceListRequests: string[] = [];
  private readonly failures = new Map<Method, Error[]>();
  private readonly webhookSecret: string;
  private sequence = 0;
  private readonly run = randomBytes(5).toString('hex');

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

  /** Add invoices in the order they were issued: lists answer newest first. */
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
    this.invoiceListRequests.length = 0;
    this.failures.clear();
  }

  async createCustomer(input: {
    name: string;
    email: string;
    gstin: string | null;
    accountRef: string;
  }): Promise<ProviderCustomer> {
    this.enter('createCustomer', [input]);
    const name = razorpayCustomerName(input.name);
    const email = razorpayCustomerEmail(input.email);
    // `fail_existing: "0"`: a customer with this email already is answered as it is,
    // its own notes and GSTIN, whatever was sent.
    for (const [id, existing] of this.customers) {
      if (existing.email === email) return { id, accountRef: existing.accountRef, gstin: existing.gstin };
    }
    const id = this.newId('cust');
    this.customers.set(id, { ...input, name, email });
    return { id, accountRef: input.accountRef, gstin: input.gstin };
  }

  async updateCustomerName(id: string, name: string): Promise<void> {
    this.enter('updateCustomerName', [id, name]);
    checkedId(id, 'customerId');
    const customer = this.customers.get(id);
    if (!customer) throw notFound();
    customer.name = razorpayCustomerName(name);
  }

  /** A customer made outside billing (another product on the same account), as Razorpay would hold it. */
  seedCustomer(customer: { name: string; email: string; gstin: string | null; accountRef: string | null }): string {
    const id = this.newId('cust');
    this.customers.set(id, { ...customer });
    return id;
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
    const lister = new RazorpayProvider({ keyId: this.keyId, keySecret: 'unused', webhookSecret: 'unused' }, (input) =>
      Promise.resolve(this.answerInvoiceList(String(input))),
    );
    return lister.listSubscriptionInvoices(subscriptionId);
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

  /** `GET /v1/invoices?subscription_id=…&count=…&skip=…`, answered as Razorpay answers it. */
  answerInvoiceList(url: string): Response {
    this.invoiceListRequests.push(url);
    const parsed = new URL(url);
    if (parsed.pathname !== '/v1/invoices') throw new Error(`Unexpected request: ${url}`);
    const count = parsed.searchParams.has('count') ? Number(parsed.searchParams.get('count')) : LIST_DEFAULT_COUNT;
    const skip = parsed.searchParams.has('skip') ? Number(parsed.searchParams.get('skip')) : 0;
    if (count > LIST_MAX_COUNT) return razorpayError(400, `The count may not be greater than ${LIST_MAX_COUNT}.`);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(skip) || skip < 0) {
      return razorpayError(400, 'The count and skip must be whole numbers.');
    }
    const subscriptionId = parsed.searchParams.get('subscription_id');
    const items = [...this.invoices.values()]
      .filter((invoice) => invoice.subscriptionId === subscriptionId)
      .reverse()
      .slice(skip, skip + count)
      .map(toRazorpayInvoice);
    return new Response(JSON.stringify({ entity: 'collection', count: items.length, items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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

  /**
   * Unique across runs too: the integration database is kept, and provider ids are
   * unique columns there, so ids from an earlier run must not come back.
   */
  private newId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake${this.run}${String(this.sequence).padStart(6, '0')}`;
  }
}

function checkedId(value: string, field: string): void {
  if (typeof value !== 'string' || !RAZORPAY_ID_PATTERN.test(value)) throw new InvalidProviderIdError(field);
}

const seconds = (value: Date | null): number | null => (value === null ? null : Math.floor(value.getTime() / 1000));

function toRazorpayInvoice(invoice: ProviderInvoice): Record<string, unknown> {
  return {
    id: invoice.id,
    entity: 'invoice',
    subscription_id: invoice.subscriptionId,
    customer_id: invoice.customerId,
    payment_id: invoice.paymentId,
    status: invoice.status,
    amount: invoice.amountPaise,
    tax_amount: invoice.providerTaxPaise,
    currency: invoice.currency,
    billing_start: seconds(invoice.billingStart),
    billing_end: seconds(invoice.billingEnd),
    issued_at: seconds(invoice.issuedAt),
    paid_at: seconds(invoice.paidAt),
    short_url: invoice.shortUrl,
    invoice_number: invoice.number,
  };
}

function razorpayError(status: number, description: string): Response {
  return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): BillingProviderError {
  return new BillingProviderError(400, 'BAD_REQUEST_ERROR', 'The id provided does not exist');
}
