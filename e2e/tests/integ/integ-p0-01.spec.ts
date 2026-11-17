import { randomInt, randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { api, createApiKey, newClientIp } from '../../support/api';
import { seedFcmConfig } from '../../support/channels';
import { confirmWithPassword } from '../../support/factors';
import { expect, newPersonContext, signIn, test } from '../../support/fixtures';
import { answerStub, stubCalls } from '../../support/provider-stub';
import { campaignRecipients } from '../../support/seed';
import {
  HIDDEN,
  HIDDEN_FROM_ROLE,
  MIXPANEL_ACCOUNT,
  NO_ELIGIBLE_TOKENS,
  PROJECT_NOT_FOUND,
  PUBLIC_ADDRESS,
  READ_ONLY,
  REAUTH_REQUIRED,
  ROLE_REFUSAL,
  WEBHOOK_CAP,
  activityRows,
  addMember,
  ageSignIn,
  allActivity,
  apiKeyRows,
  as,
  atFrequencyCap,
  campaignRows,
  cohortSnapshot,
  configureMixpanel,
  connectMixpanel,
  createInAppMessage,
  createWebhook,
  identifyDevice,
  identityKeyVersion,
  literalHookUrl,
  messageOf,
  newPerson,
  openViewAs,
  ownerWithProject,
  pendingInAppRows,
  raw,
  registerToken,
  sdkProject,
  seedCohort,
  sha256Hex,
  shortDate,
  slowDown,
  sql,
  teammate,
  toast,
  userHash,
  viewAsHandoff,
  viewAsToken,
  webhookCard,
  webhookRows,
} from '../../support/areas/integ';

/**
 * Integrations: project API keys (ordinary and server-only privacy keys), the identity
 * secret, outbound webhooks (create, signing secret, rotate, the active cap, refused
 * URLs, roles and view-as) and the Mixpanel integration (connect, cohorts, stats, push
 * and in-app sends to a cohort, roles and other projects' cohorts).
 */

test.describe.configure({ mode: 'parallel' });

const DOTS = '•'.repeat(32);

function keyCard(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
}

function identityCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ hasText: 'Identity verification' });
}

async function openApiKeys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/api-keys`);
  await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
}

async function openWebhooks(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/webhooks`);
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true })).toBeVisible();
}

/** Ages the sign-in and reloads, so the dashboard's next token carries the old sign-in time. */
async function makeSignInStale(page: Page, person: { userId: string }, heading: string): Promise<void> {
  await ageSignIn(person);
  await page.reload();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

function reauthDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Confirm it is you' });
}

/**
 * A view-as write refused as read-only, with its own toast: earlier read-only toasts are
 * waited out first (they go after 4 s), so the one seen afterwards is this write's.
 */
async function refusedAsReadOnly(page: Page, urlPart: string, method: string, action: () => Promise<void>): Promise<void> {
  const readOnly = toast(page, 'Read-only session').filter({ hasText: READ_ONLY });
  await expect(readOnly).toHaveCount(0, { timeout: 10_000 });
  const refused = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(urlPart) && r.request().method() === method);
  await action();
  const response = await refused;
  expect(response.status(), `${method} ${urlPart}`).toBe(403);
  expect((await response.json()).message, `${method} ${urlPart}`).toBe(READ_ONLY);
  await expect(readOnly).toHaveCount(1);
}

// ---------------------------------------------------------------- API keys

test('INTEG-004 create an ordinary API key', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await expect(page.getByText('No API keys yet. Create one to get started.')).toBeVisible();

  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create API Key' })).toBeVisible();
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Mobile app');
  await slowDown(page, `/projects/${p.project.id}/api-keys`, 'POST');
  const responsePromise = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/api-keys`) && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Creating...' })).toBeVisible();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: { apiKey: Record<string, unknown>; fullKey: string } };

  await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
  await expect(dialog.getByText("Copy this key now. You won't be able to see it again.")).toBeVisible();
  const shownKey = (await dialog.locator('code').textContent()) ?? '';
  expect(shownKey).toMatch(/^chumbaq_[0-9a-f]{64}$/);
  expect(shownKey).toBe(data.fullKey);
  await expect(toast(page, 'API key created')).toBeVisible();

  expect(data.apiKey).toMatchObject({
    name: 'Mobile app',
    prefix: data.fullKey.slice(0, 12),
    permissions: ['read', 'write'],
    isActive: true,
    expiresAt: null,
  });
  expect(data.apiKey).not.toHaveProperty('keyHash');

  await dialog.getByRole('button', { name: 'Done' }).click();
  const card = keyCard(page, 'Mobile app');
  await expect(card).toBeVisible();
  await expect(card.getByText(`${data.fullKey.slice(0, 12)}...`, { exact: true })).toBeVisible();
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await expect(card.getByText(shortDate(new Date()), { exact: true })).toBeVisible();

  const [row] = await apiKeyRows(p.project.id);
  expect(row.key_hash).toBe(sha256Hex(data.fullKey));
  expect(row.permissions).toBe('read,write');

  const [entry] = await activityRows(p.project.id, 'api_key.created');
  expect(entry.actor_user_id).toBe(p.owner.userId);
  expect(entry.target_label).toBe('Mobile app');
  expect(entry.details).toEqual({ name: 'Mobile app', permissions: ['read', 'write'] });
});

test('INTEG-005 the full key is shown only once', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Mobile app');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const fullKey = (await dialog.locator('code').textContent()) ?? '';
  expect(fullKey).toMatch(/^chumbaq_[0-9a-f]{64}$/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(keyCard(page, 'Mobile app')).toBeVisible();
  expect(await page.content()).not.toContain(fullKey);

  await page.getByRole('button', { name: 'Create Key' }).click();
  await expect(dialog.getByRole('heading', { name: 'Create API Key' })).toBeVisible();
  await expect(dialog.getByPlaceholder('e.g., Production API Key')).toHaveValue('');
  expect(await page.content()).not.toContain(fullKey);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.reload();
  await expect(keyCard(page, 'Mobile app')).toBeVisible();
  expect(await page.content()).not.toContain(fullKey);

  const list = await as(p.owner, 'GET', `/api/projects/${p.project.id}/api-keys`);
  expect(list.status).toBe(200);
  expect(list.text).not.toContain(fullKey);
  for (const item of list.body.data as Array<Record<string, unknown>>) {
    expect(item).toHaveProperty('prefix');
    expect(item).not.toHaveProperty('fullKey');
    expect(item).not.toHaveProperty('keyHash');
    expect(item).not.toHaveProperty('key_hash');
  }
});

test('INTEG-009 a new key works on an SDK route at once and records its use', async () => {
  const p = await ownerWithProject();
  const key = await createApiKey(p.owner, p.project.id, p.owner.ip);
  const [before] = await apiKeyRows(p.project.id);
  expect(before.last_used_at).toBeNull();

  const tracked = await raw('POST', '/api/events/track', {
    apiKey: key,
    ip: p.owner.ip,
    body: { projectId: p.project.id, eventName: 'integ_key_check', deviceFingerprint: `integ-fp-${randomUUID()}` },
  });
  expect(tracked.status).toBeGreaterThanOrEqual(200);
  expect(tracked.status).toBeLessThan(300);

  const [after] = await apiKeyRows(p.project.id);
  expect(after.last_used_at).not.toBeNull();
  expect(Math.abs(new Date(after.last_used_at).getTime() - Date.now())).toBeLessThan(5 * 60_000);
});

test('INTEG-010 revoke a key', async ({ page }) => {
  const p = await ownerWithProject();
  const key = await api<{ fullKey: string; apiKey: { id: string } }>(
    'POST',
    `/api/projects/${p.project.id}/api-keys`,
    { name: 'Old' },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  const card = keyCard(page, 'Old');
  await expect(card.getByText('Active', { exact: true })).toBeVisible();

  let confirms = 0;
  page.on('dialog', async (d) => {
    confirms += 1;
    await d.accept();
  });
  const responsePromise = page.waitForResponse((r) => r.url().endsWith(`/api-keys/${key.apiKey.id}`) && r.request().method() === 'DELETE');
  await card.getByRole('button').click();
  const response = await responsePromise;
  expect(await response.json()).toEqual({ data: { message: 'API key revoked successfully' } });
  await expect(toast(page, 'API key revoked')).toBeVisible();
  await expect(card.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  expect(confirms).toBe(0);

  const [row] = await apiKeyRows(p.project.id);
  expect(row.is_active).toBe(false);
  const entries = await activityRows(p.project.id, 'api_key.revoked');
  expect(entries).toHaveLength(1);
  expect(entries[0].target_label).toBe('Old');
  expect(entries[0].details).toBeNull();

  const refused = await raw('POST', '/api/events/track', {
    apiKey: key.fullKey,
    ip: p.owner.ip,
    body: { projectId: p.project.id, eventName: 'after_revoke', deviceFingerprint: `integ-fp-${randomUUID()}` },
  });
  expect(refused.status).toBe(401);
  expect(messageOf(refused)).toBe('Invalid or expired API key');
});

test('INTEG-014 create a server-only privacy key', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Backend privacy');
  await expect(dialog.getByText('Server-only privacy key', { exact: true })).toBeVisible();
  await expect(dialog.getByText("For your backend to erase or export a person's data (/api/privacy).")).toBeVisible();
  const warning =
    'This key can delete or export any person in this project. Keep it on your servers only and never put it in an app, website or SDK, where anyone could extract it. Apps and SDKs refuse it, and it cannot be used for anything else: use an ordinary key for those.';
  await expect(dialog.getByText(warning)).toHaveCount(0);
  await dialog.getByRole('checkbox').check();
  await expect(dialog.getByText(warning)).toBeVisible();

  const requestPromise = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${p.project.id}/api-keys`) && r.method() === 'POST');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({ name: 'Backend privacy', permissions: ['privacy'] });
  await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
  await expect(dialog.locator('code')).toHaveText(/^chumbaq_[0-9a-f]{64}$/);
  await dialog.getByRole('button', { name: 'Done' }).click();

  const card = keyCard(page, 'Backend privacy');
  await expect(card.getByText('Server only: privacy', { exact: true })).toBeVisible();
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  const [row] = await apiKeyRows(p.project.id);
  expect(row.permissions).toBe('privacy');
  const [entry] = await activityRows(p.project.id, 'api_key.created');
  expect(entry.details).toEqual({ name: 'Backend privacy', permissions: ['privacy'] });
});

