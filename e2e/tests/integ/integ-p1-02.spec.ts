import { randomUUID } from 'crypto';
import type { Page, Response } from '@playwright/test';
import { api, newClientIp } from '../../support/api';
import { seedFcmConfig } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import { mailsTo } from '../../support/mailbox';
import { campaignRecipients } from '../../support/seed';
import { stubCalls } from '../../support/provider-stub';
import {
  READ_ONLY,
  activityRows,
  allActivity,
  apiKeyRows,
  as,
  campaignRows,
  cohortSnapshot,
  cohortStat,
  configureMixpanel,
  connectMixpanel,
  createInAppMessage,
  createWebhook,
  identifyDevice,
  identifyPerson,
  literalHookUrl,
  messageOf,
  mixpanelConfigRows,
  openViewAs,
  ownMixpanelProjectId,
  ownerWithProject,
  pendingInAppRows,
  raw,
  refuseMixpanelCredentials,
  refusedAsReadOnly,
  registerToken,
  sdkProject,
  seedCohortWith,
  seedShortLink,
  sql,
  stubMixpanelCohortList,
  stubMixpanelMembers,
  teammate,
  toast,
  viewAsHandoff,
  viewAsToken,
  webhookCard,
  webhookRows,
  type SdkProject,
} from '../../support/areas/integ';

/**
 * Integrations, P1 (second part): the Mixpanel cohorts list (empty state, the cohort
 * select, import and its validation, the table, sync and delete, members), the cohort
 * page (stats, members table, filter and paging, push form), cohort push and in-app
 * trigger refusals, a deleted project's integrations, and additions on privacy keys,
 * the webhook secret dialog, webhook PATCH validation and conversions for
 * do-not-track people. Mixpanel's own API is the provider stub, told per test (by a
 * Mixpanel project id of the test's own) which cohorts and profiles to answer.
 */

test.describe.configure({ mode: 'parallel' });

const NOT_CONFIGURED = 'Mixpanel is not configured for this project';
const DAY_MS = 24 * 60 * 60 * 1000;

function cardTitled(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').getByText(title, { exact: true }) });
}

function cohortRow(page: Page, name: string) {
  return page.locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) });
}

async function openCohorts(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/mixpanel/cohorts`);
  await expect(page.getByRole('heading', { name: 'Mixpanel Cohorts' })).toBeVisible();
}

async function openCohort(page: Page, projectId: string, cohortId: string, heading: string): Promise<void> {
  await page.goto(`/projects/${projectId}/mixpanel/cohorts/${cohortId}`);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}

function isApi(r: Response, method: string, suffix: string): boolean {
  return r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix);
}

/** A date-time as this page shows it (`toLocaleString` in the browser). */
function localDateTime(page: Page, iso: string): Promise<string> {
  return page.evaluate((value) => new Date(value).toLocaleString(), iso);
}

/** Answers the dashboard's cohort list from Mixpanel with `cohorts`, after `delayMs`. */
async function routeAvailable(page: Page, projectId: string, cohorts: () => Array<{ id: number; name: string; count: number }>, delayMs = 0): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith(`/api/projects/${projectId}/mixpanel/available-cohorts`),
    async (route) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ json: { data: cohorts().map((c) => ({ ...c, description: null, created: '2026-01-01 00:00:00' })) } });
    },
  );
}

// ---------------------------------------------------------------- cohorts list and import

test('INTEG-094 cohorts page before Mixpanel is connected', async ({ page }) => {
  const p = await ownerWithProject();
  const available: Array<{ status: number; message: unknown }> = [];
  page.on('response', async (r) => {
    if (isApi(r, 'GET', `/projects/${p.project.id}/mixpanel/available-cohorts`)) {
      available.push({ status: r.status(), message: (await r.json().catch(() => null))?.message });
    }
  });
  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  await expect(page.getByRole('button', { name: 'Configure', exact: true }).and(page.locator('[data-slot="button"]'))).toBeVisible();
  const importCard = cardTitled(page, 'Import Cohort');
  await expect(importCard).toContainText('Select a cohort from Mixpanel to import.');
  await expect(importCard.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  const imported = cardTitled(page, 'Imported Cohorts');
  await expect(imported).toContainText('Cohorts synced from your Mixpanel project.');
  await expect(imported.getByText('No cohorts imported yet. Use the import panel above to get started.', { exact: true })).toBeVisible();

  await expect.poll(() => available.length).toBeGreaterThan(0);
  expect(available[0]).toEqual({ status: 400, message: NOT_CONFIGURED });
  await expect(page.getByRole('combobox')).toBeEnabled();
  await page.getByRole('combobox').click();
  const options = page.getByRole('option');
  await expect(options).toHaveText(['No new cohorts available']);
  await expect(options.first()).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // Nothing on the page says what went wrong.
  await expect(page.locator('li[data-swipe-direction]')).toHaveCount(0);
  await expect(page.getByText(NOT_CONFIGURED)).toHaveCount(0);
  await expect(page.getByText(/not configured|connect/i)).toHaveCount(0);
});

test('INTEG-095 the cohort select', async ({ page }) => {
  const p = await ownerWithProject();
  await connectMixpanel(p.owner, p.project.id);
  await seedCohortWith(p.project.id, { name: 'Old', mixpanelCohortId: 11 });
  let listed = [
    { id: 11, name: 'Old', count: 5 },
    { id: 12, name: 'Buyers', count: 1234 },
  ];
  await routeAvailable(page, p.project.id, () => listed, 2000);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/mixpanel/cohorts`);
  const select = page.getByRole('combobox');
  await expect(select).toBeDisabled();
  await expect(select).toHaveText('Loading...');
  await expect(select).toBeEnabled({ timeout: 10_000 });
  await expect(select).toHaveText('Select a cohort');
  await select.click();
  await expect(page.getByRole('option')).toHaveText(['Buyers (1,234 users)']);
  await page.keyboard.press('Escape');

  // Every available cohort already imported.
  listed = [{ id: 11, name: 'Old', count: 5 }];
  await page.reload();
  await expect(select).toBeEnabled({ timeout: 10_000 });
  await select.click();
  await expect(page.getByRole('option')).toHaveText(['No new cohorts available']);
});

test('INTEG-097 import fails when Mixpanel refuses the credentials', async ({ page }) => {
  const p = await ownerWithProject();
  const mixpanelProjectId = ownMixpanelProjectId();
  await configureMixpanel(p.owner, p.project.id, mixpanelProjectId);
  await refuseMixpanelCredentials(mixpanelProjectId);
  await routeAvailable(page, p.project.id, () => [{ id: 777, name: 'Lapsed', count: 3 }]);
  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Lapsed (3 users)' }).click();
  const imported = page.waitForResponse((r) => isApi(r, 'POST', '/mixpanel/cohorts/import'));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const response = await imported;
  expect(response.status()).toBe(500);
  expect((await response.json()).message).toBe('Internal server error');
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to import cohort' })).toBeVisible();
  await expect(page.getByText('No cohorts imported yet. Use the import panel above to get started.', { exact: true })).toBeVisible();

  expect(await sql(`SELECT id FROM mixpanel_cohorts WHERE "projectId" = $1`, [p.project.id])).toHaveLength(0);
  const calls = (await stubCalls('mixpanel')).filter((c) => c.path === `/api/2.0/cohorts/list?project_id=${mixpanelProjectId}`);
  expect(calls.length).toBeGreaterThan(0);
});

