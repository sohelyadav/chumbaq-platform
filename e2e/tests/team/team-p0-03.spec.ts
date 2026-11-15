import { randomUUID } from 'crypto';
import type { Browser, Page, Response } from '@playwright/test';
import { createProject, newClientIp, uniqueEmail } from '../../support/api';
import { readDownload } from '../../support/browser-tools';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import {
  ACTIVITY_CSV_HEADER,
  ADMIN_PERMISSIONS,
  BILLING_OFFER_GONE,
  BILLING_SUSPENDED,
  BILLING_TARGET_NOT_OWNER,
  INVALID_ACTIVITY_FILTER,
  MEMBER_NOT_FOUND,
  MEMBER_PERMISSIONS,
  OWNER_PERMISSIONS,
  PROJECT_NOT_FOUND,
  READ_ONLY,
  REAUTH_REQUIRED,
  ROLE_REFUSAL,
  SEAT_LIMIT_MESSAGE,
  STAFF_SENTENCE,
  activityPage,
  activityRows,
  addMember,
  ageBillingOffer,
  ageSignIn,
  billingState,
  call,
  callWithHeaders,
  cardTitled,
  chooseRole,
  insertActivity,
  invitationsOf,
  joinedLabel,
  makeTeam,
  memberRow,
  membersOf,
  messageOf,
  messagesOf,
  newPerson,
  newStaffMember,
  offerBilling,
  openActivity,
  openMembers,
  openSettings,
  openViewAsLink,
  parseCsv,
  pendingInviteRow,
  personLabel,
  projectsMetaOf,
  projectsOf,
  rawGet,
  reactivateAccount,
  renameAccount,
  sendInvite,
  setProjectLimit,
  setSeatLimit,
  suspendAccount,
  toastTitled,
  viewAsLink,
  viewAsToken,
  withDb,
  type Person,
} from '../../support/areas/team';

/**
 * Billing transfer (offer, cancel, accept, decline, the 7-day window and the receiver's
 * limits), the Activity page and its CSV, the role matrix as other routes enforce it,
 * and view-as on the team pages.
 */

test.describe.configure({ mode: 'parallel' });

/** Signs `person` in, in a browser of their own. */
async function personPage(browser: Browser, baseURL: string | undefined, person: Person): Promise<Page> {
  const { context } = await newPersonContext(browser, baseURL);
  const page = await context.newPage();
  await signIn(page, person);
  return page;
}

/** Signs in, then moves the sign-in back past the recent sign-in window and reloads, so the page's token is stale. */
async function signInStale(page: Page, person: Person): Promise<void> {
  await signIn(page, person);
  await ageSignIn(person);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
}

/** Records the statuses of the requests matching `method` and a URL ending. */
function watchStatuses(page: Page, method: string, urlEnd: string): number[] {
  const statuses: number[] = [];
  page.on('response', (response: Response) => {
    if (response.request().method() === method && new URL(response.url()).pathname.endsWith(urlEnd)) {
      statuses.push(response.status());
    }
  });
  return statuses;
}

/** Holds requests matching `method` and a URL path ending until `release` is called. */
async function holdRequests(page: Page, method: string, urlEnd: string): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.endsWith(urlEnd),
    async (route) => {
      if (route.request().method() === method) await released;
      await route.continue();
    },
  );
  return release;
}

/** The time the Activity table shows (`MMM d, yyyy HH:mm`, this machine's zone, as the browser's). */
function whenLabel(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${joinedLabel(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The activity table's body rows (not the expanded detail rows). */
function activityRowsOnPage(page: Page) {
  return page.getByRole('table').locator('tbody tr[aria-expanded]');
}

/** Toasts titled `title`, found even while a modal dialog hides the rest of the page from the accessibility tree. */
function toastsBehindDialog(page: Page, title: string) {
  return page.getByRole('region', { name: /Notifications/, includeHidden: true }).locator('li').filter({ hasText: title });
}

/**
 * A view-as write raises its own `Read-only session` toast. Earlier toasts (4 s each) are
 * waited out first, so the one seen belongs to this write and is not a leftover.
 */
async function expectOwnReadOnlyToast(page: Page, attempt: () => Promise<unknown>): Promise<void> {
  const readOnly = toastsBehindDialog(page, 'Read-only session');
  await expect(readOnly).toHaveCount(0, { timeout: 10_000 });
  await attempt();
  await expect(readOnly).toHaveCount(1);
  await expect(readOnly).toContainText(READ_ONLY);
}

/** The billing card's owner picker. */
function billingPicker(page: Page) {
  return page.getByRole('combobox', { name: 'Owner to offer billing to' });
}

const offerUrl = (projectId: string) => `/api/projects/${projectId}/billing-transfer`;

// ---- I. Billing transfer

test('TEAM-115 offer billing to another owner', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    coOwner2: ['owner', 'Dan Dualowner'],
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner } = people;

  await signIn(page, owner);
  await openSettings(page, project.id);
  const card = cardTitled(page, 'Billing owner');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    'This project is billed to you. You can hand billing to another owner; it moves once they accept.',
  );
  const offer = card.getByRole('button', { name: 'Offer billing' });
  await expect(offer).toBeDisabled();

  await billingPicker(page).click();
  await expect(page.getByRole('option')).toHaveText(['Cara Co', 'Dan Dualowner']);
  await page.getByRole('option', { name: 'Cara Co', exact: true }).click();
  await expect(offer).toBeEnabled();

  const release = await holdRequests(page, 'POST', '/billing-transfer');
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/billing-transfer'));
  await offer.click();
  await expect(card.getByRole('button', { name: 'Offering...' })).toBeDisabled();
  release();
  const response = await posted;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ toUserId: coOwner.userId });

  await expect(toastTitled(page, 'Billing offered')).toContainText('They have 7 days to accept.');
  const { billingOffer } = await membersOf(project.id, owner);
  const live = billingOffer as { toUserId: string; offeredAt: string; expiresAt: string };
  expect(live.toUserId).toBe(coOwner.userId);
  expect(new Date(live.expiresAt).getTime() - new Date(live.offeredAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  await expect(card.getByText(`Offered to Cara Co, until ${joinedLabel(new Date(live.expiresAt))}.`, { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel offer' })).toBeVisible();

  const [entry] = (await activityPage(project.id, owner, 'group=team')).entries;
  expect(entry).toMatchObject({
    action: 'billing.transfer_offered',
    actorUserId: owner.userId,
    targetId: coOwner.userId,
    details: { toUserId: coOwner.userId },
  });
  expect((await billingState(project.id)).ownerId).toBe(owner.userId);
  await openActivity(page, project.id);
  await expect(
    page.getByRole('cell', { name: `Omar Owner offered billing for this project to ${personLabel(coOwner)}`, exact: true }),
  ).toBeVisible();
});

test('TEAM-116 offering billing needs a recent sign-in', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });

  await signInStale(page, owner);
  await openSettings(page, project.id);
  const statuses = watchStatuses(page, 'POST', '/billing-transfer');
  await billingPicker(page).click();
  await page.getByRole('option', { name: 'Cara Co', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });

  // Cancelling the prompt: no toast, no offer.
  const refused = page.waitForResponse((r) => r.request().method() === 'POST' && r.status() === 403);
  await page.getByRole('button', { name: 'Offer billing' }).click();
  expect((await (await refused).json()).message).toBe(REAUTH_REQUIRED);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Notifications/ }).locator('li')).toHaveCount(0);
  expect((await membersOf(project.id, owner)).billingOffer).toBeNull();

  // Confirming: the offer is resent and goes through.
  await page.getByRole('button', { name: 'Offer billing' }).click();
  await expect(dialog).toBeVisible();
  await confirmWithPassword(page, owner.password);
  await expect(toastTitled(page, 'Billing offered')).toBeVisible();
  // Toasts last 4 s: a failure toast from the cancelled attempt would still be showing.
  await expect(toastTitled(page, 'Billing not offered')).toHaveCount(0);
  expect(statuses).toEqual([403, 403, 200]);
  expect((await membersOf(project.id, owner)).billingOffer).toMatchObject({ toUserId: people.coOwner.userId });
});