test('INTEG-016 a privacy key needs a recent sign-in', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await makeSignInStale(page, p.owner, 'API Keys');
  const dialog = page.getByRole('dialog').filter({ hasNotText: 'Confirm it is you' });

  // An ordinary key from the same stale session needs no re-authentication.
  await page.getByRole('button', { name: 'Create Key' }).click();
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Plain stale');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
  await expect(reauthDialog(page)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done' }).click();

  const statuses: number[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith(`/api/projects/${p.project.id}/api-keys`) && r.request().method() === 'POST') statuses.push(r.status());
  });
  await page.getByRole('button', { name: 'Create Key' }).click();
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Late key');
  await dialog.getByRole('checkbox').check();
  const refusal = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/api-keys`) && r.status() === 403);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await (await refusal).json()).message).toBe(REAUTH_REQUIRED);
  await expect(reauthDialog(page)).toBeVisible();
  await confirmWithPassword(page, p.owner.password);
  await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
  expect(statuses).toEqual([403, 201]);
  await dialog.getByRole('button', { name: 'Done' }).click();
  const late = (await apiKeyRows(p.project.id)).filter((k) => k.name === 'Late key');
  expect(late).toHaveLength(1);
  expect(late[0].permissions).toBe('privacy');

  // Stale again, and the re-authentication is cancelled: no key.
  await makeSignInStale(page, p.owner, 'API Keys');
  await page.getByRole('button', { name: 'Create Key' }).click();
  await dialog.getByPlaceholder('e.g., Production API Key').fill('Cancelled key');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(reauthDialog(page)).toBeVisible();
  await reauthDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(toast(page, 'Failed to create key')).toBeVisible();
  expect((await apiKeyRows(p.project.id)).filter((k) => k.name === 'Cancelled key')).toHaveLength(0);
  expect((await activityRows(p.project.id, 'api_key.created')).filter((e) => e.target_label === 'Cancelled key')).toHaveLength(0);
});

test('INTEG-019 an admin cannot make a privacy key through the API', async () => {
  const p = await ownerWithProject();
  const admin = await teammate(p, 'admin', 'Ada Admin');
  const before = (await apiKeyRows(p.project.id)).length;
  const response = await as(admin, 'POST', `/api/projects/${p.project.id}/api-keys`, { name: 'sneaky', permissions: ['privacy'] });
  expect(response.status).toBe(403);
  expect(messageOf(response)).toBe(ROLE_REFUSAL);
  expect(await apiKeyRows(p.project.id)).toHaveLength(before);
  expect(await activityRows(p.project.id, 'api_key.created')).toHaveLength(0);
});

test('INTEG-021 a member is refused by every key and secret route', async () => {
  const p = await ownerWithProject();
  await createApiKey(p.owner, p.project.id, p.owner.ip);
  const [key] = await apiKeyRows(p.project.id);
  const member = await teammate(p, 'member', 'Mo Member');
  const base = `/api/projects/${p.project.id}`;
  const calls: Array<[string, string, unknown?]> = [
    ['GET', `${base}/api-keys`],
    ['POST', `${base}/api-keys`, { name: 'm' }],
    ['DELETE', `${base}/api-keys/${key.id}`],
    ['GET', `${base}/identity-secret`],
    ['POST', `${base}/identity-secret/rotate`],
  ];
  for (const [method, path, body] of calls) {
    const response = await as(member, method, path, body);
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(messageOf(response), `${method} ${path}`).toBe(ROLE_REFUSAL);
  }
  const keys = await apiKeyRows(p.project.id);
  expect(keys).toHaveLength(1);
  expect(keys[0].is_active).toBe(true);
  expect(await identityKeyVersion(p.project.id)).toBe(1);
});

test('INTEG-022 outsiders, unknown and malformed project ids get 404 on every INTEG route', async () => {
  const p = await ownerWithProject();
  const outsider = await newPerson('integ-outsider', 'Nia Nobody');
  await createApiKey(p.owner, p.project.id, p.owner.ip);
  const [key] = await apiKeyRows(p.project.id);
  const webhook = await createWebhook(p.owner, p.project.id);
  const cohort = await seedCohort(p.project.id, 'Outsiders');
  const activityBefore = (await allActivity(p.project.id)).length;

  const routes = (base: string): Array<[string, string, unknown?]> => [
    ['GET', `${base}/api-keys`],
    ['POST', `${base}/api-keys`, { name: 'n' }],
    ['DELETE', `${base}/api-keys/${key.id}`],
    ['GET', `${base}/identity-secret`],
    ['POST', `${base}/identity-secret/rotate`],
    ['GET', `${base}/webhooks`],
    ['POST', `${base}/webhooks`, { url: literalHookUrl('n'), events: ['click'] }],
    ['GET', `${base}/webhooks/${webhook.id}`],
    ['PATCH', `${base}/webhooks/${webhook.id}`, { isActive: false }],
    ['DELETE', `${base}/webhooks/${webhook.id}`],
    ['POST', `${base}/webhooks/${webhook.id}/rotate-secret`],
    ['POST', `${base}/mixpanel/configure`, { serviceAccountUsername: 'n@x.test', serviceAccountPassword: 'p', mixpanelProjectId: '1' }],
    ['GET', `${base}/mixpanel/status`],
    ['GET', `${base}/mixpanel/available-cohorts`],
    ['POST', `${base}/mixpanel/cohorts/import`, { mixpanelCohortId: 1 }],
    ['GET', `${base}/mixpanel/cohorts`],
    ['GET', `${base}/mixpanel/cohorts/${cohort.id}`],
    ['POST', `${base}/mixpanel/cohorts/${cohort.id}/sync`],
    ['GET', `${base}/mixpanel/cohorts/${cohort.id}/members`],
    ['GET', `${base}/mixpanel/cohorts/${cohort.id}/push-stats`],
    ['POST', `${base}/mixpanel/cohorts/${cohort.id}/push`, { title: 't' }],
    ['GET', `${base}/mixpanel/cohorts/${cohort.id}/iam-stats`],
    ['POST', `${base}/mixpanel/cohorts/${cohort.id}/iam-trigger`, { messageId: randomUUID() }],
    ['DELETE', `${base}/mixpanel/cohorts/${cohort.id}`],
  ];
  const variants: Array<[string, { accessToken: string }, string]> = [
    ['outsider on P1', outsider, p.project.id],
    ['owner on a random id', p.owner, randomUUID()],
    ['owner on a malformed id', p.owner, 'not-a-uuid'],
    ['owner on the upper-case id', p.owner, p.project.id.toUpperCase()],
  ];
  for (const [label, person, projectId] of variants) {
    // Each variant from its own address, so the per-route throttle never answers instead.
    const ip = newClientIp();
    for (const [method, path, body] of routes(`/api/projects/${projectId}`)) {
      const response = await raw(method, path, { token: person.accessToken, ip, body });
      expect(response.status, `${label}: ${method} ${path}`).toBe(404);
      expect(messageOf(response), `${label}: ${method} ${path}`).toBe(PROJECT_NOT_FOUND);
    }
  }

  const keys = await apiKeyRows(p.project.id);
  expect(keys).toHaveLength(1);
  expect(keys[0].is_active).toBe(true);
  const hooks = await webhookRows(p.project.id);
  expect(hooks).toHaveLength(1);
  expect(hooks[0].is_active).toBe(true);
  expect(hooks[0].secret_hint).toBe(webhook.secretHint);
  expect((await cohortSnapshot(cohort.id)).cohort).toBeDefined();
  expect(await identityKeyVersion(p.project.id)).toBe(1);
  expect(await allActivity(p.project.id)).toHaveLength(activityBefore);
});

test('INTEG-023 view-as can read keys but not change them', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  await api('POST', `/api/projects/${p.project.id}/api-keys`, { name: 'Prod' }, { token: p.owner.accessToken, ip: p.owner.ip });
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  await openApiKeys(page, p.project.id);
  const prod = keyCard(page, 'Prod');
  await expect(prod.getByText('Active', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g., Production API Key').fill('va');
  await refusedAsReadOnly(page, `/projects/${p.project.id}/api-keys`, 'POST', () => dialog.getByRole('button', { name: 'Create', exact: true }).click());
  await expect(toast(page, 'Failed to create key')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const [prodRow] = await apiKeyRows(p.project.id);
  await refusedAsReadOnly(page, `/api-keys/${prodRow.id}`, 'DELETE', () => prod.getByRole('button').click());
  await expect(toast(page, 'Failed to revoke key')).toBeVisible();
  await expect(prod.getByText('Active', { exact: true })).toBeVisible();

  const keys = await apiKeyRows(p.project.id);
  expect(keys.map((k) => [k.name, k.is_active])).toEqual([['Prod', true]]);
  expect(await activityRows(p.project.id, 'api_key.revoked')).toHaveLength(0);
});

test('INTEG-029 the activity log never holds a key, prefix or hash', async () => {
  const p = await ownerWithProject();
  const base = `/api/projects/${p.project.id}`;
  const ordinary = await api<{ fullKey: string; apiKey: { id: string } }>('POST', `${base}/api-keys`, { name: 'Ordinary one' }, { token: p.owner.accessToken, ip: p.owner.ip });
  const privacy = await api<{ fullKey: string; apiKey: { id: string } }>(
    'POST',
    `${base}/api-keys`,
    { name: 'Privacy one', permissions: ['privacy'] },
    { token: p.owner.accessToken, ip: p.owner.ip },
  );
  for (const key of [ordinary, privacy]) {
    expect((await as(p.owner, 'DELETE', `${base}/api-keys/${key.apiKey.id}`)).status).toBe(200);
  }

  const page = await as(p.owner, 'GET', `${base}/activity`);
  expect(page.status).toBe(200);
  const exported = await as(p.owner, 'GET', `${base}/activity/export`);
  expect(exported.status).toBe(200);
  const entries = (page.body.data.entries as Array<{ action: string; targetLabel: string }>).filter((e) => e.action.startsWith('api_key.'));
  expect(entries.map((e) => [e.action, e.targetLabel]).sort()).toEqual(
    [
      ['api_key.created', 'Ordinary one'],
      ['api_key.created', 'Privacy one'],
      ['api_key.revoked', 'Ordinary one'],
      ['api_key.revoked', 'Privacy one'],
    ].sort(),
  );
  expect(exported.text).toContain('Ordinary one');
  for (const key of [ordinary.fullKey, privacy.fullKey]) {
    for (const secret of [key, key.slice(0, 12), sha256Hex(key)]) {
      expect(page.text).not.toContain(secret);
      expect(exported.text).not.toContain(secret);
    }
  }
});

// ---------------------------------------------------------- identity secret

test('INTEG-034 the shown secret is the one identify checks', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  const card = identityCard(page);
  await card.getByRole('button', { name: 'Show' }).click();
  const field = card.getByRole('textbox');
  await expect(field).toHaveValue(/^[0-9a-f]{64}$/);
  const secret = await field.inputValue();

  const identified = await raw('POST', '/api/identity/identify', {
    apiKey: p.sdkKey,
    ip: p.owner.ip,
    body: {
      projectId: p.project.id,
      deviceFingerprint: `integ-fp-${randomUUID()}`,
      platform: 'web',
      externalUserId: 'user-1',
      userHash: userHash(secret, 'user-1'),
    },
  });
  expect(identified.status).toBeGreaterThanOrEqual(200);
  expect(identified.status).toBeLessThan(300);
});

test('INTEG-035 rotate the identity secret', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  const card = identityCard(page);
  await card.getByRole('button', { name: 'Show' }).click();
  const field = card.getByRole('textbox');
  await expect(field).toHaveValue(/^[0-9a-f]{64}$/);
  const s1 = await field.inputValue();

  let confirmText = '';
  page.once('dialog', async (d) => {
    confirmText = d.message();
    await d.accept();
  });
  const rotated = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/identity-secret/rotate`));
  await card.getByRole('button', { name: 'Rotate secret' }).click();
  const response = await rotated;
  expect(confirmText).toBe('Rotate the secret? Every userHash made with the current one stops working at once.');
  expect(response.status()).toBe(200);
  const { data } = (await response.json()) as { data: { secret: string; version: number } };
  expect(data.version).toBe(2);
  expect(data.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(data.secret).not.toBe(s1);
  await expect(toast(page, 'Identity secret rotated')).toBeVisible();
  await expect(field).toHaveValue(data.secret);

  expect(await identityKeyVersion(p.project.id)).toBe(2);
  const entries = await activityRows(p.project.id, 'identity.secret_rotated');
  expect(entries).toHaveLength(1);
  expect(entries[0].actor_user_id).toBe(p.owner.userId);
  expect(entries[0].target_type).toBe('project');
  expect(entries[0].target_id).toBe(p.project.id);
  expect(entries[0].details).toBeNull();

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} rotated the identity verification secret`, { exact: true })).toBeVisible();

  const withOld = await raw('POST', '/api/identity/identify', {
    apiKey: p.sdkKey,
    ip: p.owner.ip,
    body: { projectId: p.project.id, deviceFingerprint: `integ-fp-${randomUUID()}`, platform: 'web', externalUserId: 'user-1', userHash: userHash(s1, 'user-1') },
  });
  expect(withOld.status).toBe(401);
});

test('INTEG-037 rotating the identity secret needs a recent sign-in', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await makeSignInStale(page, p.owner, 'API Keys');
  const card = identityCard(page);

  page.once('dialog', (d) => d.accept());
  const refusal = page.waitForResponse((r) => r.url().endsWith('/identity-secret/rotate') && r.status() === 403);
  await card.getByRole('button', { name: 'Rotate secret' }).click();
  expect((await (await refusal).json()).message).toBe(REAUTH_REQUIRED);
  await expect(reauthDialog(page)).toBeVisible();
  await confirmWithPassword(page, p.owner.password);
  await expect(toast(page, 'Identity secret rotated')).toBeVisible();
  expect(await identityKeyVersion(p.project.id)).toBe(2);

  await makeSignInStale(page, p.owner, 'API Keys');
  page.once('dialog', (d) => d.accept());
  await identityCard(page).getByRole('button', { name: 'Rotate secret' }).click();
  await expect(reauthDialog(page)).toBeVisible();
  await reauthDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(toast(page, 'Could not rotate the secret')).toBeVisible();
  expect(await identityKeyVersion(p.project.id)).toBe(2);
  expect(await activityRows(p.project.id, 'identity.secret_rotated')).toHaveLength(1);
});

test('INTEG-039 view-as never sees the identity secret', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  await openApiKeys(page, p.project.id);
  await expect(toast(page, 'Read-only session').filter({ hasText: READ_ONLY }).first()).toBeVisible();
  const card = identityCard(page);
  const field = card.getByRole('textbox');
  await expect(field).toHaveValue(DOTS);
  await card.getByRole('button', { name: 'Show' }).click();
  await expect(card.getByRole('button', { name: 'Hide' })).toBeVisible();
  await expect(field).toHaveValue(DOTS);
  await expect(card.locator('button:has(svg.lucide-copy)')).toBeDisabled();

  page.once('dialog', (d) => d.accept());
  await refusedAsReadOnly(page, '/identity-secret/rotate', 'POST', () => card.getByRole('button', { name: 'Rotate secret' }).click());
  await expect(toast(page, 'Could not rotate the secret')).toBeVisible();
  expect(await identityKeyVersion(p.project.id)).toBe(1);

  const token = await viewAsToken(browser, baseURL, p.owner);
  for (const [method, path] of [
    ['GET', `/api/projects/${p.project.id}/identity-secret`],
    ['POST', `/api/projects/${p.project.id}/identity-secret/rotate`],
  ]) {
    const response = await raw(method, path, { token, ip: newClientIp() });
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(messageOf(response)).toBe(READ_ONLY);
  }
  expect(await identityKeyVersion(p.project.id)).toBe(1);
});

// ------------------------------------------------------------------ webhooks

test('INTEG-043 add a webhook', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  await page.getByRole('button', { name: 'Add Webhook' }).click();
  const add = page.getByRole('dialog', { name: 'Add Webhook' });
  const url = 'https://1.1.1.1/chumbaq-e2e/1';
  await add.getByPlaceholder('https://example.com/webhook').fill(url);
  const badges = add.locator('[data-slot="badge"]');
  await expect(badges).toHaveText(['click', 'conversion', 'install']);
  await add.getByText('click', { exact: true }).click();
  await add.getByText('conversion', { exact: true }).click();
  await expect(add.getByText('click', { exact: true })).toHaveAttribute('data-variant', 'default');
  await expect(add.getByText('conversion', { exact: true })).toHaveAttribute('data-variant', 'default');
  await expect(add.getByText('install', { exact: true })).toHaveAttribute('data-variant', 'outline');

  await slowDown(page, `/projects/${p.project.id}/webhooks`, 'POST');
  const created = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/webhooks`) && r.request().method() === 'POST');
  await add.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(add.getByRole('button', { name: 'Creating...' })).toBeVisible();
  const response = await created;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: Record<string, any> };
  expect(data).toMatchObject({ url, events: ['click', 'conversion'], isActive: true, secretRotatedAt: null });
  expect(data.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(data.secretHint).toBe(data.secret.slice(-4));
  expect(typeof data.id).toBe('string');

  await expect(add).toBeHidden();
  const reveal = page.getByRole('dialog', { name: 'Webhook created' });
  await expect(
    reveal.getByText(
      'Copy this signing secret now. You will not see it again: only its last four characters are shown after you close this. Use it to verify the X-Chumbaq-Signature header on each delivery.',
    ),
  ).toBeVisible();
  await expect(reveal.locator('code')).toHaveText(data.secret);
  await reveal.getByRole('button', { name: 'Done' }).click();

  const card = webhookCard(page, url);
  await expect(card.getByText(url, { exact: true })).toBeVisible();
  await expect(card.locator('[data-slot="badge"]')).toHaveText(['click', 'conversion']);
  await expect(card.getByText(`Signing secret ending ${data.secretHint} · since ${shortDate(new Date())}`)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Rotate secret' })).toBeVisible();
  await expect(card.getByRole('switch')).toBeChecked();
  await expect(card.getByRole('button')).toHaveCount(2);
  await expect(card.getByRole('button').last().locator('svg.lucide-trash2')).toBeVisible();

  const [row] = await webhookRows(p.project.id);
  expect(row.secret.startsWith('v1.')).toBe(true);
  expect(row.secret).not.toContain(data.secret);
  expect(row.secret_hint).toBe(data.secret.slice(-4));

  const [entry] = await activityRows(p.project.id, 'webhook.created');
  expect(entry.target_label).toBe(data.id);
  expect(entry.details).toEqual({ events: ['click', 'conversion'] });
  expect(JSON.stringify(entry)).not.toContain('1.1.1.1');

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} added a webhook for click and conversion events`, { exact: true })).toBeVisible();
});

test('INTEG-044 the signing secret is never readable again', async () => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id, { events: ['click', 'conversion'] });
  const base = `/api/projects/${p.project.id}/webhooks`;
  const reads = [
    await as(p.owner, 'GET', base),
    await as(p.owner, 'GET', `${base}/${webhook.id}`),
    await as(p.owner, 'PATCH', `${base}/${webhook.id}`, { isActive: false }),
  ];
  for (const response of reads) {
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(webhook.secret);
    const views = Array.isArray(response.body.data) ? response.body.data : [response.body.data];
    for (const view of views) {
      expect(view).not.toHaveProperty('secret');
      expect(view).not.toHaveProperty('secretSealed');
      expect(view.secretHint).toBe(webhook.secretHint);
      expect(view).toHaveProperty('secretRotatedAt');
    }
  }
});

test('INTEG-048 a refused URL in the dialog shows the API reason', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  await page.getByRole('button', { name: 'Add Webhook' }).click();
  const add = page.getByRole('dialog', { name: 'Add Webhook' });
  await add.getByText('click', { exact: true }).click();
  const field = add.getByPlaceholder('https://example.com/webhook');

  const cases: Array<[string, string | null]> = [
    ['http://127.0.0.1:8080/hook', PUBLIC_ADDRESS],
    ['https://user:pass@1.1.1.1/hook', 'Webhook URL must not contain credentials'],
    ['not a url', null],
  ];
  for (const [url, reason] of cases) {
    await field.fill(url);
    const refused = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/webhooks`) && r.request().method() === 'POST');
    await add.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await refused).status()).toBe(400);
    const toasts = toast(page, 'Failed to create webhook');
    if (reason) await expect(toasts.filter({ hasText: reason })).toHaveCount(1);
    else await expect(toasts.filter({ hasNotText: 'Webhook URL' })).toHaveText([/^Failed to create webhook\s*$/]);
    await expect(add).toBeVisible();
    await expect(field).toHaveValue(url);
  }
  expect(await webhookRows(p.project.id)).toHaveLength(0);
});