test('INTEG-097 import on a project with no Mixpanel config is refused as a bad request', async () => {
  const p = await ownerWithProject();
  const response = await as(p.owner, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/import`, { mixpanelCohortId: 1 });
  expect(await sql(`SELECT id FROM mixpanel_cohorts WHERE "projectId" = $1`, [p.project.id])).toHaveLength(0);
  expect(response.status).toBe(400);
  expect(messageOf(response)).toBe(NOT_CONFIGURED);
});

test('INTEG-098 import: request validation', async () => {
  const p = await ownerWithProject();
  const mixpanelProjectId = ownMixpanelProjectId();
  await configureMixpanel(p.owner, p.project.id, mixpanelProjectId);
  await stubMixpanelCohortList(mixpanelProjectId, [{ id: 12, name: 'Twelve', count: 0 }]);
  const path = `/api/projects/${p.project.id}/mixpanel/cohorts/import`;
  const NOT_A_NUMBER = 'mixpanelCohortId must be a number conforming to the specified constraints';
  const NOT_POSITIVE = 'mixpanelCohortId must be a positive number';
  const cases: Array<[unknown, string[]]> = [
    [{}, [NOT_A_NUMBER]],
    [{ mixpanelCohortId: 0 }, [NOT_POSITIVE]],
    [{ mixpanelCohortId: -5 }, [NOT_POSITIVE]],
    [{ mixpanelCohortId: 'abc' }, [NOT_A_NUMBER]],
    [{ mixpanelCohortId: 5, name: 'x' }, ['property name should not exist']],
  ];
  for (const [body, expected] of cases) {
    const response = await as(p.owner, 'POST', path, body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    const messages = (response.body as { message: string[] }).message;
    for (const message of expected) expect(messages, JSON.stringify(body)).toContain(message);
  }
  expect(await sql(`SELECT id FROM mixpanel_cohorts WHERE "projectId" = $1`, [p.project.id])).toHaveLength(0);

  // A numeric string is converted and accepted.
  const accepted = await as(p.owner, 'POST', path, { mixpanelCohortId: '12' });
  expect(accepted.status).toBe(201);
  expect(accepted.body.data).toMatchObject({ mixpanelCohortId: 12, name: 'Twelve' });
  const rows = await sql(`SELECT "mixpanelCohortId" FROM mixpanel_cohorts WHERE "projectId" = $1`, [p.project.id]);
  expect(rows.map((r) => r.mixpanelCohortId)).toEqual([12]);
});

test('INTEG-099 the imported cohorts table', async ({ page }) => {
  const p = await ownerWithProject();
  const now = Date.now();
  const errorText = `Mixpanel exploded ${randomUUID().slice(0, 8)}`;
  await seedCohortWith(p.project.id, {
    name: 'Synced one',
    counts: { mixpanel: 1500, resolved: 1200, unresolved: 300 },
    lastSyncedAt: new Date(now - DAY_MS),
    createdAt: new Date(now - 4 * 60_000),
  });
  await seedCohortWith(p.project.id, { name: 'In progress', status: 'syncing', lastSyncedAt: null, createdAt: new Date(now - 3 * 60_000) });
  await seedCohortWith(p.project.id, { name: 'Broken', status: 'error', errorMessage: errorText, lastSyncedAt: null, createdAt: new Date(now - 2 * 60_000) });
  await seedCohortWith(p.project.id, { name: 'Fresh', status: 'pending', lastSyncedAt: null, createdAt: new Date(now - 60_000) });
  const listed = await as(p.owner, 'GET', `/api/projects/${p.project.id}/mixpanel/cohorts`);
  const synced = (listed.body.data as Array<{ name: string; lastSyncedAt: string }>).find((c) => c.name === 'Synced one')!;

  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  await expect(page.locator('thead th')).toHaveText(['Name', 'Status', 'Mixpanel Count', 'Resolved', 'Unresolved', 'Last Synced', 'Actions']);
  const rows = page.locator('tbody tr');
  await expect(rows.locator('td:first-child')).toHaveText(['Fresh', 'Broken', 'In progress', 'Synced one']);

  await expect(cohortRow(page, 'Synced one').locator('td')).toHaveText([
    'Synced one',
    'Synced',
    '1,500',
    '1,200',
    '300',
    await localDateTime(page, synced.lastSyncedAt),
    '',
  ]);
  const badges: Array<[string, string, RegExp]> = [
    ['Synced one', 'Synced', /bg-green-500/],
    ['In progress', 'Syncing', /bg-yellow-500/],
    ['Broken', 'Error', /bg-red-500/],
    ['Fresh', 'Pending', /bg-gray-400/],
  ];
  for (const [name, label, colour] of badges) {
    const badge = cohortRow(page, name).locator('[data-slot="badge"]');
    await expect(badge).toHaveText(label);
    await expect(badge).toHaveClass(colour);
  }
  for (const name of ['In progress', 'Broken', 'Fresh']) {
    await expect(cohortRow(page, name).locator('td').nth(5)).toHaveText('—');
  }
  for (const name of ['Synced one', 'Broken', 'Fresh', 'In progress']) {
    const buttons = cohortRow(page, name).getByRole('button');
    await expect(buttons).toHaveCount(3);
    if (name === 'In progress') await expect(buttons.nth(0)).toBeDisabled();
    else await expect(buttons.nth(0)).toBeEnabled();
    await expect(buttons.nth(1)).toBeEnabled();
    await expect(buttons.nth(2)).toBeEnabled();
  }
  expect(await page.content()).not.toContain(errorText);
});

test('INTEG-100 cohort names are shown as text', async ({ page }) => {
  const p = await ownerWithProject();
  const name = '<img src=x onerror=alert(1)>Buyers';
  const cohort = await seedCohortWith(p.project.id, { name });
  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    await d.dismiss();
  });
  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  const row = cohortRow(page, name);
  await expect(row.locator('td').first()).toHaveText(name);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);

  await row.getByRole('button').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);

  await openCohorts(page, p.project.id);
  await cohortRow(page, name).getByRole('button').nth(2).click();
  await expect.poll(() => dialogs).toEqual([`confirm: Delete cohort "${name}"?`]);
  await expect(cohortRow(page, name)).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect((await cohortSnapshot(cohort.id)).cohort).toBeDefined();
});

test('INTEG-101 sync a cohort from the list', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const mixpanelProjectId = ownMixpanelProjectId();
  await configureMixpanel(p.owner, p.project.id, mixpanelProjectId);
  const tag = randomUUID().slice(0, 8);
  // One profile per way a member may or may not match: a verified external id, a device's
  // distinct id, and an address no confirmation link was opened for.
  const verifiedId = `buyer-${tag}`;
  const known = await identifyPerson(p, verifiedId);
  const anonymousId = `anon-sync-${tag}`;
  const anonymous = await identifyDevice(p, { distinctId: anonymousId });
  const unconfirmedEmail = `unconfirmed-${tag}@example.com`;
  const unconfirmed = await identifyDevice(p, { email: unconfirmedEmail });
  const [anonymousRow] = await sql(`SELECT distinct_id, external_user_id FROM device_identities WHERE id = $1`, [anonymous.id]);
  expect(anonymousRow).toEqual({ distinct_id: anonymousId, external_user_id: null });
  const [unconfirmedRow] = await sql(`SELECT email, email_confirmed_at, external_user_id FROM device_identities WHERE id = $1`, [unconfirmed.id]);
  expect(unconfirmedRow).toEqual({ email: unconfirmedEmail, email_confirmed_at: null, external_user_id: null });
  const cohort = await seedCohortWith(p.project.id, {
    name: 'Weekly buyers',
    counts: { mixpanel: 1500, resolved: 1200, unresolved: 300 },
    lastSyncedAt: new Date(Date.now() - DAY_MS),
  });
  await stubMixpanelCohortList(mixpanelProjectId, [{ id: cohort.mixpanelCohortId, name: 'Weekly buyers', count: 3 }]);
  await stubMixpanelMembers(mixpanelProjectId, [
    { distinctId: verifiedId },
    { distinctId: anonymousId },
    { distinctId: `mp-${tag}`, properties: { $email: unconfirmedEmail } },
  ]);
  const activityBefore = (await allActivity(p.project.id)).length;

  // 1. Mixpanel answers: the sync starts, then finishes with fresh counts.
  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  const started = page.waitForResponse((r) => isApi(r, 'POST', `/mixpanel/cohorts/${cohort.id}/sync`));
  await cohortRow(page, 'Weekly buyers').getByRole('button').nth(0).click();
  const startedResponse = await started;
  expect(startedResponse.status()).toBe(201);
  expect((await startedResponse.json()).data.status).toBe('syncing');
  await expect(toast(page, 'Sync started')).toBeVisible();
  await expect.poll(async () => (await cohortSnapshot(cohort.id)).cohort?.status, { timeout: 20_000 }).toBe('synced');
  await page.reload();
  await expect(cohortRow(page, 'Weekly buyers').locator('td').nth(1)).toHaveText('Synced');
  await expect(cohortRow(page, 'Weekly buyers').locator('td').nth(2)).toHaveText('3');
  await expect(cohortRow(page, 'Weekly buyers').locator('td').nth(3)).toHaveText('1');
  await expect(cohortRow(page, 'Weekly buyers').locator('td').nth(4)).toHaveText('2');
  const afterSync = await cohortSnapshot(cohort.id);
  expect(afterSync.members.map((m) => [m.mixpanelDistinctId, m.deviceIdentityId, m.resolvedBy, m.isResolved]).sort()).toEqual(
    [
      [verifiedId, known.id, 'external_user_id', true],
      [anonymousId, null, null, false],
      [`mp-${tag}`, null, null, false],
    ].sort(),
  );

  // 2. Mixpanel refuses the credentials: an error toast, and the cohort as it was.
  await refuseMixpanelCredentials(mixpanelProjectId);
  const refused = page.waitForResponse((r) => isApi(r, 'POST', `/mixpanel/cohorts/${cohort.id}/sync`));
  await cohortRow(page, 'Weekly buyers').getByRole('button').nth(0).click();
  expect((await refused).status()).toBe(500);
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to sync cohort' })).toBeVisible();
  await expect(cohortRow(page, 'Weekly buyers').locator('td').nth(1)).toHaveText('Synced');
  const afterRefusal = await cohortSnapshot(cohort.id);
  expect(afterRefusal.cohort).toMatchObject({ status: 'synced', mixpanelUserCount: 3, resolvedCount: 1, unresolvedCount: 2 });

  // 3. An unknown cohort.
  const unknown = await as(p.owner, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/${randomUUID()}/sync`);
  expect([unknown.status, messageOf(unknown)]).toEqual([404, 'Cohort not found']);
  expect(await allActivity(p.project.id)).toHaveLength(activityBefore);
});