test('TEAM-118 offer refused to non-owners, self and strangers', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const outsider = await newPerson('team-outsider', 'Xena Outsider');

  for (const to of [people.admin, people.member, owner]) {
    const result = await offerBilling(project.id, owner, to);
    expect(result.status, to.name).toBe(400);
    expect(messageOf(result)).toBe(BILLING_TARGET_NOT_OWNER);
  }
  for (const toUserId of [outsider.userId, randomUUID()]) {
    const result = await call('POST', offerUrl(project.id), { as: owner, body: { toUserId } });
    expect(result.status).toBe(404);
    expect(messageOf(result)).toBe(MEMBER_NOT_FOUND);
  }
  for (const body of [{ toUserId: 'abc' }, {}]) {
    const result = await call('POST', offerUrl(project.id), { as: owner, body });
    expect(result.status).toBe(400);
    expect(messagesOf(result)).toContain('toUserId must be a UUID');
  }
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: null });
  expect((await activityPage(project.id, owner)).entries).toHaveLength(0);
});

test('TEAM-119 only the billing owner may offer or cancel', async ({ page }) => {
  const { project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    coOwner2: ['owner', 'Dan Dualowner'],
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner, coOwner2, admin, member } = people;

  for (const caller of [coOwner, admin, member]) {
    const offered = await offerBilling(project.id, caller, coOwner2);
    expect(offered.status, `${caller.name} offer`).toBe(403);
    expect(messageOf(offered)).toBe(ROLE_REFUSAL);
    const cancelled = await call('DELETE', offerUrl(project.id), { as: caller });
    expect(cancelled.status, `${caller.name} cancel`).toBe(403);
    expect(messageOf(cancelled)).toBe(ROLE_REFUSAL);
  }
  expect((await billingState(project.id)).pendingTo).toBeNull();

  await signIn(page, coOwner);
  await openSettings(page, project.id);
  await expect(cardTitled(page, 'Leave project').locator('[data-slot="card-description"]')).toHaveText(
    'You lose access to this project. Pending invites you sent are cancelled.',
  );
  await expect(cardTitled(page, 'Billing owner')).toHaveCount(0);
  await expect(billingPicker(page)).toHaveCount(0);
});

test('TEAM-120 cancel the offer', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  const receiver = await personPage(browser, baseURL, coOwner);
  await openSettings(receiver, project.id);
  await expect(cardTitled(receiver, 'Take over billing')).toBeVisible();

  await signIn(page, owner);
  await openSettings(page, project.id);
  const card = cardTitled(page, 'Billing owner');
  const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.endsWith('/billing-transfer'));
  await card.getByRole('button', { name: 'Cancel offer' }).click();
  expect((await deleted).status()).toBe(200);
  await expect(toastTitled(page, 'Billing offer cancelled')).toBeVisible();
  await expect(billingPicker(page)).toBeVisible();
  await expect(card.getByText(/^Offered to/)).toHaveCount(0);
  expect((await membersOf(project.id, owner)).billingOffer).toBeNull();

  await receiver.reload();
  await cardTitled(receiver, 'Leave project').waitFor();
  await expect(cardTitled(receiver, 'Take over billing')).toHaveCount(0);

  const [entry] = (await activityPage(project.id, owner, 'group=team')).entries;
  expect(entry).toMatchObject({ action: 'billing.transfer_cancelled', actorUserId: owner.userId, targetId: coOwner.userId });
  await openActivity(page, project.id);
  await expect(
    page.getByRole('cell', { name: `Omar Owner cancelled the billing offer to ${personLabel(coOwner)}`, exact: true }),
  ).toBeVisible();
});