test('INTEG-049 every refused webhook URL', async () => {
  const p = await ownerWithProject();
  const isUrl = 'url must be a URL address';
  const cases: Array<[string, string[]]> = [
    ['http://localhost/x', [isUrl]],
    ['http://foo.localhost/x', [PUBLIC_ADDRESS]],
    ['http://127.0.0.1/x', [PUBLIC_ADDRESS]],
    ['http://10.0.0.5/x', [PUBLIC_ADDRESS]],
    ['http://192.168.1.1/x', [PUBLIC_ADDRESS]],
    ['http://172.16.0.1/x', [PUBLIC_ADDRESS]],
    ['http://169.254.169.254/latest/meta-data', [PUBLIC_ADDRESS]],
    ['http://100.64.0.1/x', [PUBLIC_ADDRESS]],
    ['http://0.0.0.0/x', [PUBLIC_ADDRESS]],
    ['http://192.0.2.1/x', [PUBLIC_ADDRESS]],
    ['http://224.0.0.1/x', [PUBLIC_ADDRESS]],
    ['http://[::1]/x', [isUrl, PUBLIC_ADDRESS]],
    ['http://[::ffff:127.0.0.1]/x', [isUrl, PUBLIC_ADDRESS]],
    ['http://[64:ff9b::a00:1]/x', [isUrl, PUBLIC_ADDRESS]],
    ['http://[2002:a00:1::]/x', [isUrl, PUBLIC_ADDRESS]],
    ['http://2130706433/x', [isUrl]],
    ['https://no-such-host.invalid/x', [PUBLIC_ADDRESS]],
    ['https://localtest.me/x', [PUBLIC_ADDRESS]],
    ['ftp://1.1.1.1/x', ['Webhook URL must use http(s)']],
    ['javascript:alert(1)', [isUrl]],
    ['https://user:pw@1.1.1.1/x', ['Webhook URL must not contain credentials']],
    ['https:///nohost', [isUrl]],
  ];
  for (const [url, accepted] of cases) {
    const response = await as(p.owner, 'POST', `/api/projects/${p.project.id}/webhooks`, { url, events: ['click'] });
    expect(response.status, url).toBe(400);
    const message = messageOf(response);
    expect(accepted.some((m) => message.includes(m)), `${url}: ${message}`).toBe(true);
  }
  expect(await webhookRows(p.project.id)).toHaveLength(0);
});