test('INTEG-103 delete a cohort', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const device = await identifyDevice(p);
  const cohort = await seedCohortWith(p.project.id, { name: 'Lapsed', members: [{ deviceIdentityId: device.id }, { deviceIdentityId: null }, { deviceIdentityId: null }] });
  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  const row = cohortRow(page, 'Lapsed');
  const deletes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && r.url().includes('/mixpanel/cohorts/')) deletes.push(r.url());
  });

  let message = '';
  page.once('dialog', async (d) => {
    message = d.message();
    await d.dismiss();
  });
  await row.getByRole('button').nth(2).click();
  await expect.poll(() => message).toBe('Delete cohort "Lapsed"?');
  await expect(row).toBeVisible();
  expect(deletes).toHaveLength(0);
  expect((await cohortSnapshot(cohort.id)).members).toHaveLength(3);

  page.once('dialog', (d) => d.accept());
  const deleted = page.waitForResponse((r) => isApi(r, 'DELETE', `/mixpanel/cohorts/${cohort.id}`));
  await row.getByRole('button').nth(2).click();
  const response = await deleted;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ data: { message: 'Cohort deleted successfully' } });
  await expect(toast(page, 'Cohort deleted')).toBeVisible();
  await expect(row).toHaveCount(0);
  const after = await cohortSnapshot(cohort.id);
  expect(after.cohort).toBeUndefined();
  expect(after.members).toHaveLength(0);

  const entries = await activityRows(p.project.id, 'content.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0].details).toEqual({ kind: 'cohort' });
  expect(entries[0].target_label).toBe('Lapsed');
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} deleted the cohort "Lapsed"`, { exact: true })).toBeVisible();
});

test('INTEG-104 delete: edge cases', async ({ page }) => {
  const p = await ownerWithProject();
  const x = await ownerWithProject('integ-x', 'Xena Other');
  const c2 = await seedCohortWith(x.project.id, { name: 'Their cohort', members: [{ deviceIdentityId: null }] });
  const base = `/api/projects/${p.project.id}/mixpanel/cohorts`;

  const unknown = await as(p.owner, 'DELETE', `${base}/${randomUUID()}`);
  expect([unknown.status, messageOf(unknown)]).toEqual([404, 'Cohort not found']);

  const twice = await seedCohortWith(p.project.id, { name: 'Twice' });
  const first = await as(p.owner, 'DELETE', `${base}/${twice.id}`);
  expect(first.status).toBe(200);
  const second = await as(p.owner, 'DELETE', `${base}/${twice.id}`);
  expect([second.status, messageOf(second)]).toEqual([404, 'Cohort not found']);
  expect(await activityRows(p.project.id, 'content.deleted')).toHaveLength(1);

  const before = await cohortSnapshot(c2.id);
  const foreign = await as(p.owner, 'DELETE', `${base}/${c2.id}`);
  expect([foreign.status, messageOf(foreign)]).toEqual([404, 'Cohort not found']);
  expect(await cohortSnapshot(c2.id)).toEqual(before);
  expect(await activityRows(x.project.id, 'content.deleted')).toHaveLength(0);

  const kept = await seedCohortWith(p.project.id, { name: 'Server says no' });
  await signIn(page, p.owner);
  await page.route(
    (url) => url.pathname.endsWith(`/mixpanel/cohorts/${kept.id}`),
    (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({ status: 500, json: { statusCode: 500, message: 'Internal server error' } })
        : route.fallback(),
  );
  await openCohorts(page, p.project.id);
  page.once('dialog', (d) => d.accept());
  await cohortRow(page, 'Server says no').getByRole('button').nth(2).click();
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to delete cohort' })).toBeVisible();
  await expect(cohortRow(page, 'Server says no')).toBeVisible();
  expect((await cohortSnapshot(kept.id)).cohort).toBeDefined();
});

test('INTEG-105 a member can import, sync and delete cohorts', async ({ page }) => {
  const p = await ownerWithProject();
  const mixpanelProjectId = ownMixpanelProjectId();
  await configureMixpanel(p.owner, p.project.id, mixpanelProjectId);
  await stubMixpanelCohortList(mixpanelProjectId, [{ id: 1, name: 'Imported by a member', count: 0 }]);
  const member = await teammate(p, 'member', 'Mo Member');
  const seeded = await seedCohortWith(p.project.id, { name: 'Member managed' });
  const statuses: Array<[string, number]> = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.includes('/mixpanel/')) statuses.push([`${r.request().method()} ${new URL(r.url()).pathname}`, r.status()]);
  });

  await signIn(page, member);
  await openCohorts(page, p.project.id);
  await expect(page.getByRole('button', { name: 'Configure', exact: true }).and(page.locator('[data-slot="button"]'))).toBeVisible();
  await expect(cardTitled(page, 'Import Cohort').getByRole('combobox')).toBeVisible();
  await expect(cardTitled(page, 'Import Cohort').getByRole('button', { name: 'Import', exact: true })).toBeVisible();
  const row = cohortRow(page, 'Member managed');
  await expect(row.getByRole('button')).toHaveCount(3);
  for (const i of [0, 1, 2]) await expect(row.getByRole('button').nth(i)).toBeEnabled();

  page.once('dialog', (d) => d.accept());
  await row.getByRole('button').nth(2).click();
  await expect(toast(page, 'Cohort deleted')).toBeVisible();
  await expect(row).toHaveCount(0);
  const [entry] = await activityRows(p.project.id, 'content.deleted');
  expect(entry.actor_user_id).toBe(member.userId);
  expect(entry.target_label).toBe('Member managed');
  expect((await cohortSnapshot(seeded.id)).cohort).toBeUndefined();

  const imported = await as(member, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/import`, { mixpanelCohortId: 1 });
  expect(imported.status).toBe(201);
  const synced = await as(member, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/${imported.body.data.id}/sync`);
  expect(synced.status).toBe(201);
  expect(statuses.filter(([, status]) => status === 403)).toEqual([]);
  expect(statuses.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- cohort page

test('INTEG-107 the cohort detail page', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const d1 = await identifyDevice(p);
  await registerToken(p, d1.fingerprint, 'android');
  const d2 = await identifyDevice(p);
  await registerToken(p, d2.fingerprint, 'ios');
  const d3 = await identifyDevice(p);
  const cohort = await seedCohortWith(p.project.id, {
    name: 'Buyers',
    lastSyncedAt: new Date(Date.now() - DAY_MS),
    members: [{ deviceIdentityId: d1.id }, { deviceIdentityId: d2.id }, { deviceIdentityId: d3.id }, { deviceIdentityId: null }],
  });
  const { body } = await as(p.owner, 'GET', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}`);

  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  // The cohort and its push figures are held a moment, so the loading states can be seen.
  await page.route(
    (url) => url.pathname.endsWith(`/mixpanel/cohorts/${cohort.id}`),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fallback();
    },
  );
  await page.route(
    (url) => url.pathname.endsWith(`/mixpanel/cohorts/${cohort.id}/push-stats`),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      await route.fallback();
    },
  );
  await cohortRow(page, 'Buyers').getByRole('button').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}$`));
  await expect(page.locator('main .animate-pulse, .animate-pulse').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Buyers', exact: true })).toBeVisible();
  await expect(cohortStat(page, 'Push Enabled')).toHaveText('—');

  const checkPage = async () => {
    await expect(page.getByRole('heading', { name: 'Buyers', exact: true })).toBeVisible();
    await expect(page.locator('h1 + [data-slot="badge"]')).toHaveText('Synced');
    await expect(page.getByText(`Last synced: ${await localDateTime(page, body.data.lastSyncedAt)}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeEnabled();
    await expect(cohortStat(page, 'Mixpanel Count')).toHaveText('4');
    await expect(cohortStat(page, 'Resolved')).toHaveText('3');
    await expect(cohortStat(page, 'Unresolved')).toHaveText('1');
    await expect(cohortStat(page, 'Push Enabled')).toHaveText('2', { timeout: 10_000 });
    await expect(cardTitled(page, 'Send Push Campaign')).toBeVisible();
    await expect(cardTitled(page, 'Members')).toBeVisible();
  };
  await checkPage();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();
  await checkPage();

  await page.locator('button:has(svg.lucide-arrow-left)').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/mixpanel/cohorts$`));
  await expect(page.getByRole('heading', { name: 'Mixpanel Cohorts' })).toBeVisible();
});

test('INTEG-108 an unknown or foreign cohort id', async ({ page }) => {
  const p = await ownerWithProject();
  const x = await ownerWithProject('integ-x', 'Xena Other');
  const c2 = await seedCohortWith(x.project.id, { name: 'Their secret cohort', members: [{ deviceIdentityId: null, distinctId: 'their-member-1' }] });
  const answers: Array<[string, number, unknown]> = [];
  page.on('response', async (r) => {
    const path = new URL(r.url()).pathname;
    if (r.request().method() === 'GET' && /^\/api\/projects\/[^/]+\/mixpanel\/cohorts\/[^/]+$/.test(path)) {
      answers.push([path.split('/').pop()!, r.status(), (await r.json().catch(() => null))?.message]);
    }
  });
  await signIn(page, p.owner);
  const unknownId = randomUUID();
  const expected: Record<string, [number, string]> = {
    [unknownId]: [404, 'Cohort not found'],
    [c2.id]: [404, 'Cohort not found'],
    'not-a-uuid': [400, 'Validation failed (uuid is expected)'],
  };
  for (const id of [unknownId, c2.id, 'not-a-uuid']) {
    await page.goto(`/projects/${p.project.id}/mixpanel/cohorts/${id}`);
    await expect(page.getByRole('heading', { name: 'Cohort not found' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Back to Cohorts' })).toBeVisible();
    const content = await page.content();
    expect(content).not.toContain('Their secret cohort');
    expect(content).not.toContain('their-member-1');
    const seen = answers.filter(([answered]) => answered === id);
    expect(seen.length, id).toBeGreaterThan(0);
    for (const [, status, message] of seen) expect([status, message], id).toEqual(expected[id]);
  }
  await page.getByRole('button', { name: 'Back to Cohorts' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/mixpanel/cohorts$`));
  await expect(page.getByRole('heading', { name: 'Mixpanel Cohorts' })).toBeVisible();
});