test('TEAM-122 receiver sees the offer and accepts', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    member: ['member', 'Mia Member'],
  });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  const offer = (await membersOf(project.id, owner)).billingOffer as { expiresAt: string };
  const ownerBefore = await projectsMetaOf(owner);
  const receiverBefore = await projectsMetaOf(coOwner);
  expect(ownerBefore.seats.used).toBe(3);
  expect(receiverBefore.seats.used).toBe(1);

  await signIn(page, coOwner);
  await openSettings(page, project.id);
  const card = cardTitled(page, 'Take over billing');
  await expect(card.locator('[data-slot="card-description"]')).toHaveText(
    `You have been offered billing ownership of this project, until ${joinedLabel(new Date(offer.expiresAt))}. It then counts towards your project limit and its members use your seats.`,
  );
  await expect(card.getByRole('button')).toHaveText(['Accept billing', 'Decline']);
  await expect(cardTitled(page, 'Billing owner')).toHaveCount(0);

  const release = await holdRequests(page, 'POST', '/billing-transfer/accept');
  const accepted = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/billing-transfer/accept'));
  await card.getByRole('button', { name: 'Accept billing' }).click();
  await expect(card.getByRole('button', { name: 'Accepting...' })).toBeDisabled();
  release();
  expect((await accepted).status()).toBe(200);
  await expect(toastTitled(page, 'This project is now billed to you')).toBeVisible();

  expect(await billingState(project.id)).toEqual({ ownerId: coOwner.userId, pendingTo: null });
  await expect(cardTitled(page, 'Take over billing')).toHaveCount(0);
  await expect(cardTitled(page, 'Billing owner')).toBeVisible();
  await expect(cardTitled(page, 'Leave project').locator('[data-slot="card-description"]')).toHaveText(
    'This project is billed to you, so you cannot leave it. Move billing to another owner first.',
  );
  await expect(cardTitled(page, 'Leave project').getByRole('button', { name: 'Leave project' })).toHaveCount(0);

  await openMembers(page, project.id);
  await expect(memberRow(page, coOwner.email).getByText('Billing owner', { exact: true })).toBeVisible();
  await expect(memberRow(page, owner.email).getByText('Billing owner', { exact: true })).toHaveCount(0);

  const ownerAfter = await projectsMetaOf(owner);
  const receiverAfter = await projectsMetaOf(coOwner);
  expect(ownerAfter.billedProjects).toBe(ownerBefore.billedProjects - 1);
  expect(receiverAfter.billedProjects).toBe(receiverBefore.billedProjects + 1);
  expect(ownerAfter.seats.used).toBe(1);
  expect(receiverAfter.seats.used).toBe(3);

  const [entry] = (await activityPage(project.id, coOwner, 'group=team')).entries;
  expect(entry).toMatchObject({ action: 'billing.transfer_accepted', actorUserId: coOwner.userId });
  await openActivity(page, project.id);
  await expect(page.getByRole('cell', { name: 'Cara Co accepted billing for this project', exact: true })).toBeVisible();

  // The old billing owner is now an ordinary owner: they may be demoted.
  const demoted = await call('PATCH', `/api/projects/${project.id}/members/${owner.userId}`, { as: coOwner, body: { role: 'admin' } });
  expect(demoted.status).toBe(200);
  expect((await projectsOf(owner)).find((p) => p.id === project.id)).toMatchObject({ role: 'admin', isBillingOwner: false });
});

test('TEAM-123 accepting needs a recent sign-in', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  await signInStale(page, coOwner);
  await openSettings(page, project.id);
  const statuses = watchStatuses(page, 'POST', '/billing-transfer/accept');
  const card = cardTitled(page, 'Take over billing');
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });

  const refused = page.waitForResponse((r) => r.request().method() === 'POST' && r.status() === 403);
  await card.getByRole('button', { name: 'Accept billing' }).click();
  expect((await (await refused).json()).message).toBe(REAUTH_REQUIRED);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Notifications/ }).locator('li')).toHaveCount(0);
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Accept billing' }).click();
  await expect(dialog).toBeVisible();
  await confirmWithPassword(page, coOwner.password);
  await expect(toastTitled(page, 'This project is now billed to you')).toBeVisible();
  await expect(toastTitled(page, 'Billing not moved')).toHaveCount(0);
  expect(statuses).toEqual([403, 403, 200]);
  expect(await billingState(project.id)).toEqual({ ownerId: coOwner.userId, pendingTo: null });
});

test('TEAM-124 accept refused when not the receiver or no offer', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    coOwner2: ['owner', 'Dan Dualowner'],
  });
  const { coOwner, coOwner2 } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  const accept = (person: Person) => call('POST', `${offerUrl(project.id)}/accept`, { as: person });

  for (const caller of [coOwner2, owner]) {
    const result = await accept(caller);
    expect(result.status, caller.name).toBe(400);
    expect(messageOf(result)).toBe(BILLING_OFFER_GONE);
  }
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });

  expect((await call('DELETE', offerUrl(project.id), { as: owner })).status).toBe(200);
  const late = await accept(coOwner);
  expect(late.status).toBe(400);
  expect(messageOf(late)).toBe(BILLING_OFFER_GONE);
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: null });
});

test('TEAM-126 offer lapses after 7 days by the database clock', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  // Just inside the window, the offer is still live.
  await ageBillingOffer(project.id, '6 days 23 hours');
  expect((await membersOf(project.id, owner)).billingOffer).toMatchObject({ toUserId: coOwner.userId });

  await ageBillingOffer(project.id, '7 days 1 minute');
  expect((await membersOf(project.id, owner)).billingOffer).toBeNull();
  const receiver = await personPage(browser, baseURL, coOwner);
  await openSettings(receiver, project.id);
  await expect(cardTitled(receiver, 'Take over billing')).toHaveCount(0);
  const accept = await call('POST', `${offerUrl(project.id)}/accept`, { as: coOwner });
  expect(accept.status).toBe(400);
  expect(messageOf(accept)).toBe(BILLING_OFFER_GONE);

  await signIn(page, owner);
  await openSettings(page, project.id);
  await expect(billingPicker(page)).toBeVisible();
  await expect(cardTitled(page, 'Billing owner').getByText(/^Offered to/)).toHaveCount(0);

  // A lapsed offer is still the receiver's to clear.
  const declined = await call('POST', `${offerUrl(project.id)}/decline`, { as: coOwner });
  expect(declined.status).toBe(200);
  const [entry] = (await activityPage(project.id, owner, 'group=team')).entries;
  expect(entry).toMatchObject({ action: 'billing.transfer_declined', actorUserId: coOwner.userId });
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: null });

  // At 6 days 23 hours accept still works.
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);
  await ageBillingOffer(project.id, '6 days 23 hours');
  expect((await call('POST', `${offerUrl(project.id)}/accept`, { as: coOwner })).status).toBe(200);
  expect((await billingState(project.id)).ownerId).toBe(coOwner.userId);
});