test('INTEG-052 at most 10 active webhooks: adding the 11th', async ({ page }) => {
  const p = await ownerWithProject();
  for (let i = 0; i < 10; i += 1) await createWebhook(p.owner, p.project.id, { url: literalHookUrl(`cap-${i}`) });
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  await page.getByRole('button', { name: 'Add Webhook' }).click();
  const add = page.getByRole('dialog', { name: 'Add Webhook' });
  await add.getByPlaceholder('https://example.com/webhook').fill(literalHookUrl('eleventh'));
  await add.getByText('click', { exact: true }).click();
  await add.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(toast(page, 'Failed to create webhook')).toContainText(WEBHOOK_CAP);
  expect(await webhookRows(p.project.id)).toHaveLength(10);
  expect(await activityRows(p.project.id, 'webhook.created')).toHaveLength(10);

  const viaApi = await as(p.owner, 'POST', `/api/projects/${p.project.id}/webhooks`, { url: literalHookUrl('api'), events: ['click'] });
  expect(viaApi.status).toBe(400);
  expect(messageOf(viaApi)).toBe(WEBHOOK_CAP);
  expect(await webhookRows(p.project.id)).toHaveLength(10);
});

test('INTEG-053 at most 10 active webhooks: turning one on', async ({ page }) => {
  const p = await ownerWithProject();
  const active: string[] = [];
  for (let i = 0; i < 10; i += 1) active.push((await createWebhook(p.owner, p.project.id, { url: literalHookUrl(`on-${i}`) })).url);
  const off = await createWebhook(p.owner, p.project.id, { url: literalHookUrl('off'), isActive: false });
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);

  const offSwitch = webhookCard(page, off.url).getByRole('switch');
  await expect(offSwitch).not.toBeChecked();
  await offSwitch.click();
  await expect(toast(page, 'Could not turn the webhook on')).toContainText(WEBHOOK_CAP);
  await expect(offSwitch).not.toBeChecked();
  const count = async () => (await webhookRows(p.project.id)).filter((w) => w.is_active).length;
  expect(await count()).toBe(10);

  const firstSwitch = webhookCard(page, active[0]).getByRole('switch');
  await firstSwitch.click();
  await expect(firstSwitch).not.toBeChecked();
  await offSwitch.click();
  await expect(offSwitch).toBeChecked();
  expect(await count()).toBe(10);
  const rows = await webhookRows(p.project.id);
  expect(rows.find((w) => w.id === off.id)?.is_active).toBe(true);
});