test('INTEG-109 the members table', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const [e1, a2, m3] = [await identifyDevice(p), await identifyDevice(p), await identifyDevice(p)];
  const t = Date.now();
  const cohort = await seedCohortWith(p.project.id, {
    name: 'Mixed members',
    members: [
      { distinctId: 'ext-1', deviceIdentityId: e1.id, resolvedBy: 'external_user_id', addedAt: new Date(t - 5 * 60_000) },
      { distinctId: 'anon-2', deviceIdentityId: a2.id, resolvedBy: 'distinct_id', addedAt: new Date(t - 4 * 60_000) },
      { distinctId: 'mail-3', deviceIdentityId: m3.id, resolvedBy: 'email', addedAt: new Date(t - 3 * 60_000) },
      { distinctId: 'ghost-4', deviceIdentityId: null, addedAt: new Date(t - 2 * 60_000) },
      { distinctId: '<b>x</b>', deviceIdentityId: null, addedAt: new Date(t - 60_000) },
    ],
  });
  const empty = await seedCohortWith(p.project.id, { name: 'Nobody here' });
  const members = await as(p.owner, 'GET', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}/members`);
  const addedAt = new Map((members.body.data.data as Array<{ mixpanelDistinctId: string; addedAt: string }>).map((m) => [m.mixpanelDistinctId, m.addedAt]));

  await signIn(page, p.owner);
  await openCohort(page, p.project.id, cohort.id, 'Mixed members');
  const table = cardTitled(page, 'Members');
  await expect(table.locator('thead th')).toHaveText(['Distinct ID', 'Resolved', 'Resolved By', 'Added At']);
  const rows = table.locator('tbody tr');
  await expect(rows.locator('td:first-child')).toHaveText(['<b>x</b>', 'ghost-4', 'mail-3', 'anon-2', 'ext-1']);
  const expected: Array<[string, string, string]> = [
    ['<b>x</b>', 'Unresolved', '—'],
    ['ghost-4', 'Unresolved', '—'],
    ['mail-3', 'Resolved', 'email'],
    ['anon-2', 'Resolved', 'distinct_id'],
    ['ext-1', 'Resolved', 'external_user_id'],
  ];
  for (const [i, [id, badge, by]] of expected.entries()) {
    await expect(rows.nth(i).locator('td')).toHaveText([id, badge, by, await localDateTime(page, addedAt.get(id)!)]);
  }
  await expect(table.locator('tbody b')).toHaveCount(0);

  await openCohort(page, p.project.id, empty.id, 'Nobody here');
  await expect(cardTitled(page, 'Members').getByText('No members found.', { exact: true })).toBeVisible();
});

test('INTEG-110 the members filter', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const devices = [await identifyDevice(p), await identifyDevice(p), await identifyDevice(p)];
  const cohort = await seedCohortWith(p.project.id, {
    name: 'Filtered',
    members: [...devices.map((d) => ({ deviceIdentityId: d.id })), { deviceIdentityId: null }, { deviceIdentityId: null }],
  });
  const queries: URLSearchParams[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.endsWith(`/mixpanel/cohorts/${cohort.id}/members`)) queries.push(url.searchParams);
  });
  await signIn(page, p.owner);
  await openCohort(page, p.project.id, cohort.id, 'Filtered');
  const members = cardTitled(page, 'Members');
  const rows = members.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  const button = (name: string) => members.getByRole('button', { name, exact: true });
  await expect(button('all')).toHaveAttribute('data-variant', 'default');
  await expect(button('resolved')).toHaveAttribute('data-variant', 'outline');
  expect(queries.at(-1)?.has('resolved')).toBe(false);

  const steps: Array<[string, number, string | null, string]> = [
    ['resolved', 3, 'true', 'Resolved'],
    ['unresolved', 2, 'false', 'Unresolved'],
    ['all', 5, null, ''],
  ];
  for (const [name, count, param, badge] of steps) {
    const seenBefore = queries.length;
    if (param !== null) {
      const sent = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith('/members') && new URL(r.url()).searchParams.get('resolved') === param);
      await button(name).click();
      expect(new URL((await sent).url()).searchParams.get('page')).toBe('1');
    } else {
      // "all" is the first page already fetched (the query cache answers it): whatever
      // is asked for again names no filter.
      await button(name).click();
    }
    await expect(rows).toHaveCount(count);
    for (const query of queries.slice(seenBefore)) {
      expect(query.get('resolved')).toBe(param);
      expect(query.get('page')).toBe('1');
    }
    if (badge) await expect(rows.locator('[data-slot="badge"]')).toHaveText(Array(count).fill(badge));
    await expect(button(name)).toHaveAttribute('data-variant', 'default');
    for (const other of ['all', 'resolved', 'unresolved'].filter((o) => o !== name)) {
      await expect(button(other)).toHaveAttribute('data-variant', 'outline');
    }
  }
});

test('INTEG-111 member count and pages', async ({ page }) => {
  const p = await ownerWithProject();
  const cohort = await seedCohortWith(p.project.id, {
    name: 'Big cohort',
    members: Array.from({ length: 120 }, (_, i) => ({
      deviceIdentityId: null,
      distinctId: `member-${String(i).padStart(3, '0')}`,
      addedAt: new Date(Date.now() - (120 - i) * 1000),
    })),
  });
  await signIn(page, p.owner);
  await openCohort(page, p.project.id, cohort.id, 'Big cohort');
  const members = cardTitled(page, 'Members');
  await expect(members.locator('tbody tr')).toHaveCount(50);
  await expect(members.locator('tbody tr td:first-child').first()).toHaveText('member-119');
  // Only the count and paging below are expected to fail; the first page above must hold.
  test.fail(true, 'INTEG-111');
  test.info().annotations.push({ type: 'issue', description: 'INTEG-111' });
  await expect(members.getByText('120 total members', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(members.getByText('Page 1 of 3', { exact: true })).toBeVisible();
  await expect(members.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await members.getByRole('button', { name: 'Next' }).click();
  await expect(members.getByText('Page 2 of 3', { exact: true })).toBeVisible();
});

test('INTEG-115 in-app stats count only reachable devices', async () => {
  const p = await sdkProject(await ownerWithProject());
  const e1 = await identifyDevice(p);
  const e2 = await identifyDevice(p, { doNotTrack: true });
  const cohort = await seedCohortWith(p.project.id, {
    name: 'In-app reach',
    members: [
      { deviceIdentityId: e1.id },
      { deviceIdentityId: e2.id },
      // A resolved member whose device row (and so its fingerprint) no longer exists.
      { deviceIdentityId: randomUUID() },
      { deviceIdentityId: null },
    ],
  });
  const stats = await as(p.owner, 'GET', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}/iam-stats`);
  expect(stats.status).toBe(200);
  expect(stats.body.data).toEqual({ total: 4, resolved: 3, unresolved: 1, iamEligible: 1 });
});

