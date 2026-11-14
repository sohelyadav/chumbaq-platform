import { PROVIDER_REQUEST_TIMEOUT_MS } from '../../push-notifications/services/per-recipient-provider';
import {
  BillingEvent,
  BillingProvider,
  BillingProviderError,
  ProviderCustomer,
  ProviderInvoice,
  ProviderPlan,
  ProviderSubscription,
} from './billing-provider';
import {
  InvalidPayloadError,
  RAZORPAY_ID_PATTERN,
  parseRazorpayEvent,
  toProviderInvoice,
  toProviderPlan,
  toProviderSubscription,
} from './razorpay-payload';
import { razorpayCustomerEmail, razorpayCustomerName } from './razorpay-customer';
import { verifyRazorpaySignature } from './razorpay-signature';

const API_BASE = 'https://api.razorpay.com/v1';
const ERROR_DESCRIPTION_CHARS = 320;
const ERROR_CODE_CHARS = 64;

/** Razorpay's largest page (its default is 10). */
export const INVOICE_LIST_PAGE_SIZE = 100;
/**
 * Pages read before giving up. A subscription is created for at most 120 cycles
 * (`SUBSCRIPTION_TOTAL_COUNT`), so its invoices fill two pages; twenty is a list
 * gone wrong, refused rather than answered with part of it.
 */
export const INVOICE_LIST_MAX_PAGES = 20;

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/** An id that is not Razorpay-shaped, refused before it goes near a URL or a request body. */
export class InvalidProviderIdError extends Error {
  constructor(readonly field: string) {
    super(`Not a Razorpay id: ${field}`);
    this.name = 'InvalidProviderIdError';
  }
}

/** A subscription with more invoices than `INVOICE_LIST_MAX_PAGES` pages hold. */
export class InvoiceListTooLongError extends Error {
  constructor() {
    super(`More than ${INVOICE_LIST_MAX_PAGES * INVOICE_LIST_PAGE_SIZE} invoices on one subscription`);
    this.name = 'InvoiceListTooLongError';
  }
}

function checkedId(value: string, field: string): string {
  if (typeof value !== 'string' || !RAZORPAY_ID_PATTERN.test(value)) throw new InvalidProviderIdError(field);
  return value;
}

/**
 * Unix seconds, rounded up: a successor's start is never before the moment asked for
 * (the end of the current period), and an expiry is never earlier than intended.
 */
