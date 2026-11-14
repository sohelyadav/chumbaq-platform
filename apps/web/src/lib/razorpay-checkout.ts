import type { BillingCheckout } from '@chumbaq/shared';

/** Razorpay's Checkout script. The CSP in vite.config.ts allows this origin and its frames. */
export const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** What `new window.Razorpay(options)` returns, as far as the dashboard uses it. */
export interface RazorpayCheckoutInstance {
  open(): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckoutInstance;
  }
}

/**
 * Options for Razorpay Checkout on a subscription the server created. There is no
 * amount, price or currency here: Checkout charges what the subscription's plan says,
 * and that plan's amount comes from the server's price row. The success handler only
 * starts "Processing payment"; the plan changes when the provider's signed webhook
 * reaches the server, never from this callback.
 */
export function checkoutOptions(
  checkout: BillingCheckout,
  onSuccess: () => void,
  onDismiss: () => void,
): Record<string, unknown> {
  return {
    key: checkout.keyId,
    subscription_id: checkout.subscriptionId,
    ...(checkout.customerId ? { customer_id: checkout.customerId } : {}),
    name: 'Chumbaq',
    prefill: { name: checkout.prefill.name, email: checkout.prefill.email },
    handler: () => onSuccess(),
    modal: { ondismiss: () => onDismiss() },
  };
}

type ScriptDocument = Pick<Document, 'createElement'> & { head: Pick<HTMLHeadElement, 'appendChild'> };

const loads = new WeakMap<object, Promise<void>>();

/**
 * Adds Checkout's script to the page once; every later call gets the same promise. A
 * load that failed is forgotten, so the next attempt adds the script again.
 */
export function loadRazorpayCheckout(doc: ScriptDocument = document): Promise<void> {
  const existing = loads.get(doc);
  if (existing) return existing;
  const loading = new Promise<void>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loads.delete(doc);
      reject(new Error('Could not load Razorpay Checkout. Check your connection and try again.'));
    };
    doc.head.appendChild(script);
  });
  loads.set(doc, loading);
  return loading;
}