// ---------------------------------------------------------------- push to a cohort

/** A project with push switched on and a cohort of an Android and an iOS device. */
async function reachableCohort(p: SdkProject, name = 'Buyers') {
  await seedFcmConfig(p.project.id);
  const d1 = await identifyDevice(p);
  await registerToken(p, d1.fingerprint, 'android');
  const d2 = await identifyDevice(p);
  await registerToken(p, d2.fingerprint, 'ios');
  const cohort = await seedCohortWith(p.project.id, { name, members: [{ deviceIdentityId: d1.id }, { deviceIdentityId: d2.id }] });
  return { cohort, d1, d2 };
}

test('INTEG-119 push form validation', async ({ page }) => {
  const p = await ownerWithProject();
  const cohort = await seedCohortWith(p.project.id, { name: 'Form check' });
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/cohorts/${cohort.id}/push`)) posts.push(r.url());
  });
  await signIn(page, p.owner);
  await openCohort(page, p.project.id, cohort.id, 'Form check');
  const form = cardTitled(page, 'Send Push Campaign');
  await expect(form.getByPlaceholder('myapp://screen/path')).toHaveValue('');
  await expect(form.getByText('Deep Link URL (optional)', { exact: true })).toBeVisible();

  await form.getByRole('button', { name: 'Send Push' }).click();
  await expect(form.getByText('Title is required', { exact: true })).toBeVisible();
  await expect(form.getByText('Body is required', { exact: true })).toBeVisible();

  await form.getByPlaceholder('Notification title').fill('Only a title');
  await form.getByRole('button', { name: 'Send Push' }).click();
  await expect(form.getByText('Body is required', { exact: true })).toBeVisible();
  await expect(form.getByText('Title is required', { exact: true })).toHaveCount(0);
  expect(posts).toEqual([]);

  // Positive control: with a body too the form does send, and that is the only request.
  await form.getByPlaceholder('Notification body').fill('And a body');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/cohorts/${cohort.id}/push`));
  await form.getByRole('button', { name: 'Send Push' }).click();
  await sent;
  expect(posts).toHaveLength(1);
});