test('TEAM-127 decline an offer', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  const ownerPage = await personPage(browser, baseURL, owner);
  await openSettings(ownerPage, project.id);
  await expect(cardTitled(ownerPage, 'Billing owner').getByText(/^Offered to Cara Co, until/)).toBeVisible();

  // No recent sign-in is needed to decline.
  await signInStale(page, coOwner);
  await openSettings(page, project.id);
  const statuses = watchStatuses(page, 'POST', '/billing-transfer/decline');
  await cardTitled(page, 'Take over billing').getByRole('button', { name: 'Decline' }).click();
  await expect(toastTitled(page, 'Billing offer declined')).toBeVisible();
  expect(statuses).toEqual([200]);
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);
  await expect(cardTitled(page, 'Take over billing')).toHaveCount(0);
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: null });

  await ownerPage.reload();
  await expect(billingPicker(ownerPage)).toBeVisible();

  const [entry] = (await activityPage(project.id, owner, 'group=team')).entries;
  expect(entry).toMatchObject({ action: 'billing.transfer_declined', actorUserId: coOwner.userId, targetId: coOwner.userId });
  await openActivity(ownerPage, project.id);
  await expect(ownerPage.getByRole('cell', { name: 'Cara Co declined billing for this project', exact: true })).toBeVisible();
});

test('TEAM-129 accept refused by the receiver\'s project limit', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  await createProject(coOwner, coOwner.ip, `Cara's own ${randomUUID().slice(0, 6)}`);
  await setProjectLimit(coOwner, 1);
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  await signIn(page, coOwner);
  await openSettings(page, project.id);
  const accepted = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/billing-transfer/accept'));
  await cardTitled(page, 'Take over billing').getByRole('button', { name: 'Accept billing' }).click();
  expect((await accepted).status()).toBe(403);
  // Billing is on in this stack, so the limit is worded for plans.
  await expect(toastTitled(page, 'Billing not moved')).toContainText(
    'You can have up to 1 projects on your plan. Upgrade your plan or delete one.',
  );
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });
  expect((await membersOf(project.id, owner)).billingOffer).toMatchObject({ toUserId: coOwner.userId });
});

test('TEAM-130 accept refused by the receiver\'s seat limit', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    member1: ['member', 'Mia One'],
    member2: ['member', 'Max Two'],
  });
  const { coOwner } = people;
  const zed = await newPerson('team-zed', 'Zed Own');
  const own = await createProject(coOwner, coOwner.ip, `Cara's own ${randomUUID().slice(0, 6)}`);
  await addMember(own.id, zed, 'member', coOwner);
  // O, Cara, Mia, Max and Zed: five people, Cara counted once.
  await setSeatLimit(coOwner, 4);
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  await signIn(page, coOwner);
  await openSettings(page, project.id);
  const accept = cardTitled(page, 'Take over billing').getByRole('button', { name: 'Accept billing' });
  const refused = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/billing-transfer/accept'));
  await accept.click();
  expect((await refused).status()).toBe(403);
  await expect(toastTitled(page, 'Billing not moved')).toContainText(SEAT_LIMIT_MESSAGE);
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });

  await setSeatLimit(coOwner, 5);
  const ok = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/billing-transfer/accept'));
  await accept.click();
  expect((await ok).status()).toBe(200);
  await expect(toastTitled(page, 'This project is now billed to you')).toBeVisible();
  expect((await billingState(project.id)).ownerId).toBe(coOwner.userId);
  expect((await projectsMetaOf(coOwner)).seats).toEqual({ used: 5, limit: 5 });
});

test('TEAM-131 accept refused while the billing owner is suspended', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { coOwner: ['owner', 'Cara Co'] });
  const { coOwner } = people;
  expect((await offerBilling(project.id, owner, coOwner)).status).toBe(200);

  await suspendAccount(owner);
  const refused = await call('POST', `${offerUrl(project.id)}/accept`, { as: coOwner });
  expect(refused.status).toBe(409);
  expect(messageOf(refused)).toBe(BILLING_SUSPENDED);
  expect(await billingState(project.id)).toEqual({ ownerId: owner.userId, pendingTo: coOwner.userId });

  await reactivateAccount(owner);
  const accepted = await call('POST', `${offerUrl(project.id)}/accept`, { as: coOwner });
  expect(accepted.status).toBe(200);
  expect(await billingState(project.id)).toEqual({ ownerId: coOwner.userId, pendingTo: null });
});

// ---- J. Activity log page

test('TEAM-136 entries show when, who, what and where', async ({ page }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const ip = newClientIp();
  const userAgent = `E2E-Agent/1.0 (team activity ${randomUUID().slice(0, 8)})`;
  const invitee = uniqueEmail('team-invitee');
  const invited = await callWithHeaders('POST', `/api/projects/${project.id}/invitations`, { accessToken: owner.accessToken, ip }, { 'User-Agent': userAgent }, {
    email: invitee,
    role: 'admin',
  });
  expect(invited.status).toBe(201);
  const invitationId = invited.body.data.invitation.id as string;
  const [entry] = (await activityPage(project.id, owner)).entries;
  expect(entry).toMatchObject({ action: 'member.invited', ipAddress: ip, country: null, userAgent });

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveText(['', 'When', 'Who', 'What', 'Where']);
  const row = activityRowsOnPage(page).first();
  const cells = row.getByRole('cell');
  const time = cells.nth(1).locator('time');
  await expect(time).toHaveText(whenLabel(entry.occurredAt));
  await expect(time).toHaveAttribute('title', `${entry.occurredAt.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`);
  await expect(cells.nth(2).locator('p')).toHaveText(['Omar Owner', owner.email]);
  await expect(cells.nth(3)).toHaveText(`Omar Owner invited ${invitee} as an admin`);
  await expect(cells.nth(4).locator('p')).toHaveText([ip]);

  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const details = page.locator('dl');
  await expect(details.locator('dt')).toHaveText(['Time (UTC)', 'Target', 'Target id', 'role', 'email', 'Browser', 'Action']);
  await expect(details.locator('dd')).toHaveText([
    entry.occurredAt,
    `invitation: ${invitee}`,
    invitationId,
    'admin',
    invitee,
    userAgent,
    'member.invited',
  ]);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('dl')).toHaveCount(0);
});