function unixSeconds(value: Date, field: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${field}`);
  return Math.ceil(ms / 1000);
}

/**
 * Razorpay's REST API over plain `fetch`, with Basic auth (key id and secret) and
 * `PROVIDER_REQUEST_TIMEOUT_MS` on every request, as the other providers. No SDK.
 *
 * Errors: a non-2xx answer is a `BillingProviderError` with Razorpay's own code and
 * description (cut short; log it only through `logValue`); a reply that is not the
 * shape expected is an `InvalidPayloadError`; a network failure or timeout is left as
 * fetch threw it, so `isUnreachableError` recognises it. None of them carries a key:
 * the secrets live in private fields and are read only to build the request.
 */
export class RazorpayProvider implements BillingProvider {
  readonly enabled = true;
  readonly keyId: string;
  readonly #authorization: string;
  readonly #webhookSecret: string;
  readonly #fetch: typeof fetch;

  constructor(keys: RazorpayKeys, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.keyId = keys.keyId;
    this.#authorization = 'Basic ' + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64');
    this.#webhookSecret = keys.webhookSecret;
    this.#fetch = fetchImpl;
  }

  async createCustomer(input: {
    name: string;
    email: string;
    gstin: string | null;
    accountRef: string;
  }): Promise<ProviderCustomer> {
    // Refused (`InvalidCustomerInputError`) before any request if Razorpay would refuse it.
    const body: Record<string, unknown> = {
      name: razorpayCustomerName(input.name),
      email: razorpayCustomerEmail(input.email),
    };
    if (input.gstin) body.gstin = input.gstin;
    // "0": answer with the existing customer of that email and contact rather than fail.
    body.fail_existing = '0';
    body.notes = { account_ref: input.accountRef };
    const reply = (await this.request('POST', '/customers', body)) as { id?: unknown; gstin?: unknown; notes?: unknown };
    const id = reply.id;
    if (typeof id !== 'string' || !RAZORPAY_ID_PATTERN.test(id)) throw new InvalidPayloadError('customer.id');
    // `notes` is an object when set, and may be `[]` when empty, as on other entities.
    const notes = reply.notes && typeof reply.notes === 'object' && !Array.isArray(reply.notes) ? reply.notes : {};
    const accountRef = (notes as { account_ref?: unknown }).account_ref;
    return {
      id,
      accountRef: typeof accountRef === 'string' ? accountRef : null,
      gstin: typeof reply.gstin === 'string' && reply.gstin !== '' ? reply.gstin : null,
    };
  }

  /** `PUT /v1/customers/:id` with the name only: the API takes name, email and contact, never a GSTIN. */
  async updateCustomerName(id: string, name: string): Promise<void> {
    const path = `/customers/${checkedId(id, 'customerId')}`;
    const reply = await this.request('PUT', path, { name: razorpayCustomerName(name) });
    if ((reply as { id?: unknown }).id !== id) throw new InvalidPayloadError('customer.id');
  }

  async createSubscription(input: {
    planId: string;
    totalCount: number;
    startAt: Date | null;
    expireBy: Date;
    accountRef: string;
  }): Promise<ProviderSubscription> {
    const planId = checkedId(input.planId, 'planId');
    if (!Number.isSafeInteger(input.totalCount) || input.totalCount < 1) throw new Error('Invalid total count');
    const body: Record<string, unknown> = {
      plan_id: planId,
      total_count: input.totalCount,
      quantity: 1,
      customer_notify: true,
      expire_by: unixSeconds(input.expireBy, 'expireBy'),
    };
    if (input.startAt !== null) body.start_at = unixSeconds(input.startAt, 'startAt');
    body.notes = { account_ref: input.accountRef };
    return toProviderSubscription(await this.request('POST', '/subscriptions', body));
  }

  async cancelSubscription(id: string, atCycleEnd: boolean): Promise<ProviderSubscription> {
    const path = `/subscriptions/${checkedId(id, 'subscriptionId')}/cancel`;
    return toProviderSubscription(await this.request('POST', path, { cancel_at_cycle_end: atCycleEnd === true }));
  }

  async fetchSubscription(id: string): Promise<ProviderSubscription> {
    return toProviderSubscription(await this.request('GET', `/subscriptions/${checkedId(id, 'subscriptionId')}`));
  }

  async fetchPlan(id: string): Promise<ProviderPlan> {
    return toProviderPlan(await this.request('GET', `/plans/${checkedId(id, 'planId')}`));
  }

  /**
   * Every invoice of the subscription, newest first, read in pages of
   * `INVOICE_LIST_PAGE_SIZE` by `skip` until a page comes back short. An invoice
   * issued between two requests moves the later ones down by one, so the next page
   * repeats one already read: it is listed once. Invoices are never deleted, so
   * nothing is skipped. Past `INVOICE_LIST_MAX_PAGES` full pages it throws
   * `InvoiceListTooLongError` rather than answer with part of the list.
   */
  async listSubscriptionInvoices(subscriptionId: string): Promise<ProviderInvoice[]> {
    const id = checkedId(subscriptionId, 'subscriptionId');
    const invoices = new Map<string, ProviderInvoice>();
    for (let page = 0; page < INVOICE_LIST_MAX_PAGES; page += 1) {
      const skip = page * INVOICE_LIST_PAGE_SIZE;
      const reply = await this.request('GET', `/invoices?subscription_id=${id}&count=${INVOICE_LIST_PAGE_SIZE}&skip=${skip}`);
      const items = (reply as { items?: unknown }).items;
      if (!Array.isArray(items)) throw new InvalidPayloadError('invoices.items');
      items.forEach((item, index) => {
        const invoice = toProviderInvoice(item, `invoices.items[${skip + index}]`);
        if (!invoices.has(invoice.id)) invoices.set(invoice.id, invoice);
      });
      if (items.length < INVOICE_LIST_PAGE_SIZE) return [...invoices.values()];
    }
    throw new InvoiceListTooLongError();
  }

  async notifyInvoiceByEmail(invoiceId: string): Promise<void> {
    await this.request('POST', `/invoices/${checkedId(invoiceId, 'invoiceId')}/notify_by/email`);
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    return verifyRazorpaySignature(rawBody, signature, this.#webhookSecret);
  }

  parseWebhook(body: unknown): BillingEvent {
    return parseRazorpayEvent(body);
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<object> {
    const response = await this.#fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: this.#authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; description?: unknown } } | null)?.error;
      throw new BillingProviderError(
        response.status,
        typeof error?.code === 'string' ? error.code.slice(0, ERROR_CODE_CHARS) : null,
        typeof error?.description === 'string' ? error.description.slice(0, ERROR_DESCRIPTION_CHARS) : null,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidPayloadError('reply');
    }
    return parsed;
  }
}