test('INTEG-120 platform choice', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const { cohort, d1, d2 } = await reachableCohort(p);
  await signIn(page, p.owner);
  await openCohort(page, p.project.id, cohort.id, 'Buyers');
  const form = cardTitled(page, 'Send Push Campaign');
  const send = async (title: string) => {
    await form.getByPlaceholder('Notification title').fill(title);
    await form.getByPlaceholder('Notification body').fill('Body');
    const request = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/cohorts/${cohort.id}/push`));
    const response = page.waitForResponse((r) => isApi(r, 'POST', `/cohorts/${cohort.id}/push`));
    await form.getByRole('button', { name: 'Send Push' }).click();
    const r = await response;
    expect(r.status()).toBe(201);
    return { body: (await request).postDataJSON(), data: (await r.json()).data };
  };

  // 1. iOS unticked: Android only.
  await form.getByRole('checkbox', { name: 'iOS' }).uncheck();
  const androidOnly = await send('Android only');
  expect(androidOnly.body.platforms).toEqual(['android']);
  expect(androidOnly.data).toMatchObject({ devicesTargeted: 1, tokensTargeted: 1 });
  await expect(toast(page, 'Push campaign queued')).toContainText('Sending to 1 device(s).');
  const [first] = await campaignRows(p.project.id);
  expect(await campaignRecipients(first.id)).toEqual([d1.id]);

  // 2. Both unticked: the request names no platform, and the API uses Android and iOS.
  // (Asserts today's behaviour as the case is written.)
  await expect(form.getByRole('checkbox', { name: 'iOS' })).toBeChecked();
  await form.getByRole('checkbox', { name: 'Android' }).uncheck();
  await form.getByRole('checkbox', { name: 'iOS' }).uncheck();
  const neither = await send('No platform ticked');
  expect(neither.body).not.toHaveProperty('platforms');
  expect(neither.data).toMatchObject({ devicesTargeted: 2, tokensTargeted: 2 });
  const second = (await campaignRows(p.project.id)).find((c) => c.title === 'No platform ticked')!;
  expect(await campaignRecipients(second.id)).toEqual([d1.id, d2.id].sort());
});

test('INTEG-122 push: request validation', async () => {
  const p = await sdkProject(await ownerWithProject());
  const { cohort } = await reachableCohort(p);
  const path = `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}/push`;
  const cases: Array<[Record<string, unknown>, string[]]> = [
    [{}, ['title should not be empty', 'title must be a string']],
    [{ title: '' }, ['title should not be empty']],
    [{ title: 't'.repeat(256) }, ['title must be shorter than or equal to 255 characters']],
    [{ title: 't', body: 'b'.repeat(1001) }, ['body must be shorter than or equal to 1000 characters']],
    [{ title: 't', deepLinkUrl: `myapp://${'x'.repeat(2049 - 8)}` }, ['deepLinkUrl must be shorter than or equal to 2048 characters']],
    [{ title: 't', platforms: ['windows'] }, ['each value in platforms must be one of the following values: android, ios, web']],
    [{ title: 't', platforms: 'ios' }, ['platforms must be an array']],
    [{ title: 't', segmentId: randomUUID() }, ['property segmentId should not exist']],
  ];
  for (const [body, expected] of cases) {
    const response = await as(p.owner, 'POST', path, body);
    expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    const messages = (response.body as { message: string[] }).message;
    for (const message of expected) expect(messages, JSON.stringify(body).slice(0, 80)).toContain(message);
  }
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'cohort.push_sent')).toHaveLength(0);

  const titleOnly = await as(p.owner, 'POST', path, { title: 't' });
  expect(titleOnly.status).toBe(201);
  expect(await campaignRows(p.project.id)).toHaveLength(1);
});

// ---------------------------------------------------------------- in-app trigger

test('INTEG-128 in-app trigger: refusals and empty cohorts', async () => {
  const p = await sdkProject(await ownerWithProject());
  const im = await createInAppMessage(p.owner, p.project.id);
  const f1 = await identifyDevice(p);
  const f2 = await identifyDevice(p);
  const buyers = await seedCohortWith(p.project.id, { name: 'Buyers', members: [{ deviceIdentityId: f1.id }, { deviceIdentityId: f2.id }] });
  const empty = await seedCohortWith(p.project.id, { name: 'Empty' });
  const dnt = await identifyDevice(p, { doNotTrack: true });
  const dntCohort = await seedCohortWith(p.project.id, { name: 'Not tracked', members: [{ deviceIdentityId: dnt.id }] });
  const x = await ownerWithProject('integ-x', 'Xena Other');
  const im2 = await createInAppMessage(x.owner, x.project.id, 'Their message');
  const trigger = (cohortId: string, body: unknown) => as(p.owner, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohortId}/iam-trigger`, body);

  for (const body of [{ messageId: 'abc' }, {}]) {
    const response = await trigger(buyers.id, body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect((response.body as { message: string[] }).message).toContain('messageId must be a UUID');
  }
  const foreign = await trigger(buyers.id, { messageId: im2 });
  expect([foreign.status, messageOf(foreign)]).toEqual([404, 'In-app message not found']);
  for (const [cohortId, messageId] of [
    [empty.id, im],
    [empty.id, randomUUID()],
    [dntCohort.id, im],
  ]) {
    const response = await trigger(cohortId, { messageId });
    expect(response.status, `${cohortId} ${messageId}`).toBe(201);
    expect(response.body.data).toEqual({ queued: 0, eligible: 0 });
  }
  const extra = await trigger(buyers.id, { messageId: im, targetType: 'all' });
  expect(extra.status).toBe(400);
  expect((extra.body as { message: string[] }).message).toContain('property targetType should not exist');

  expect(await pendingInAppRows(p.project.id)).toHaveLength(0);
  expect(await pendingInAppRows(x.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'cohort.in_app_triggered')).toHaveLength(0);

  // Positive control: the same cohort and message do queue.
  const ok = await trigger(buyers.id, { messageId: im });
  expect(ok.status).toBe(201);
  expect(ok.body.data).toEqual({ queued: 2, eligible: 2 });
});

test('INTEG-129 who may trigger an in-app message for a cohort', async ({ browser, baseURL }) => {
  const p = await sdkProject(await ownerWithProject());
  const messageId = await createInAppMessage(p.owner, p.project.id);
  const f1 = await identifyDevice(p);
  const f2 = await identifyDevice(p);
  const cohort = await seedCohortWith(p.project.id, { name: 'Buyers', members: [{ deviceIdentityId: f1.id }, { deviceIdentityId: f2.id }] });
  const member = await teammate(p, 'member', 'Mo Member');
  const path = `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}/iam-trigger`;

  const asMember = await as(member, 'POST', path, { messageId });
  expect(asMember.status).toBe(201);
  expect(asMember.body.data).toEqual({ queued: 2, eligible: 2 });
  const entries = await activityRows(p.project.id, 'cohort.in_app_triggered');
  expect(entries).toHaveLength(1);
  expect(entries[0].actor_user_id).toBe(member.userId);
  const queued = (await pendingInAppRows(p.project.id)).length;

  const viewAs = { accessToken: await viewAsToken(browser, baseURL, p.owner), ip: newClientIp() };
  const refused = await as(viewAs, 'POST', path, { messageId });
  expect([refused.status, messageOf(refused)]).toEqual([403, READ_ONLY]);
  expect(await pendingInAppRows(p.project.id)).toHaveLength(queued);
  expect(await activityRows(p.project.id, 'cohort.in_app_triggered')).toHaveLength(1);
});

// ---------------------------------------------------------------- lifecycle

test('INTEG-135 deleting a project removes its integrations', async () => {
  const p = await sdkProject(await ownerWithProject());
  await connectMixpanel(p.owner, p.project.id);
  const device = await identifyDevice(p);
  await seedCohortWith(p.project.id, { name: 'Goes with it', members: [{ deviceIdentityId: device.id }, { deviceIdentityId: null }] });
  await createWebhook(p.owner, p.project.id);
  await createWebhook(p.owner, p.project.id, { events: ['conversion'] });
  const counts = async () => ({
    configs: (await mixpanelConfigRows(p.project.id)).length,
    cohorts: (await sql(`SELECT id FROM mixpanel_cohorts WHERE "projectId" = $1`, [p.project.id])).length,
    members: (await sql(`SELECT id FROM mixpanel_cohort_members WHERE "projectId" = $1`, [p.project.id])).length,
    webhooks: (await webhookRows(p.project.id)).length,
    apiKeys: (await apiKeyRows(p.project.id)).length,
  });
  expect(await counts()).toEqual({ configs: 1, cohorts: 1, members: 2, webhooks: 2, apiKeys: 1 });

  const deleted = await as(p.owner, 'DELETE', `/api/projects/${p.project.id}`);
  expect(deleted.status).toBe(200);
  expect(deleted.body.data).toEqual({ message: 'Project deleted successfully' });
  expect(await counts()).toEqual({ configs: 0, cohorts: 0, members: 0, webhooks: 0, apiKeys: 0 });
});

// ---------------------------------------------------------------- API keys (additions)

function keyCard(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
}

async function openApiKeys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/api-keys`);
  await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
}