test('TEAM-138 admin can read the log; member cannot', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const { admin, member } = people;
  await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');

  const adminPage = await personPage(browser, baseURL, admin);
  await openActivity(adminPage, project.id);
  await expect(activityRowsOnPage(adminPage)).toHaveCount(1);
  await expect(adminPage.getByRole('button', { name: 'Download CSV' })).toBeVisible();
  expect((await call('GET', `/api/projects/${project.id}/activity`, { as: admin })).status).toBe(200);

  await signIn(page, member);
  const activityCalls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/activity')) activityCalls.push(request.url());
  });
  await openActivity(page, project.id);
  await expect(page.getByText('Only owners and admins can see the activity log.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Kind')).toHaveCount(0);
  await expect(page.getByLabel('Person')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(activityCalls.filter((url) => url.includes('/api/'))).toEqual([]);

  for (const path of [`/api/projects/${project.id}/activity`, `/api/projects/${project.id}/activity/export`]) {
    const result = await rawGet(path, member.accessToken, member.ip);
    expect(result.status, path).toBe(403);
    expect(result.message).toBe(ROLE_REFUSAL);
  }
});

/** A team entry and two privacy entries by the owner, the privacy ones newest. */
async function seedPrivacyEntries(projectId: string, owner: Person): Promise<void> {
  await sendInvite(projectId, owner, uniqueEmail('team-invitee'), 'member');
  await insertActivity(projectId, [
    { action: 'person.erased', actorUserId: owner.userId, actorLabel: personLabel(owner) },
    {
      action: 'suppression.added',
      actorUserId: owner.userId,
      actorLabel: personLabel(owner),
      details: { channel: 'email', address: 'j***@example.com' },
    },
  ]);
}