test("INTEG-057 rotate a webhook's signing secret", async ({ page }) => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id, { events: ['click', 'conversion'] });
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  const card = webhookCard(page, webhook.url);
  await card.getByRole('button', { name: 'Rotate secret' }).click();
  const confirm = page.getByRole('dialog', { name: 'Rotate signing secret?' });
  await expect(confirm).toContainText(
    `The current secret stops working immediately. Deliveries to ${webhook.url} will fail verification until the receiver is updated with the new one.`,
  );
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await slowDown(page, `/webhooks/${webhook.id}/rotate-secret`, 'POST');
  const rotated = page.waitForResponse((r) => r.url().endsWith(`/webhooks/${webhook.id}/rotate-secret`));
  await confirm.getByRole('button', { name: 'Rotate', exact: true }).click();
  await expect(confirm.getByRole('button', { name: 'Rotating...' })).toBeVisible();
  const response = await rotated;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: { secret: string; secretHint: string } };
  expect(data.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(data.secret).not.toBe(webhook.secret);

  const reveal = page.getByRole('dialog', { name: 'New signing secret' });
  await expect(reveal).toContainText('Copy this signing secret now. You will not see it again');
  await expect(reveal.locator('code')).toHaveText(data.secret);
  await reveal.getByRole('button', { name: 'Done' }).click();
  await expect(card.getByText(`Signing secret ending ${data.secret.slice(-4)} · rotated ${shortDate(new Date())}`)).toBeVisible();

  const [row] = await webhookRows(p.project.id);
  expect(row.secret_hint).toBe(data.secret.slice(-4));
  expect(row.secret_hint).not.toBe(webhook.secretHint);
  expect(row.secret_rotated_at).not.toBeNull();
  expect([row.url, row.events, row.is_active]).toEqual([webhook.url, 'click,conversion', true]);
  const entries = await activityRows(p.project.id, 'webhook.secret_rotated');
  expect(entries).toHaveLength(1);
  expect(entries[0].details).toBeNull();
});

/** An active webhook whose URL is a Slack-style secret, and an inactive one. */
async function slackWebhooks(p: Awaited<ReturnType<typeof ownerWithProject>>) {
  const slackUrl = 'https://hooks.slack.com/services/T0/B0/SECRET';
  const active = await createWebhook(p.owner, p.project.id, { events: ['click'] });
  // Stored directly: the create would resolve the name, and the address is not what the case is about.
  await sql(`UPDATE webhooks SET url = $2 WHERE id = $1`, [active.id, slackUrl]);
  const inactive = await createWebhook(p.owner, p.project.id, { events: ['conversion'], isActive: false });
  return { slackUrl, active: { ...active, url: slackUrl }, inactive };
}

test('INTEG-063 a member sees webhooks without their URLs and cannot change them', async ({ page }) => {
  const p = await ownerWithProject();
  const { slackUrl, active, inactive } = await slackWebhooks(p);
  // The owner reads the stored URL, so its absence below is the member's view, not the seed's.
  expect((await as(p.owner, 'GET', `/api/projects/${p.project.id}/webhooks/${active.id}`)).body.data.url).toBe(slackUrl);
  const member = await teammate(p, 'member', 'Mo Member');
  await signIn(page, member);
  await openWebhooks(page, p.project.id);

  await expect(page.getByRole('button', { name: 'Add Webhook' })).toHaveCount(0);
  const cards = page.locator('[data-slot="card"]');
  await expect(cards).toHaveCount(2);
  const activeCard = webhookCard(page, `ending ${active.secretHint}`);
  const inactiveCard = webhookCard(page, `ending ${inactive.secretHint}`);
  for (const [card, event, state] of [
    [activeCard, 'click', 'On'],
    [inactiveCard, 'conversion', 'Off'],
  ] as const) {
    await expect(card.getByText(HIDDEN_FROM_ROLE, { exact: true })).toBeVisible();
    await expect(card.getByText(event, { exact: true })).toBeVisible();
    await expect(card.getByText(state, { exact: true })).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.getByRole('switch')).toHaveCount(0);
  }
  const content = await page.content();
  expect(content).not.toContain('SECRET');
  expect(content).not.toContain('hooks.slack.com');

  const base = `/api/projects/${p.project.id}/webhooks`;
  const list = await as(member, 'GET', base);
  const one = await as(member, 'GET', `${base}/${active.id}`);
  for (const response of [list, one]) {
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('hooks.slack.com');
    expect(response.text).not.toContain('SECRET');
  }
  expect((list.body.data as Array<{ url: string }>).map((w) => w.url)).toEqual([HIDDEN, HIDDEN]);
  expect(one.body.data.url).toBe(HIDDEN);
  for (const [method, path, body] of [
    ['POST', base, { url: literalHookUrl('m'), events: ['click'] }],
    ['PATCH', `${base}/${active.id}`, { isActive: false }],
    ['POST', `${base}/${active.id}/rotate-secret`, undefined],
    ['DELETE', `${base}/${active.id}`, undefined],
  ] as const) {
    const response = await as(member, method, path, body);
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(messageOf(response)).toBe(ROLE_REFUSAL);
  }
  const rows = await webhookRows(p.project.id);
  expect(rows).toHaveLength(2);
  expect(rows.find((w) => w.id === active.id)).toMatchObject({ is_active: true, secret_hint: active.secretHint });
});

test('INTEG-064 view-as sees webhooks without URLs and cannot change them', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  const { active } = await slackWebhooks(p);
  const before = await webhookRows(p.project.id);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  await openWebhooks(page, p.project.id);

  const card = webhookCard(page, `ending ${active.secretHint}`);
  await expect(card.getByText(HIDDEN, { exact: true })).toBeVisible();
  expect(await page.content()).not.toContain('hooks.slack.com');

  await card.getByRole('button', { name: 'Rotate secret' }).click();
  const confirm = page.getByRole('dialog', { name: 'Rotate signing secret?' });
  await expect(confirm).toContainText(`Deliveries to ${HIDDEN} will fail verification`);
  expect(await confirm.textContent()).not.toContain('hooks.slack.com');
  await refusedAsReadOnly(page, `/webhooks/${active.id}/rotate-secret`, 'POST', () => confirm.getByRole('button', { name: 'Rotate', exact: true }).click());
  await expect(toast(page, 'Failed to rotate the secret')).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();

  await refusedAsReadOnly(page, `/webhooks/${active.id}`, 'PATCH', () => card.getByRole('switch').click());
  await expect(toast(page, 'Could not turn the webhook off')).toContainText(READ_ONLY);

  await refusedAsReadOnly(page, `/webhooks/${active.id}`, 'DELETE', () => card.getByRole('button').last().click());

  await page.getByRole('button', { name: 'Add Webhook' }).click();
  const add = page.getByRole('dialog', { name: 'Add Webhook' });
  await add.getByPlaceholder('https://example.com/webhook').fill(literalHookUrl('va'));
  await add.getByText('click', { exact: true }).click();
  await refusedAsReadOnly(page, `/projects/${p.project.id}/webhooks`, 'POST', () => add.getByRole('button', { name: 'Create', exact: true }).click());
  await expect(toast(page, 'Failed to create webhook')).toContainText(READ_ONLY);

  expect(await webhookRows(p.project.id)).toEqual(before);
});

test("INTEG-065 another project's webhook is not reachable through yours", async () => {
  const o = await ownerWithProject();
  const x = await ownerWithProject('integ-x', 'Xena Other');
  const w2 = await createWebhook(x.owner, x.project.id);
  const base = `/api/projects/${o.project.id}/webhooks/${w2.id}`;
  for (const [method, path, body] of [
    ['GET', base, undefined],
    ['PATCH', base, { isActive: false }],
    ['POST', `${base}/rotate-secret`, undefined],
    ['DELETE', base, undefined],
  ] as const) {
    const response = await as(o.owner, method, path, body);
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(messageOf(response)).toBe('Webhook not found');
  }
  const [row] = await webhookRows(x.project.id);
  expect(row).toMatchObject({ id: w2.id, is_active: true, secret_hint: w2.secretHint });
});

test('INTEG-069 a patch cannot move a webhook or set its secret', async () => {
  const o = await ownerWithProject();
  const x = await ownerWithProject('integ-x', 'Xena Other');
  await addMember(o.project.id, x.owner, 'owner', o.owner);
  const webhook = await createWebhook(o.owner, o.project.id);
  const path = `/api/projects/${o.project.id}/webhooks/${webhook.id}`;
  const before = await webhookRows(o.project.id);

  const cases: Array<[typeof o.owner, Record<string, unknown>, number, string]> = [
    [x.owner, { projectId: x.project.id }, 400, 'property projectId should not exist'],
    [x.owner, { secret: 'mine' }, 400, 'property secret should not exist'],
    [x.owner, { secretSealed: 'v1.a.b.c' }, 400, 'property secretSealed should not exist'],
    [o.owner, { isActive: false, projectId: x.project.id }, 404, PROJECT_NOT_FOUND],
  ];
  for (const [person, body, status, message] of cases) {
    const response = await as(person, 'PATCH', path, body);
    expect(response.status, JSON.stringify(body)).toBe(status);
    expect(messageOf(response)).toContain(message);
  }
  expect(await webhookRows(o.project.id)).toEqual(before);
  expect(await webhookRows(x.project.id)).toHaveLength(0);
});

