import { createAccount } from '../support/api';
import { enrolAndSignInStaff, grantSuperAdmin } from '../support/admin';
import {
  createPaidPlan,
  DAY_SECONDS,
  mockSubscription,
  nowSeconds,
  sendSubscriptionEvent,
  stubRazorpayCheckout,
} from '../support/billing';
import { expect, newPersonContext, signIn, test } from '../support/fixtures';

/**
 * Paid plans, end to end against a local mock of Razorpay's API (the e2e stack runs
 * billing on with obviously fake keys and RAZORPAY_API_BASE_URL pointing at the mock).
 *
 * Staff make a plan and its monthly price through the admin API (which checks the
 * price against the plan it fetches from the mock). The customer sees it, chooses it,
 * gives billing details and "pays" in a stand-in for Razorpay Checkout; the account
 * changes only when the signed webhook arrives, as in production. They then cancel at
 * the period end, and take it back with "Keep my plan", a successor subscription that
 * starts when the current period ends.
 */
test('choose a paid plan, become active on the webhook, cancel, and keep the plan', async ({
  page,
  browser,
  baseURL,
  clientIp,
}) => {
  test.slow(); // The grant runs the CLI through ts-node.

  // Staff: a plan to buy.
  const staff = await createAccount(clientIp, 'billing-staff', 'Bina Staff');
  await grantSuperAdmin(staff.email);
  const { context: staffContext, ip: staffIp } = await newPersonContext(browser, baseURL);
  const staffToken = await enrolAndSignInStaff(await staffContext.newPage(), staff);
  const plan = await createPaidPlan(staffToken, staffIp);
  await staffContext.close();

  // Customer: the billing page, from the account menu.
  const customer = await createAccount(clientIp, 'billing', 'Bela Buyer');
  await stubRazorpayCheckout(page);
  await signIn(page, customer);
  await page.getByRole('button', { name: customer.name }).click();
  await page.getByRole('menuitem', { name: 'Billing' }).click();
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await expect(page.getByText('No paid plan')).toBeVisible();

  // Plans visible: Free is current, ours is on offer at its price.
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
  await expect(page.getByText('Current plan')).toBeVisible();
  // Other specs on the same stack add plans of their own, so work inside this plan's card.
  const planCard = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Plans', exact: true }) })
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]').getByText(plan.name, { exact: true }) });
  await expect(planCard).toHaveCount(1);
  await expect(planCard.getByText('₹499.00').first()).toBeVisible();

  // Choose it: billing details first, then Checkout opens on the subscription the API made.
  await planCard.getByRole('button', { name: 'Choose' }).click();
  await page.getByLabel('Legal name').fill('Bela Buyer Labs');
  await page.getByLabel('Address', { exact: true }).fill('1 Test Street');
  await page.getByLabel('City').fill('Bengaluru');
  await page.getByLabel('PIN code').fill('560001');
  await page.getByRole('combobox', { name: 'Your state' }).click();
  await page.getByRole('option', { name: 'Karnataka' }).click();
  const subscribed = page.waitForResponse((r) => r.url().endsWith('/api/billing/subscribe') && r.ok());
  await page.getByRole('button', { name: 'Save details' }).click();
  const checkout = ((await (await subscribed).json()) as { data: { subscriptionId: string; customerId: string } }).data;
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  expect((await mockSubscription(checkout.subscriptionId)).plan_id).toBe(plan.razorpayPlanId);

  // Razorpay's signed webhook makes it active.
  const periodStart = nowSeconds();
  const periodEnd = periodStart + 30 * DAY_SECONDS;
  await sendSubscriptionEvent('subscription.activated', checkout.subscriptionId, {
    status: 'active',
    customer_id: checkout.customerId,
    current_start: periodStart,
    current_end: periodEnd,
    charge_at: periodEnd,
    paid_count: 1,
  });
  await expect(page.getByRole('status').filter({ hasText: 'Payment received. Your plan is updated.' })).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Next charge ₹499\.00 on /)).toBeVisible();

  // Cancel: it runs to the end of the period, at Razorpay too.
  await page.getByRole('button', { name: 'Cancel plan' }).click();
  const cancelDialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
  await cancelDialog.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(page.getByText('Your plan will end at the end of this period', { exact: true })).toBeVisible();
  await expect(page.getByText('Ends at the period end', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Ends on .*\. After that your account moves to Free\.$/)).toBeVisible();
  const calls = (await (await fetch(`${process.env.E2E_RAZORPAY_MOCK_URL}/__mock/calls`)).json()) as Array<{
    method: string;
    path: string;
    body: { cancel_at_cycle_end?: boolean };
  }>;
  expect(calls).toContainEqual({
    method: 'POST',
    path: `/v1/subscriptions/${checkout.subscriptionId}/cancel`,
    body: { cancel_at_cycle_end: true },
  });

  // Keep my plan: a successor that starts when this period ends, authorised in Checkout.
  const kept = page.waitForResponse((r) => r.url().endsWith('/api/billing/change') && r.ok());
  await page.getByRole('button', { name: 'Keep my plan' }).click();
  const successor = ((await (await kept).json()) as { data: { subscriptionId: string; startsAt: string } }).data;
  expect(successor.subscriptionId).not.toBe(checkout.subscriptionId);
  expect(Date.parse(successor.startsAt) / 1000).toBe(periodEnd);
  await expect(page.getByRole('status').filter({ hasText: 'Processing payment...' })).toBeVisible();
  await sendSubscriptionEvent('subscription.authenticated', successor.subscriptionId, {
    status: 'authenticated',
    customer_id: checkout.customerId,
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'Change authorised. Its limits start once its first charge goes through.' }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(`^Moves to ${plan.name} \\(monthly\\) on `))).toBeVisible();
});