test("INTEG-136 an admin sees and revokes an owner's privacy key", async ({ page }) => {
  const p = await ownerWithProject();
  const privacy = await api<{ fullKey: string; apiKey: { id: string } }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Erase bot', permissions: ['privacy'] },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  await api('POST', `/api/projects/${p.project.id}/api-keys`, { name: 'Prod' }, { token: p.owner.accessToken, ip: p.owner.ip });
  const admin = await teammate(p, 'admin', 'Ada Admin');
  // Positive control: the key works on the privacy API before the revoke.
  const before = await raw('POST', '/api/privacy/exports', { apiKey: privacy.fullKey, ip: p.owner.ip, body: { externalUserId: `nobody-${randomUUID()}` } });
  expect(before.status).not.toBe(401);

  await signIn(page, admin);
  await openApiKeys(page, p.project.id);
  const erase = keyCard(page, 'Erase bot');
  await expect(keyCard(page, 'Prod').getByText('Active', { exact: true })).toBeVisible();
  await expect(erase.getByText('Server only: privacy', { exact: true })).toBeVisible();
  await expect(erase.getByText('Active', { exact: true })).toBeVisible();
  await expect(erase.getByRole('button')).toHaveCount(1);

  const revoked = page.waitForResponse((r) => isApi(r, 'DELETE', `/api-keys/${privacy.apiKey.id}`));
  await erase.getByRole('button').click();
  const response = await revoked;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ data: { message: 'API key revoked successfully' } });
  await expect(toast(page, 'API key revoked')).toBeVisible();
  await expect(erase.getByText('Revoked', { exact: true })).toBeVisible();

  const rows = await apiKeyRows(p.project.id);
  expect(rows.find((k) => k.id === privacy.apiKey.id)!.is_active).toBe(false);
  expect(rows.find((k) => k.name === 'Prod')!.is_active).toBe(true);
  const entries = await activityRows(p.project.id, 'api_key.revoked');
  expect(entries).toHaveLength(1);
  expect(entries[0].actor_user_id).toBe(admin.userId);
  expect(entries[0].target_label).toBe('Erase bot');

  const listed = await as(admin, 'GET', `/api/projects/${p.project.id}/api-keys`);
  expect(listed.status).toBe(200);
  const listedKey = (listed.body.data as Array<Record<string, unknown>>).find((k) => k.id === privacy.apiKey.id)!;
  expect(listedKey.permissions).toEqual(['privacy']);
  expect(listedKey.isActive).toBe(false);
  expect(listedKey).not.toHaveProperty('keyHash');
  expect(listed.text).not.toContain(privacy.fullKey);

  const after = await raw('POST', '/api/privacy/exports', { apiKey: privacy.fullKey, ip: p.owner.ip, body: { externalUserId: `nobody-${randomUUID()}` } });
  expect(after.status).toBe(401);

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${admin.name} revoked the API key "Erase bot"`, { exact: true })).toBeVisible();
});

test('INTEG-138 view-as sees the privacy option but cannot make a privacy key', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  await openApiKeys(page, p.project.id);
  const since = new Date();
  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create API Key' });
  await expect(dialog.getByText('Server-only privacy key', { exact: true })).toBeVisible();
  const warning = dialog.getByText('This key can delete or export any person in this project.', { exact: false });
  await expect(warning).toHaveCount(0);
  await dialog.getByRole('checkbox').check();
  await expect(warning).toBeVisible();
  await dialog.getByPlaceholder('e.g., Production API Key').fill('va-priv');

  await refusedAsReadOnly(page, `/projects/${p.project.id}/api-keys`, 'POST', () => dialog.getByRole('button', { name: 'Create', exact: true }).click());
  // The create fails only once the request has settled; a re-authentication would hold it
  // open, so with this toast shown no dialog for it can still be coming.
  await expect(toast(page, 'Failed to create key')).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Confirm it is you/ })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: 'Create API Key' })).toBeVisible();
  await expect(dialog.getByPlaceholder('e.g., Production API Key')).toHaveValue('va-priv');
  await expect(dialog.getByRole('checkbox')).toBeChecked();

  expect(await apiKeyRows(p.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'api_key.created')).toHaveLength(0);
  const notices = (await mailsTo(p.owner.email, { since })).filter((m) => m.text.includes('server-only privacy key'));
  expect(notices).toHaveLength(0);
});

// ---------------------------------------------------------------- webhooks (additions)

const HOOK_FIELD = 'https://example.com/webhook';

test('INTEG-144 closing the secret dialog any way loses the secret', async ({ page }) => {
  const p = await ownerWithProject();
  const other = await createWebhook(p.owner, p.project.id);
  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/webhooks`);
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true })).toBeVisible();

  // 1. Escape on "Webhook created".
  const url = literalHookUrl('escape');
  await page.getByRole('button', { name: 'Add Webhook' }).click();
  const add = page.getByRole('dialog', { name: 'Add Webhook' });
  await add.getByPlaceholder(HOOK_FIELD).fill(url);
  await add.getByText('click', { exact: true }).click();
  const created = page.waitForResponse((r) => isApi(r, 'POST', '/webhooks'));
  await add.getByRole('button', { name: 'Create', exact: true }).click();
  const createdSecret = ((await (await created).json()) as { data: { secret: string } }).data.secret;
  const reveal = page.getByRole('dialog', { name: 'Webhook created' });
  await expect(reveal.locator('code')).toHaveText(createdSecret);
  await page.keyboard.press('Escape');
  await expect(reveal).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(webhookCard(page, url).getByText(`Signing secret ending ${createdSecret.slice(-4)}`)).toBeVisible();
  expect(await page.content()).not.toContain(createdSecret);

  // 2. A click outside "New signing secret".
  await webhookCard(page, other.url).getByRole('button', { name: 'Rotate secret' }).click();
  const rotated = page.waitForResponse((r) => isApi(r, 'POST', `/webhooks/${other.id}/rotate-secret`));
  await page.getByRole('dialog', { name: 'Rotate signing secret?' }).getByRole('button', { name: 'Rotate', exact: true }).click();
  const rotatedSecret = ((await (await rotated).json()) as { data: { secret: string } }).data.secret;
  const fresh = page.getByRole('dialog', { name: 'New signing secret' });
  await expect(fresh.locator('code')).toHaveText(rotatedSecret);
  await page.mouse.click(5, 5);
  await expect(fresh).toBeHidden();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(webhookCard(page, other.url).getByText(`Signing secret ending ${rotatedSecret.slice(-4)}`)).toBeVisible();
  expect(dialogs).toEqual([]);

  // 3. Nowhere on the page, after a reload, or in any read.
  for (const secret of [createdSecret, rotatedSecret]) expect(await page.content()).not.toContain(secret);
  await page.reload();
  await expect(webhookCard(page, url)).toBeVisible();
  for (const secret of [createdSecret, rotatedSecret]) expect(await page.content()).not.toContain(secret);
  const list = await as(p.owner, 'GET', `/api/projects/${p.project.id}/webhooks`);
  const one = await as(p.owner, 'GET', `/api/projects/${p.project.id}/webhooks/${other.id}`);
  for (const secret of [createdSecret, rotatedSecret]) {
    expect(list.text).not.toContain(secret);
    expect(one.text).not.toContain(secret);
  }
});