// ------------------------------------------------------------------ Mixpanel

test('INTEG-084 connect Mixpanel', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/mixpanel`);
  await expect(page.getByRole('heading', { name: 'Mixpanel Integration' })).toBeVisible();
  await expect(page.getByText('Not Configured', { exact: true })).toBeVisible();

  await page.getByPlaceholder('service-account@mixpanel.com').fill(MIXPANEL_ACCOUNT.username);
  await page.getByPlaceholder('Service account secret').fill(MIXPANEL_ACCOUNT.password);
  await page.getByPlaceholder('123456').fill(MIXPANEL_ACCOUNT.projectId);
  await slowDown(page, `/projects/${p.project.id}/mixpanel/configure`, 'POST');
  const saved = page.waitForResponse((r) => r.url().endsWith('/mixpanel/configure'));
  await page.getByRole('button', { name: 'Save Configuration' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeVisible();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: Record<string, unknown> };
  expect(Object.keys(data).sort()).toEqual(['id', 'isActive', 'projectId']);
  expect(data).toMatchObject({ projectId: p.project.id, isActive: true });

  await expect(toast(page, 'Mixpanel configured successfully')).toBeVisible();
  const status = page.locator('[data-slot="card"]').filter({ hasText: 'Current Status' });
  await expect(status.getByText('Configured', { exact: true })).toBeVisible();
  await expect(status.getByText('Active', { exact: true })).toBeVisible();
  await expect(status.getByText('Project ID:', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText('123456');
  await expect(status.getByText('Service Account:', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText(MIXPANEL_ACCOUNT.username);
  await expect(page.getByPlaceholder('service-account@mixpanel.com')).toHaveValue(MIXPANEL_ACCOUNT.username);
  await expect(page.getByPlaceholder('Service account secret')).toHaveValue(MIXPANEL_ACCOUNT.password);
  await expect(page.getByPlaceholder('123456')).toHaveValue('123456');

  const [config] = await sql(`SELECT * FROM mixpanel_configs WHERE "projectId" = $1`, [p.project.id]);
  expect(config.serviceAccountPasswordEncrypted).not.toContain(MIXPANEL_ACCOUNT.password);
  expect(JSON.stringify(config)).not.toContain(MIXPANEL_ACCOUNT.password);
  const entries = await activityRows(p.project.id, 'mixpanel.configured');
  expect(entries).toHaveLength(1);
  expect(entries[0].target_label).toBe('Mixpanel');
  expect(entries[0].details).toBeNull();
  expect(JSON.stringify(entries[0])).not.toContain(MIXPANEL_ACCOUNT.password);
  expect(JSON.stringify(entries[0])).not.toContain(MIXPANEL_ACCOUNT.username);

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} changed the Mixpanel connection`, { exact: true })).toBeVisible();
});

test('INTEG-091 a member sees the Mixpanel status but not the account', async ({ page }) => {
  const p = await ownerWithProject();
  await connectMixpanel(p.owner, p.project.id);
  const member = await teammate(p, 'member', 'Mo Member');
  await signIn(page, member);
  await page.goto(`/projects/${p.project.id}/mixpanel`);
  const status = page.locator('[data-slot="card"]').filter({ hasText: 'Current Status' });
  await expect(status.getByText('Configured', { exact: true })).toBeVisible();
  await expect(status.getByText('Active', { exact: true })).toBeVisible();
  await expect(status.getByText('Project ID:', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText('123456');
  await expect(status.getByText('Service Account:', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText(HIDDEN_FROM_ROLE);
  await expect(page.getByText('Only owners and admins can connect Mixpanel.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Configuration' })).toHaveCount(0);
  await expect(page.getByPlaceholder('service-account@mixpanel.com')).toHaveCount(0);
  expect(await page.content()).not.toContain(MIXPANEL_ACCOUNT.username);

  const statusApi = await as(member, 'GET', `/api/projects/${p.project.id}/mixpanel/status`);
  expect(statusApi.status).toBe(200);
  expect(statusApi.body.data.serviceAccountUsername).toBe(HIDDEN);
  expect(statusApi.text).not.toContain(MIXPANEL_ACCOUNT.username);
  expect(statusApi.text.toLowerCase()).not.toContain('password');
  const configure = await as(member, 'POST', `/api/projects/${p.project.id}/mixpanel/configure`, {
    serviceAccountUsername: 'member@mixpanel.com',
    serviceAccountPassword: 'member-pass',
    mixpanelProjectId: '999',
  });
  expect(configure.status).toBe(403);
  expect(messageOf(configure)).toBe(ROLE_REFUSAL);
  const [config] = await sql(`SELECT "serviceAccountUsername" FROM mixpanel_configs WHERE "projectId" = $1`, [p.project.id]);
  expect(config.serviceAccountUsername).toBe(MIXPANEL_ACCOUNT.username);
});

test('INTEG-092 view-as sees the Mixpanel status but cannot change it', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  await connectMixpanel(p.owner, p.project.id);
  const [before] = await sql(`SELECT * FROM mixpanel_configs WHERE "projectId" = $1`, [p.project.id]);
  const entriesBefore = (await activityRows(p.project.id, 'mixpanel.configured')).length;
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  await page.goto(`/projects/${p.project.id}/mixpanel`);
  const status = page.locator('[data-slot="card"]').filter({ hasText: 'Current Status' });
  await expect(status.getByText('Service Account:', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText(HIDDEN);

  await page.getByPlaceholder('service-account@mixpanel.com').fill('staff@mixpanel.com');
  await page.getByPlaceholder('Service account secret').fill('staff-pass');
  await page.getByPlaceholder('123456').fill('777');
  await refusedAsReadOnly(page, '/mixpanel/configure', 'POST', () => page.getByRole('button', { name: 'Save Configuration' }).click());
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to configure Mixpanel' })).toBeVisible();
  const [after] = await sql(`SELECT * FROM mixpanel_configs WHERE "projectId" = $1`, [p.project.id]);
  expect(after).toEqual(before);
  expect(await activityRows(p.project.id, 'mixpanel.configured')).toHaveLength(entriesBefore);
});

test('INTEG-106 view-as cannot import, sync or delete cohorts', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  await connectMixpanel(p.owner, p.project.id);
  const cohort = await seedCohort(p.project.id, 'Loyal buyers');
  const before = await cohortSnapshot(cohort.id);
  const handoff = await viewAsHandoff(browser, baseURL, p.owner);
  await openViewAs(page, handoff);
  await page.route(
    (url) => url.pathname.endsWith(`/api/projects/${p.project.id}/mixpanel/available-cohorts`),
    (route) => route.fulfill({ json: { data: [{ id: 4242, name: 'Fresh signups', count: 12, description: null }] } }),
  );
  await page.goto(`/projects/${p.project.id}/mixpanel/cohorts`);
  const row = page.getByRole('row').filter({ hasText: 'Loyal buyers' });
  await expect(row).toBeVisible();

  await refusedAsReadOnly(page, `/mixpanel/cohorts/${cohort.id}/sync`, 'POST', () => row.getByRole('button').nth(0).click());
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to sync cohort' })).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await refusedAsReadOnly(page, `/mixpanel/cohorts/${cohort.id}`, 'DELETE', () => row.getByRole('button').nth(2).click());
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to delete cohort' })).toBeVisible();

  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Fresh signups (12 users)' }).click();
  await refusedAsReadOnly(page, '/mixpanel/cohorts/import', 'POST', () => page.getByRole('button', { name: 'Import', exact: true }).click());
  await expect(toast(page, 'Error').filter({ hasText: 'Failed to import cohort' })).toBeVisible();
  await expect(row).toBeVisible();

  expect(await cohortSnapshot(cohort.id)).toEqual(before);
  expect(await sql(`SELECT id FROM mixpanel_cohorts WHERE "projectId" = $1`, [p.project.id])).toHaveLength(1);
});

test('INTEG-114 push stats count only who a push could reach', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const d1 = await identifyDevice(p);
  await registerToken(p, d1.fingerprint, 'android');
  const d2 = await identifyDevice(p);
  await registerToken(p, d2.fingerprint, 'android');
  await registerToken(p, d2.fingerprint, 'ios');
  const d3 = await identifyDevice(p, { pushOptIn: false });
  await registerToken(p, d3.fingerprint, 'android');
  const d4 = await identifyDevice(p, { doNotTrack: true });
  await registerToken(p, d4.fingerprint, 'android');
  const d5 = await identifyDevice(p);
  const d5Token = await registerToken(p, d5.fingerprint, 'android');
  await sql(`UPDATE push_tokens SET is_active = false WHERE token = $1`, [d5Token]);
  const cohort = await seedCohort(p.project.id, 'Reachability', [
    { deviceIdentityId: d1.id },
    { deviceIdentityId: d2.id },
    { deviceIdentityId: d3.id },
    { deviceIdentityId: d4.id },
    { deviceIdentityId: d5.id },
    { deviceIdentityId: null },
  ]);

  const stats = await as(p.owner, 'GET', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}/push-stats`);
  expect(stats.status).toBe(200);
  expect(stats.body.data).toEqual({ total: 6, resolved: 5, unresolved: 1, pushEnabled: 2 });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}`);
  await expect(page.getByRole('heading', { name: 'Reachability' })).toBeVisible();
  await expect(page.getByText('Push Enabled', { exact: true }).locator('xpath=preceding-sibling::p[1]')).toHaveText('2');
});

/** A project with push switched on and a cohort "Buyers" of an Android and an iOS device. */
async function reachableCohort(p: Awaited<ReturnType<typeof sdkProject>>, name = 'Buyers') {
  await seedFcmConfig(p.project.id);
  const d1 = await identifyDevice(p);
  await registerToken(p, d1.fingerprint, 'android');
  const d2 = await identifyDevice(p);
  await registerToken(p, d2.fingerprint, 'ios');
  const cohort = await seedCohort(p.project.id, name, [{ deviceIdentityId: d1.id }, { deviceIdentityId: d2.id }]);
  return { cohort, d1, d2 };
}

async function sendCohortPushFromPage(page: Page, title: string, body: string, deepLink?: string) {
  await page.getByPlaceholder('Notification title').fill(title);
  await page.getByPlaceholder('Notification body').fill(body);
  if (deepLink) await page.getByPlaceholder('myapp://screen/path').fill(deepLink);
  await page.getByRole('button', { name: 'Send Push' }).click();
}

test('INTEG-118 send a push to a cohort', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const { cohort, d1, d2 } = await reachableCohort(p);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}`);
  await expect(page.getByRole('heading', { name: 'Buyers' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Android' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'iOS' })).toBeChecked();

  await slowDown(page, `/mixpanel/cohorts/${cohort.id}/push`, 'POST');
  const requestPromise = page.waitForRequest((r) => r.url().endsWith(`/cohorts/${cohort.id}/push`));
  const responsePromise = page.waitForResponse((r) => r.url().endsWith(`/cohorts/${cohort.id}/push`));
  await sendCohortPushFromPage(page, 'Sale', 'Today only', 'myapp://sale');
  await expect(page.getByRole('button', { name: 'Sending...' })).toBeVisible();
  expect((await requestPromise).postDataJSON()).toEqual({ title: 'Sale', body: 'Today only', deepLinkUrl: 'myapp://sale', platforms: ['android', 'ios'] });
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: { campaignIds: string[]; devicesTargeted: number; tokensTargeted: number } };
  expect(data.campaignIds).toHaveLength(1);
  expect(data).toMatchObject({ devicesTargeted: 2, tokensTargeted: 2 });
  await expect(toast(page, 'Push campaign queued')).toContainText('Sending to 2 device(s).');
  await expect(page.getByPlaceholder('Notification title')).toHaveValue('');
  await expect(page.getByPlaceholder('Notification body')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Android' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'iOS' })).toBeChecked();

  const campaigns = await campaignRows(p.project.id);
  expect(campaigns).toHaveLength(1);
  expect(campaigns[0].id).toBe(data.campaignIds[0]);
  expect([campaigns[0].title, campaigns[0].body]).toEqual(['Sale', 'Today only']);
  expect(campaigns[0].data).toEqual({ deep_link_url: 'myapp://sale' });
  expect(await campaignRecipients(campaigns[0].id)).toEqual([d1.id, d2.id].sort());

  const sent = await activityRows(p.project.id, 'cohort.push_sent');
  expect(sent).toHaveLength(1);
  expect(sent[0].target_label).toBe('Buyers');
  expect(await activityRows(p.project.id, 'campaign.sent')).toHaveLength(0);
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} sent a push to the Mixpanel cohort "Buyers"`, { exact: true })).toBeVisible();
});