test('TEAM-139 privacy entries are the owner\'s only', async ({ page, browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  await seedPrivacyEntries(project.id, owner);

  await signIn(page, owner);
  await openActivity(page, project.id);
  await expect(activityRowsOnPage(page)).toHaveCount(3);
  await expect(page.getByRole('cell', { name: "Omar Owner erased a person's data", exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Omar Owner stopped email to j***@example.com', exact: true })).toBeVisible();
  await page.getByLabel('Kind').click();
  await expect(page.getByRole('option', { name: 'Privacy', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  const adminPage = await personPage(browser, baseURL, admin);
  await openActivity(adminPage, project.id);
  await expect(activityRowsOnPage(adminPage)).toHaveCount(1);
  await expect(adminPage.getByRole('cell', { name: "Omar Owner erased a person's data", exact: true })).toHaveCount(0);
  await expect(adminPage.getByText(/stopped email to/)).toHaveCount(0);
  await adminPage.getByLabel('Kind').click();
  await expect(adminPage.getByRole('option', { name: 'Team', exact: true })).toBeVisible();
  await expect(adminPage.getByRole('option', { name: 'Privacy', exact: true })).toHaveCount(0);
  await adminPage.keyboard.press('Escape');

  const privacy = await activityPage(project.id, admin, 'group=privacy');
  expect(privacy.entries).toEqual([]);
  expect((await activityPage(project.id, owner, 'group=privacy')).entries.map((e) => e.action)).toEqual([
    'suppression.added',
    'person.erased',
  ]);
  const csv = await rawGet(`/api/projects/${project.id}/activity/export`, admin.accessToken, admin.ip);
  expect(csv.status).toBe(200);
  const actions = parseCsv(csv.text).slice(1).map((cells) => cells[2]);
  expect(actions).toEqual(['member.invited']);
});

test('TEAM-151 a cursor cannot reach another project', async () => {
  const owner = await newPerson('team-owner', 'Omar Owner');
  const p1 = await createProject(owner, owner.ip, `Team ${randomUUID().slice(0, 6)}`);
  const p2 = await createProject(owner, owner.ip, `Team ${randomUUID().slice(0, 6)}`);
  const label = personLabel(owner);
  const p1Ids = await insertActivity(
    p1.id,
    Array.from({ length: 55 }, (_, i) => ({ action: 'member.left', actorUserId: owner.userId, actorLabel: label, ago: `${60 + i} minutes` })),
  );
  const first = await activityPage(p1.id, owner);
  expect(first.entries).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  // The cursor sits at P1's 50th entry, 109 minutes ago.
  const [, olderA, olderB] = await insertActivity(p2.id, [
    { action: 'member.left', actorUserId: owner.userId, actorLabel: label, ago: '100 minutes' },
    { action: 'member.left', actorUserId: owner.userId, actorLabel: label, ago: '120 minutes' },
    { action: 'member.left', actorUserId: owner.userId, actorLabel: label, ago: '130 minutes' },
  ]);

  const crossed = await activityPage(p2.id, owner, `cursor=${first.nextCursor}`);
  expect(crossed.entries.map((e) => e.id)).toEqual([olderA, olderB]);
  for (const entry of crossed.entries) expect(p1Ids).not.toContain(entry.id);
});

test('TEAM-152 activity API refuses outsiders', async () => {
  const { project } = await makeTeam('Omar Owner', {});
  const outsider = await newPerson('team-outsider', 'Xena Outsider');
  for (const path of [`/api/projects/${project.id}/activity`, `/api/projects/${project.id}/activity/export`]) {
    const asOutsider = await rawGet(path, outsider.accessToken, outsider.ip);
    expect(asOutsider.status, path).toBe(404);
    expect(asOutsider.message).toBe(PROJECT_NOT_FOUND);
    const anonymous = await rawGet(path, null, newClientIp());
    expect(anonymous.status, path).toBe(401);
  }
});

test('TEAM-155 staff view-as appears as Chumbaq support', async ({ page, browser }) => {
  const tenant = await newPerson('team-tenant', 'Omar Owner');
  const p1 = await createProject(tenant, tenant.ip, `Team ${randomUUID().slice(0, 6)}`);
  const p2 = await createProject(tenant, tenant.ip, `Team ${randomUUID().slice(0, 6)}`);
  const other = await newPerson('team-other', 'Cara Co');
  const p3 = await createProject(other, other.ip, `Team ${randomUUID().slice(0, 6)}`);
  await addMember(p3.id, tenant, 'owner', other);
  await sendInvite(p1.id, tenant, uniqueEmail('team-invitee'), 'member');

  const staff = await newStaffMember(browser);
  await viewAsToken(await viewAsLink(staff, tenant));

  for (const projectId of [p1.id, p2.id]) {
    const staffEntries = (await activityPage(projectId, tenant)).entries.filter((e) => e.action === 'staff.viewed_as');
    expect(staffEntries).toHaveLength(1);
    expect(staffEntries[0]).toMatchObject({
      actorKind: 'staff',
      actorUserId: null,
      targetId: null,
      targetLabel: null,
      details: null,
      ipAddress: null,
      country: null,
      userAgent: null,
    });
  }
  expect((await activityPage(p3.id, tenant)).entries.filter((e) => e.action === 'staff.viewed_as')).toEqual([]);
  const stored = (await activityRows(p1.id)).filter((r) => r.action === 'staff.viewed_as');
  expect(stored).toEqual([
    { action: 'staff.viewed_as', actor_kind: 'staff', actor_user_id: null, ip_address: null, user_agent: null, details: null },
  ]);

  await signIn(page, tenant);
  await openActivity(page, p1.id);
  const row = activityRowsOnPage(page).filter({ hasText: STAFF_SENTENCE });
  const cells = row.getByRole('cell');
  await expect(cells.nth(2).locator('p')).toHaveText(['Chumbaq support']);
  await expect(cells.nth(3)).toHaveText(STAFF_SENTENCE);
  await expect(cells.nth(4)).toHaveText('—');
  await row.click();
  await expect(page.locator('dl dt')).toHaveText(['Time (UTC)', 'Action']);
  await expect(page.locator('dl dd').nth(1)).toHaveText('staff.viewed_as');

  await page.getByLabel('Person').click();
  await expect(page.getByRole('option')).toHaveText(['Everyone', personLabel(tenant)]);
  await page.keyboard.press('Escape');
  await page.getByLabel('Kind').click();
  await page.getByRole('option', { name: 'Chumbaq support', exact: true }).click();
  await expect(page).toHaveURL(/group=staff/);
  await expect(activityRowsOnPage(page)).toHaveCount(1);
  await expect(activityRowsOnPage(page).getByRole('cell').nth(3)).toHaveText(STAFF_SENTENCE);

  await openActivity(page, p3.id);
  await expect(page.getByText(STAFF_SENTENCE)).toHaveCount(0);
});

test('TEAM-156 view-as can read the log but not download it', async ({ browser, baseURL }) => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  await seedPrivacyEntries(project.id, owner);
  const staff = await newStaffMember(browser);

  const viewAs = await openViewAsLink(browser, baseURL, await viewAsLink(staff, owner));
  await openActivity(viewAs, project.id);
  // The tenant's own role (owner): privacy entries are in.
  await expect(viewAs.getByRole('cell', { name: "Omar Owner erased a person's data", exact: true })).toBeVisible();
  await expect(viewAs.getByRole('cell', { name: STAFF_SENTENCE, exact: true })).toBeVisible();
  let downloads = 0;
  viewAs.on('download', () => (downloads += 1));
  const exported = viewAs.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/activity/export'));
  await viewAs.getByRole('button', { name: 'Download CSV' }).click();
  expect((await exported).status()).toBe(403);
  await expect(viewAs.getByRole('alert').filter({ hasText: READ_ONLY })).toHaveText(READ_ONLY);
  expect(downloads).toBe(0);

  const { accessToken, ip } = await viewAsToken(await viewAsLink(staff, owner));
  const byToken = await rawGet(`/api/projects/${project.id}/activity/export`, accessToken, ip);
  expect(byToken.status).toBe(403);
  expect(byToken.message).toBe(READ_ONLY);
  expect((await activityRows(project.id)).filter((r) => r.action === 'activity.exported')).toEqual([]);
});

// ---- K. Activity download (CSV)

test('TEAM-159 download the log', async ({ page }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    formula: ['member', 'Formula Person'],
    plus: ['member', 'Plus Person'],
    minus: ['member', 'Minus Person'],
    at: ['member', 'At Person'],
  });
  const formula = await renameAccount(people.formula, '=HYPERLINK("http://x","y")');
  const plus = await renameAccount(people.plus, '+1');
  const minus = await renameAccount(people.minus, '-1');
  const at = await renameAccount(people.at, '@x');
  const invitee = uniqueEmail('team-invitee');
  await sendInvite(project.id, owner, invitee, 'member');
  for (const removed of [formula, minus]) {
    expect((await call('DELETE', `/api/projects/${project.id}/members/${removed.userId}`, { as: owner })).status).toBe(200);
  }
  for (const leaver of [plus, at]) {
    expect((await call('POST', `/api/projects/${project.id}/leave`, { as: leaver })).status).toBe(200);
  }
  const before = (await activityPage(project.id, owner)).entries;
  expect(before).toHaveLength(5);

  await signIn(page, owner);
  await openActivity(page, project.id);
  const button = page.getByRole('button', { name: 'Download CSV' });
  const release = await holdRequests(page, 'GET', '/activity/export');
  const response = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/activity/export'));
  const downloadEvent = page.waitForEvent('download');
  await button.click();
  await expect(page.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
  release();
  const answered = await response;
  expect(answered.status()).toBe(200);
  expect(answered.headers()['content-type']).toBe('text/csv; charset=utf-8');
  expect(answered.headers()['cache-control']).toBe('no-store');
  const file = await readDownload(await downloadEvent);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toBeEnabled();

  const day = new Date().toISOString().slice(0, 10);
  expect(file.filename).toBe(`activity-${project.id}-${day}.csv`);
  expect(file.hasBom).toBe(true);
  expect(file.lineEndings).toBe('crlf');
  expect(file.lines[0]).toBe(ACTIVITY_CSV_HEADER);
  expect(file.lines).toHaveLength(1 + before.length);

  // Newest first, every cell as the API holds it, formula starts made inert.
  const rows = parseCsv(file.text).slice(1);
  const inert = (value: string | null) => (value && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value ?? '');
  expect(rows.map((cells) => cells[10])).toEqual(before.map((e) => e.id));
  for (const [index, entry] of before.entries()) {
    expect(rows[index]).toEqual([
      entry.occurredAt,
      inert(entry.actorLabel),
      entry.action,
      entry.targetType ?? '',
      entry.targetId ?? '',
      inert(entry.targetLabel),
      entry.ipAddress ?? '',
      entry.country ?? '',
      entry.userAgent ?? '',
      entry.details ? JSON.stringify(entry.details) : '',
      entry.id,
    ]);
  }
  const text = file.text;
  expect(text).toContain(`,"'=HYPERLINK(""http://x"",""y"") (${formula.email})",`);
  expect(text).toContain(`,'-1 (${minus.email}),`);
  expect(text).toContain(`,'+1 (${plus.email}),member.left,`);
  expect(text).toContain(`,'@x (${at.email}),member.left,`);
  expect(text).toContain(`"{""role"":""member"",""email"":""${invitee}""}"`);
  expect(text).not.toContain('activity.exported');

  const [exportedEntry] = (await activityPage(project.id, owner)).entries;
  expect(exportedEntry).toMatchObject({
    action: 'activity.exported',
    group: 'activity',
    actorUserId: owner.userId,
    details: { filters: {}, rows: before.length },
  });
  await page.reload();
  await expect(
    page.getByRole('cell', { name: `Omar Owner downloaded the activity log (${before.length} entries)`, exact: true }),
  ).toBeVisible();
});

test('TEAM-164 admin\'s download omits privacy entries', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { admin: ['admin', 'Adam Admin'] });
  const { admin } = people;
  await seedPrivacyEntries(project.id, owner);
  await insertActivity(project.id, [
    { action: 'person.exported', actorUserId: owner.userId, actorLabel: personLabel(owner) },
    { action: 'tracking.objection_recorded', actorUserId: owner.userId, actorLabel: personLabel(owner) },
  ]);

  const csv = await rawGet(`/api/projects/${project.id}/activity/export`, admin.accessToken, admin.ip);
  expect(csv.status).toBe(200);
  const rows = parseCsv(csv.text).slice(1);
  expect(rows.map((cells) => cells[2])).toEqual(['member.invited']);

  const [exported] = (await activityPage(project.id, owner)).entries;
  expect(exported).toMatchObject({ action: 'activity.exported', actorUserId: admin.userId, details: { filters: {}, rows: 1 } });
  // The owner's own file has every entry, the admin's download included.
  const full = await rawGet(`/api/projects/${project.id}/activity/export`, owner.accessToken, owner.ip);
  expect(parseCsv(full.text).slice(1)).toHaveLength(6);
});

// ---- L. Role matrix

test('TEAM-166 representative route per permission, per role', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  const outsider = await newPerson('team-outsider', 'Xena Outsider');
  const probe = { roleMatrixProbe: true };
  const base = `/api/projects/${project.id}`;
  const routes: Array<{ permission: string; method: string; path: string; write: boolean }> = [
    { permission: 'project.read', method: 'GET', path: `${base}/segments`, write: false },
    { permission: 'messaging.write', method: 'POST', path: `${base}/segments`, write: true },
    { permission: 'people.read', method: 'GET', path: `/api/identity/projects/${project.id}/devices?userId=nobody`, write: false },
    { permission: 'channels.manage', method: 'POST', path: `${base}/webhooks`, write: true },
    { permission: 'keys.manage', method: 'GET', path: `${base}/api-keys`, write: false },
    { permission: 'members.manage', method: 'GET', path: `${base}/invitations`, write: false },
    { permission: 'activity.view', method: 'GET', path: `${base}/activity`, write: false },
    { permission: 'privacy', method: 'GET', path: `${base}/privacy-requests`, write: false },
    { permission: 'project.admin', method: 'PATCH', path: base, write: true },
  ];
  const callers: Array<[string, Person, string[] | null]> = [
    ['owner', owner, OWNER_PERMISSIONS],
    ['admin', people.admin, ADMIN_PERMISSIONS],
    ['member', people.member, MEMBER_PERMISSIONS],
    ['outsider', outsider, null],
  ];
  for (const [who, caller, allowed] of callers) {
    for (const route of routes) {
      const result = await call(route.method, route.path, {
        as: { accessToken: caller.accessToken, ip: newClientIp() },
        body: route.write ? probe : undefined,
      });
      const label = `${who} ${route.method} ${route.path} (${route.permission})`;
      if (allowed === null) {
        expect(result.status, label).toBe(404);
        expect(messageOf(result), label).toBe(PROJECT_NOT_FOUND);
      } else if (!allowed.includes(route.permission)) {
        expect(result.status, label).toBe(403);
        expect(messageOf(result), label).toBe(ROLE_REFUSAL);
      } else if (route.write) {
        expect(result.status, label).toBe(400);
        expect(messagesOf(result), label).toContain('property roleMatrixProbe should not exist');
      } else {
        expect(result.status, label).toBe(200);
      }
    }
  }
});

test('TEAM-167 permissions list per role', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    admin: ['admin', 'Adam Admin'],
    member: ['member', 'Mia Member'],
  });
  expect(OWNER_PERMISSIONS).toEqual([
    'project.read',
    'messaging.write',
    'people.read',
    'channels.manage',
    'keys.manage',
    'members.manage',
    'activity.view',
    'privacy',
    'project.admin',
  ]);
  const expected: Array<[Person, string, string[], boolean]> = [
    [owner, 'owner', OWNER_PERMISSIONS, true],
    [people.admin, 'admin', OWNER_PERMISSIONS.slice(0, 7), false],
    [people.member, 'member', OWNER_PERMISSIONS.slice(0, 3), false],
  ];
  for (const [person, role, permissions, isBillingOwner] of expected) {
    const listed = (await projectsOf(person)).find((p) => p.id === project.id);
    expect(listed, role).toMatchObject({ role, permissions, isBillingOwner });
  }
});