test('INTEG-147 PATCH webhook: request validation', async () => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id, { url: literalHookUrl('patch'), events: ['click'] });
  const [before] = await webhookRows(p.project.id);
  const path = `/api/projects/${p.project.id}/webhooks/${webhook.id}`;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ url: 'not a url' }, 'url must be a URL address'],
    [{ url: `https://1.1.1.1/${'a'.repeat(2049 - 16)}` }, 'url must be shorter than or equal to 2048 characters'],
    [{ events: 'click' }, 'events must be an array'],
    [{ events: [1] }, 'each value in events must be a string'],
    [{ foo: 1 }, 'property foo should not exist'],
  ];
  for (const [body, expected] of cases) {
    const response = await as(p.owner, 'PATCH', path, body);
    expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect((response.body as { message: string[] }).message, JSON.stringify(body).slice(0, 60)).toContain(expected);
  }
  const unknown = await as(p.owner, 'PATCH', `/api/projects/${p.project.id}/webhooks/${randomUUID()}`, { isActive: false });
  expect([unknown.status, messageOf(unknown)]).toEqual([404, 'Webhook not found']);
  const malformed = await as(p.owner, 'PATCH', `/api/projects/${p.project.id}/webhooks/abc`, { isActive: false });
  expect([malformed.status, messageOf(malformed)]).toEqual([400, 'Validation failed (uuid is expected)']);

  expect(await webhookRows(p.project.id)).toEqual([before]);
  expect(await activityRows(p.project.id, 'webhook.changed')).toHaveLength(0);

  // Positive control: a valid patch does change it and log it.
  const ok = await as(p.owner, 'PATCH', path, { isActive: false });
  expect(ok.status).toBe(200);
  expect(await activityRows(p.project.id, 'webhook.changed')).toHaveLength(1);
});

test('INTEG-147 PATCH webhook: a string isActive is refused', async () => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id, { url: literalHookUrl('patch-off'), events: ['click'], isActive: false });
  const [before] = await webhookRows(p.project.id);
  expect(before.is_active).toBe(false);
  // Only what follows is expected to fail; the inactive starting row above must hold.
  test.fail(true, 'INTEG-147');
  test.info().annotations.push({ type: 'issue', description: 'INTEG-147' });
  const response = await as(p.owner, 'PATCH', `/api/projects/${p.project.id}/webhooks/${webhook.id}`, { isActive: 'no' });
  expect(await webhookRows(p.project.id)).toEqual([before]);
  expect(response.status).toBe(400);
  expect((response.body as { message: string[] }).message).toContain('isActive must be a boolean value');
  expect(await activityRows(p.project.id, 'webhook.changed')).toHaveLength(0);
});

// ---------------------------------------------------------------- conversions (additions)

test('INTEG-151 conversions: do-not-track people and no external id', async () => {
  const p = await sdkProject(await ownerWithProject());
  const link = await seedShortLink(p.owner, p.project.id, 'dnt-conv');
  await createWebhook(p.owner, p.project.id, { events: ['conversion'] });
  const suffix = randomUUID().slice(0, 8);
  const objected = `dnt-1-${suffix}`;
  const deviceFlagged = `dnt-2-${suffix}`;
  await identifyPerson(p, objected);
  const objection = await as(p.owner, 'POST', `/api/identity/projects/${p.project.id}/tracking-objections`, { externalUserId: objected });
  expect(objection.status).toBe(201);
  await identifyPerson(p, deviceFlagged, { doNotTrack: true });
  const convert = (body: Record<string, unknown>) =>
    raw('POST', '/api/conversions', { apiKey: p.sdkKey, ip: p.owner.ip, body: { linkId: link.id, eventType: 'purchase', ...body } });
  const rows = () => sql(`SELECT * FROM conversion_events WHERE link_id = $1 ORDER BY converted_at`, [link.id]);

  // 1. A person with a dashboard objection: nothing recorded.
  const first = await convert({ externalUserId: objected });
  expect(first.status).toBe(201);
  expect(first.body).toEqual({ data: { recorded: false } });
  expect(await rows()).toHaveLength(0);

  // 2. A device flagged by the SDK covers only its own row, not the external id.
  const second = await convert({ externalUserId: deviceFlagged });
  expect(second.status).toBe(201);
  expect(second.body.data.id).toBeTruthy();
  // 3. No external id at all.
  const third = await convert({});
  expect(third.status).toBe(201);
  expect(third.body.data.id).toBeTruthy();

  const stored = await rows();
  expect(stored.map((r) => [r.event_type, r.external_user_id])).toEqual([
    ['purchase', deviceFlagged],
    ['purchase', null],
  ]);
  expect(stored.some((r) => r.external_user_id === objected)).toBe(false);
});

// ---------------------------------------------------------------- Mixpanel (additions)

test('INTEG-157 the cohort list when Mixpanel refuses the credentials', async ({ page }) => {
  const p = await ownerWithProject();
  const mixpanelProjectId = ownMixpanelProjectId();
  await configureMixpanel(p.owner, p.project.id, mixpanelProjectId);
  await refuseMixpanelCredentials(mixpanelProjectId);
  const answers: number[] = [];
  page.on('response', (r) => {
    if (isApi(r, 'GET', `/projects/${p.project.id}/mixpanel/available-cohorts`)) answers.push(r.status());
  });
  await signIn(page, p.owner);
  await openCohorts(page, p.project.id);
  await expect.poll(() => answers.length).toBeGreaterThan(0);
  await expect(page.getByRole('combobox')).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('combobox').click();
  await expect(page.getByRole('option')).toHaveText(['No new cohorts available']);
  await page.keyboard.press('Escape');
  // Today's behaviour as the case is written: nothing on the page says what went wrong.
  await expect(page.locator('li[data-swipe-direction]')).toHaveCount(0);
  await expect(page.getByText(/credential|refused|unauthori[sz]ed/i)).toHaveCount(0);
  expect(answers.every((status) => status === 500)).toBe(true);

  const response = await as(p.owner, 'GET', `/api/projects/${p.project.id}/mixpanel/available-cohorts`);
  expect([response.status, messageOf(response)]).toEqual([500, 'Internal server error']);
  const calls = (await stubCalls('mixpanel')).filter((c) => c.path === `/api/2.0/cohorts/list?project_id=${mixpanelProjectId}`);
  expect(calls.length).toBeGreaterThan(0);
});