test('INTEG-121 a cohort push is refused when nobody can be reached', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  await seedFcmConfig(p.project.id);
  const push = (cohortId: string, body: Record<string, unknown> = { title: 't' }) =>
    as(p.owner, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohortId}/push`, body);

  // 1. Nobody resolved: from the page, then the API.
  const empty = await seedCohort(p.project.id, 'Nobody resolved', [{ deviceIdentityId: null }]);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/mixpanel/cohorts/${empty.id}`);
  await expect(page.getByRole('heading', { name: 'Nobody resolved' })).toBeVisible();
  const refused = page.waitForResponse((r) => r.url().endsWith(`/cohorts/${empty.id}/push`));
  await sendCohortPushFromPage(page, 'Hello', 'Anyone there');
  const refusedResponse = await refused;
  expect(refusedResponse.status()).toBe(400);
  expect((await refusedResponse.json()).message).toBe(NO_ELIGIBLE_TOKENS);
  const errorToast = toast(page, 'Error').filter({ hasText: 'Failed to send push' });
  await expect(errorToast).toBeVisible();
  await expect(errorToast).not.toContainText(NO_ELIGIBLE_TOKENS);

  // 2. Only iOS tokens, Android asked for.
  const iosOnly = await identifyDevice(p);
  await registerToken(p, iosOnly.fingerprint, 'ios');
  const iosCohort = await seedCohort(p.project.id, 'iOS only', [{ deviceIdentityId: iosOnly.id }]);
  // 3. The only member opted out of push.
  const optedOut = await identifyDevice(p, { pushOptIn: false });
  await registerToken(p, optedOut.fingerprint, 'android');
  const optedOutCohort = await seedCohort(p.project.id, 'Opted out', [{ deviceIdentityId: optedOut.id }]);
  for (const [cohortId, body] of [
    [empty.id, { title: 't' }],
    [iosCohort.id, { title: 't', platforms: ['android'] }],
    [optedOutCohort.id, { title: 't' }],
  ] as const) {
    const response = await push(cohortId, body);
    expect(response.status).toBe(400);
    expect(messageOf(response)).toBe(NO_ELIGIBLE_TOKENS);
  }

  // 5. Reachable members, all at the frequency cap.
  const capped = await identifyDevice(p);
  await registerToken(p, capped.fingerprint, 'android');
  const cappedCohort = await seedCohort(p.project.id, 'Capped', [{ deviceIdentityId: capped.id }]);
  await atFrequencyCap(p.project.id, capped.id);
  const atCap = await push(cappedCohort.id);
  expect(atCap.status).toBe(400);
  expect(messageOf(atCap)).toBe('No reachable push tokens for the target users (none registered, opted out of push, or at the frequency cap)');

  // 4. Reachable members, but the project has no active push config.
  const q = await sdkProject(await ownerWithProject());
  const device = await identifyDevice(q);
  await registerToken(q, device.fingerprint, 'android');
  const noConfig = await seedCohort(q.project.id, 'No config', [{ deviceIdentityId: device.id }]);
  const unconfigured = await as(q.owner, 'POST', `/api/projects/${q.project.id}/mixpanel/cohorts/${noConfig.id}/push`, { title: 't' });
  expect(unconfigured.status).toBe(404);
  expect(messageOf(unconfigured)).toBe('Push notifications not configured for this project. Call configure first.');

  // No campaign anywhere but the seeded earlier one, and no entry.
  expect((await campaignRows(p.project.id)).map((c) => c.title)).toEqual(['Earlier push']);
  expect(await campaignRows(q.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'cohort.push_sent')).toHaveLength(0);
  expect(await activityRows(q.project.id, 'cohort.push_sent')).toHaveLength(0);
});

test('INTEG-126 who may push to a cohort', async ({ page, browser, baseURL }) => {
  const p = await sdkProject(await ownerWithProject());
  const { cohort } = await reachableCohort(p);
  const member = await teammate(p, 'member', 'Mo Member');
  await signIn(page, member);
  await page.goto(`/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}`);
  await sendCohortPushFromPage(page, 'From a member', 'Hi');
  await expect(toast(page, 'Push campaign queued')).toContainText('Sending to 2 device(s).');
  const sent = await activityRows(p.project.id, 'cohort.push_sent');
  expect(sent).toHaveLength(1);
  expect(sent[0].actor_user_id).toBe(member.userId);
  expect(await campaignRows(p.project.id)).toHaveLength(1);

  const { context } = await newPersonContext(browser, baseURL);
  try {
    const viewAs = await context.newPage();
    await openViewAs(viewAs, await viewAsHandoff(browser, baseURL, p.owner));
    await viewAs.goto(`/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}`);
    await refusedAsReadOnly(viewAs, `/mixpanel/cohorts/${cohort.id}/push`, 'POST', () => sendCohortPushFromPage(viewAs, 'From staff', 'Hi'));
    await expect(toast(viewAs, 'Error').filter({ hasText: 'Failed to send push' })).toBeVisible();
  } finally {
    await context.close();
  }
  expect(await campaignRows(p.project.id)).toHaveLength(1);
  expect(await activityRows(p.project.id, 'cohort.push_sent')).toHaveLength(1);
});