test('TEAM-168 permissions follow a role change without signing in again', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const { member } = people;
  const keys = `/api/projects/${project.id}/api-keys`;
  const role = (to: string) => call('PATCH', `/api/projects/${project.id}/members/${member.userId}`, { as: owner, body: { role: to } });

  const before = await call('GET', keys, { as: member });
  expect(before.status).toBe(403);
  expect(messageOf(before)).toBe(ROLE_REFUSAL);
  expect((await role('admin')).status).toBe(200);
  expect((await call('GET', keys, { as: member })).status).toBe(200);
  expect((await role('member')).status).toBe(200);
  const after = await call('GET', keys, { as: member });
  expect(after.status).toBe(403);
  expect(messageOf(after)).toBe(ROLE_REFUSAL);
});

test('TEAM-170 a removed member gets 404, not 403', async () => {
  const { owner, project, people } = await makeTeam('Omar Owner', { member: ['member', 'Mia Member'] });
  const { member } = people;
  expect((await call('GET', `/api/projects/${project.id}/segments`, { as: member })).status).toBe(200);
  expect((await call('DELETE', `/api/projects/${project.id}/members/${member.userId}`, { as: owner })).status).toBe(200);
  for (const path of [`/api/projects/${project.id}/segments`, `/api/projects/${project.id}/members`]) {
    const result = await call('GET', path, { as: member });
    expect(result.status, path).toBe(404);
    expect(messageOf(result)).toBe(PROJECT_NOT_FOUND);
  }
});