test('INTEG-127 show an in-app message to a cohort', async ({ page }) => {
  const p = await sdkProject(await ownerWithProject());
  const messageId = await createInAppMessage(p.owner, p.project.id);
  const f1 = await identifyDevice(p);
  const f2 = await identifyDevice(p);
  const cohort = await seedCohort(p.project.id, 'Buyers', [{ deviceIdentityId: f1.id }, { deviceIdentityId: f2.id }]);

  const response = await as(p.owner, 'POST', `/api/projects/${p.project.id}/mixpanel/cohorts/${cohort.id}/iam-trigger`, { messageId });
  expect(response.status).toBe(201);
  expect(response.body.data).toEqual({ queued: 2, eligible: 2 });
  const pending = await pendingInAppRows(p.project.id);
  expect(pending.map((r) => r.device_fingerprint).sort()).toEqual([f1.fingerprint, f2.fingerprint].sort());
  for (const row of pending) {
    expect(row.message_id).toBe(messageId);
    expect(row.status).toBe('pending');
    const hoursAhead = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 3_600_000;
    expect(hoursAhead).toBeGreaterThan(23.9);
    expect(hoursAhead).toBeLessThan(24.1);
  }
  const entries = await activityRows(p.project.id, 'cohort.in_app_triggered');
  expect(entries).toHaveLength(1);
  expect(entries[0].target_label).toBe('Buyers');
  expect(await activityRows(p.project.id, 'in_app.triggered')).toHaveLength(0);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} showed an in-app message to the Mixpanel cohort "Buyers"`, { exact: true })).toBeVisible();
});

test('INTEG-130 Mixpanel routes by role', async ({ browser, baseURL }) => {
  const p = await sdkProject(await ownerWithProject());
  // A Mixpanel project id of this test's own, so the stub's cohort list answer reaches no one else.
  const mixpanelProjectId = String(randomInt(10_000_000, 99_999_999));
  await configureMixpanel(p.owner, p.project.id, mixpanelProjectId);
  const admin = await teammate(p, 'admin', 'Ada Admin');
  const member = await teammate(p, 'member', 'Mo Member');
  const outsider = await newPerson('integ-outsider', 'Nia Nobody');
  const device = await identifyDevice(p);
  const cohort = await seedCohort(p.project.id, 'Everyone', [{ deviceIdentityId: device.id }]);
  await answerStub('mixpanel', {
    method: 'GET',
    path: `/api/2.0/cohorts/list?project_id=${mixpanelProjectId}`,
    body: [{ id: cohort.mixpanelCohortId, name: 'Everyone', count: 1, description: '', created: '2026-01-01 00:00:00', project_id: Number(mixpanelProjectId), is_visible: 1 }],
  });
  const messageId = await createInAppMessage(p.owner, p.project.id);
  const viewAs = { accessToken: await viewAsToken(browser, baseURL, p.owner), ip: newClientIp() };

  const base = `/api/projects/${p.project.id}/mixpanel`;
  const c = `${base}/cohorts/${cohort.id}`;
  const reads = ['/status', '/available-cohorts', '/cohorts', `/cohorts/${cohort.id}`, `/cohorts/${cohort.id}/members`, `/cohorts/${cohort.id}/push-stats`, `/cohorts/${cohort.id}/iam-stats`];
  const configureBody = { serviceAccountUsername: MIXPANEL_ACCOUNT.username, serviceAccountPassword: MIXPANEL_ACCOUNT.password, mixpanelProjectId };
  const writes: Array<[string, string, unknown?]> = [
    ['POST', `${base}/cohorts/import`, { mixpanelCohortId: cohort.mixpanelCohortId }],
    ['POST', `${c}/sync`],
    ['POST', `${c}/push`, { title: 't' }],
    ['POST', `${c}/iam-trigger`, { messageId }],
  ];
  const people = { owner: p.owner, admin, member, viewAs } as const;

  for (const [who, person] of Object.entries(people)) {
    for (const path of reads) {
      const response = await as(person, 'GET', `${base}${path}`);
      expect(response.status, `${who} GET ${path}`).toBe(200);
      if (path === '/status') {
        const hidden = who === 'member' || who === 'viewAs';
        expect(response.body.data.serviceAccountUsername, who).toBe(hidden ? HIDDEN : MIXPANEL_ACCOUNT.username);
      }
    }
    const configure = await as(person, 'POST', `${base}/configure`, configureBody);
    const expected = { owner: [201, null], admin: [201, null], member: [403, ROLE_REFUSAL], viewAs: [403, READ_ONLY] }[who as keyof typeof people];
    expect(configure.status, `${who} configure`).toBe(expected[0]);
    if (expected[1]) expect(messageOf(configure)).toBe(expected[1]);
    for (const [method, path, body] of writes) {
      const response = await as(person, method, path, body);
      if (who === 'viewAs') {
        expect(response.status, `${who} ${method} ${path}`).toBe(403);
        expect(messageOf(response)).toBe(READ_ONLY);
      } else {
        // Past the permission check: what happens next depends on Mixpanel and the data.
        expect(response.status, `${who} ${method} ${path}`).not.toBe(403);
        expect(messageOf(response), `${who} ${method} ${path}`).not.toBe(PROJECT_NOT_FOUND);
      }
    }
  }
  for (const path of [...reads.map((r) => ['GET', `${base}${r}`]), ['POST', `${base}/configure`], ...writes, ['DELETE', c]]) {
    const [method, url, body] = path as [string, string, unknown?];
    const response = await as(outsider, method, url, body ?? (url.endsWith('/configure') ? configureBody : undefined));
    expect(response.status, `outsider ${method} ${url}`).toBe(404);
    expect(messageOf(response)).toBe(PROJECT_NOT_FOUND);
  }

  // Deletes last: view-as is refused, a member may delete.
  const refusedDelete = await as(viewAs, 'DELETE', c);
  expect(refusedDelete.status).toBe(403);
  expect(messageOf(refusedDelete)).toBe(READ_ONLY);
  const deleted = await as(member, 'DELETE', c);
  expect(deleted.status).toBe(200);
  expect(deleted.body.data).toEqual({ message: 'Cohort deleted successfully' });
});

test("INTEG-166 another project's cohort through every sub-route", async () => {
  const o = await sdkProject(await ownerWithProject());
  await seedFcmConfig(o.project.id);
  const im1 = await createInAppMessage(o.owner, o.project.id);
  const x = await sdkProject(await ownerWithProject('integ-x', 'Xena Other'));
  await seedFcmConfig(x.project.id);
  const d = await identifyDevice(x);
  await registerToken(x, d.fingerprint, 'android');
  const c2 = await seedCohort(x.project.id, 'Their cohort', [{ deviceIdentityId: d.id }]);
  const before = await cohortSnapshot(c2.id);
  const base = `/api/projects/${o.project.id}/mixpanel/cohorts/${c2.id}`;

  const members = await as(o.owner, 'GET', `${base}/members`);
  expect([members.status, messageOf(members)]).toEqual([404, 'Cohort not found']);
  const sync = await as(o.owner, 'POST', `${base}/sync`);
  expect([sync.status, messageOf(sync)]).toEqual([404, 'Cohort not found']);
  const pushStats = await as(o.owner, 'GET', `${base}/push-stats`);
  expect(pushStats.status).toBe(200);
  expect(pushStats.body.data).toEqual({ total: 0, resolved: 0, pushEnabled: 0, unresolved: 0 });
  const iamStats = await as(o.owner, 'GET', `${base}/iam-stats`);
  expect(iamStats.status).toBe(200);
  expect(iamStats.body.data).toEqual({ total: 0, resolved: 0, iamEligible: 0, unresolved: 0 });
  const push = await as(o.owner, 'POST', `${base}/push`, { title: 't' });
  expect([push.status, messageOf(push)]).toEqual([400, NO_ELIGIBLE_TOKENS]);
  const trigger = await as(o.owner, 'POST', `${base}/iam-trigger`, { messageId: im1 });
  expect(trigger.status).toBe(201);
  expect(trigger.body.data).toEqual({ queued: 0, eligible: 0 });

  expect(await campaignRows(o.project.id)).toHaveLength(0);
  expect(await campaignRows(x.project.id)).toHaveLength(0);
  expect(await pendingInAppRows(o.project.id)).toHaveLength(0);
  expect(await pendingInAppRows(x.project.id)).toHaveLength(0);
  for (const action of ['cohort.push_sent', 'cohort.in_app_triggered']) {
    expect(await activityRows(o.project.id, action)).toHaveLength(0);
    expect(await activityRows(x.project.id, action)).toHaveLength(0);
  }
  expect(await cohortSnapshot(c2.id)).toEqual(before);
  const mixpanelCalls = await stubCalls('mixpanel');
  expect(mixpanelCalls.filter((call) => JSON.stringify(call).includes(String(c2.mixpanelCohortId)))).toHaveLength(0);
});