// ---- M. View-as on TEAM pages

test('TEAM-174 view-as sees the team but changes nothing', async ({ browser, baseURL }) => {
  const { owner, project, people } = await makeTeam('Omar Owner', {
    coOwner: ['owner', 'Cara Co'],
    member: ['member', 'Mia Member'],
  });
  const { member } = people;
  const pending = await sendInvite(project.id, owner, uniqueEmail('team-invitee'), 'member');
  const membersBefore = await membersOf(project.id, owner);
  const invitesBefore = await invitationsOf(project.id, owner);
  const activityBefore = (await activityRows(project.id)).length;

  const staff = await newStaffMember(browser);
  const viewAs = await openViewAsLink(browser, baseURL, await viewAsLink(staff, owner));
  const refusals: Array<{ status: number; message: unknown }> = [];
  viewAs.on('response', async (response) => {
    if (response.request().method() !== 'GET' && response.url().includes('/api/')) {
      refusals.push({ status: response.status(), message: (await response.json().catch(() => ({}))).message });
    }
  });

  await openMembers(viewAs, project.id);
  await expect(memberRow(viewAs, member.email)).toBeVisible();
  await expect(pendingInviteRow(viewAs, pending.email)).toBeVisible();

  await expectOwnReadOnlyToast(viewAs, () => chooseRole(viewAs, member.email, 'Admin'));
  await expect(toastTitled(viewAs, 'Role not changed')).toContainText(READ_ONLY);

  await memberRow(viewAs, member.email).getByRole('button', { name: 'Remove Mia Member' }).click();
  const removeDialog = viewAs.getByRole('dialog', { name: 'Remove Mia Member?' });
  await expectOwnReadOnlyToast(viewAs, () => removeDialog.getByRole('button', { name: 'Remove', exact: true }).click());
  // The modal dialog hides the rest of the page (toasts included) from the accessibility tree.
  await expect(toastsBehindDialog(viewAs, 'Not removed')).toContainText(READ_ONLY);
  await expect(removeDialog).toBeVisible();
  await removeDialog.getByRole('button', { name: 'Cancel' }).click();

  await viewAs.getByLabel('Email address').fill(uniqueEmail('team-viewas-invite'));
  await expectOwnReadOnlyToast(viewAs, () => viewAs.getByRole('button', { name: 'Send invite' }).click());
  await expect(viewAs.getByRole('alert').filter({ hasText: READ_ONLY })).toHaveText(READ_ONLY);

  await expectOwnReadOnlyToast(viewAs, () => viewAs.getByRole('button', { name: `Resend the invite to ${pending.email}` }).click());
  await expect(toastTitled(viewAs, 'Invite not resent')).toContainText(READ_ONLY);
  await expectOwnReadOnlyToast(viewAs, () => viewAs.getByRole('button', { name: `Cancel the invite to ${pending.email}` }).click());
  await expect(toastTitled(viewAs, 'Invite not cancelled')).toContainText(READ_ONLY);
  await expect(viewAs.getByRole('dialog', { name: /^Invite link for/ })).toHaveCount(0);
  await expect(viewAs.getByText(/#token=/)).toHaveCount(0);

  await openSettings(viewAs, project.id);
  await billingPicker(viewAs).click();
  await viewAs.getByRole('option', { name: 'Cara Co', exact: true }).click();
  await expectOwnReadOnlyToast(viewAs, () => viewAs.getByRole('button', { name: 'Offer billing' }).click());
  await expect(toastTitled(viewAs, 'Billing not offered')).toContainText(READ_ONLY);

  await expect.poll(() => refusals.length).toBe(6);
  for (const refusal of refusals) expect(refusal).toEqual({ status: 403, message: READ_ONLY });
  expect(await membersOf(project.id, owner)).toEqual(membersBefore);
  expect(await invitationsOf(project.id, owner)).toEqual(invitesBefore);
  // The only new entry is the view-as itself.
  const activityAfter = (await activityRows(project.id)).map((r) => r.action);
  expect(activityAfter.slice(0, activityAfter.length - activityBefore)).toEqual(['staff.viewed_as']);
});

// ---- O. Invitations: races

test('TEAM-189 two invites racing for the last free seat', async () => {
  const { owner, project } = await makeTeam('Omar Owner', {});
  const second = await createProject(owner, owner.ip, `Team ${randomUUID().slice(0, 6)}`);
  const seats = (await projectsMetaOf(owner)).seats;
  await setSeatLimit(owner, seats.used + 1);
  const invite = (projectId: string) =>
    call('POST', `/api/projects/${projectId}/invitations`, {
      as: { accessToken: owner.accessToken, ip: newClientIp() },
      body: { email: uniqueEmail('team-race'), role: 'member' },
    });
  const inviteRows = () =>
    withDb(async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM project_invitations WHERE project_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [[project.id, second.id]],
      );
      return Number(rows[0].n);
    });
  const invitedEntries = async () =>
    (await activityRows(project.id)).filter((r) => r.action === 'member.invited').length +
    (await activityRows(second.id)).filter((r) => r.action === 'member.invited').length;

  for (let round = 0; round < 5; round += 1) {
    for (const targets of [[project.id, project.id], [project.id, second.id]]) {
      const entriesBefore = await invitedEntries();
      const results = await Promise.all(targets.map((id) => invite(id)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, `round ${round} ${targets[0] === targets[1] ? 'same project' : 'two projects'}`).toEqual([201, 403]);
      expect(messageOf(results.find((r) => r.status === 403)!)).toBe(SEAT_LIMIT_MESSAGE);
      expect(await inviteRows()).toBe(1);
      expect(await invitedEntries()).toBe(entriesBefore + 1);
      expect((await projectsMetaOf(owner)).seats).toEqual({ used: seats.used + 1, limit: seats.used + 1 });

      // Free the seat again for the next run.
      const made = results.find((r) => r.status === 201)!.body.data.invitation.id as string;
      const projectOf = targets[results.findIndex((r) => r.status === 201)];
      const revoked = await call('DELETE', `/api/projects/${projectOf}/invitations/${made}`, {
        as: { accessToken: owner.accessToken, ip: newClientIp() },
      });
      expect(revoked.status).toBe(200);
    }
  }
});
