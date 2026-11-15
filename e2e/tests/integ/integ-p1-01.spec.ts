import { lookup } from 'dns/promises';
import { randomUUID } from 'crypto';
import type { Page } from '@playwright/test';
import { api, createApiKey } from '../../support/api';
import { readClipboard, allowClipboard } from '../../support/browser-tools';
import { expect, newPersonContext, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import {
  MIXPANEL_ACCOUNT,
  PUBLIC_ADDRESS,
  WEBHOOK_CAP,
  activityRows,
  addMember,
  allActivity,
  apiKeyRows,
  as,
  createWebhook,
  identityKeyVersion,
  literalHookUrl,
  messageOf,
  mixpanelConfigRows,
  openShortCode,
  ownerWithProject,
  raw,
  recordApiRequests,
  seedShortLink,
  sql,
  teammate,
  toast,
  waitForClickRows,
  webhookCard,
  webhookRows,
} from '../../support/areas/integ';

/**
 * Integrations, P1: the API keys page (empty state, create dialog, markup in names,
 * admins and members), key validation, expiry and revoke edge cases, the identity
 * secret card and its scope, the Webhooks page (empty state, copy, toggle, delete,
 * admins), webhook validation and the active cap under concurrency, URL changes,
 * redirects with a failing endpoint, and the Mixpanel configure page and route.
 */

test.describe.configure({ mode: 'parallel' });

const DOTS = '•'.repeat(32);
const NAME_FIELD = 'e.g., Production API Key';
const HOOK_FIELD = 'https://example.com/webhook';

function keyCard(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
}

function identityCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ hasText: 'Identity verification' });
}

function breadcrumb(page: Page) {
  return page.getByRole('navigation', { name: 'breadcrumb' });
}

async function openApiKeys(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/api-keys`);
  await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
}

async function openWebhooks(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/webhooks`);
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true })).toBeVisible();
}

async function openMixpanel(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/mixpanel`);
  await expect(page.getByRole('heading', { name: 'Mixpanel Integration' })).toBeVisible();
}

/** Adds a webhook through the dialog and answers the secret the "Webhook created" dialog shows. */
async function addWebhookInPage(page: Page, url: string, events: string[] = ['click']): Promise<{ id: string; secret: string }> {
  await page.getByRole('button', { name: 'Add Webhook' }).click();
  const add = page.getByRole('dialog', { name: 'Add Webhook' });
  await add.getByPlaceholder(HOOK_FIELD).fill(url);
  for (const event of events) await add.getByText(event, { exact: true }).click();
  const created = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/webhooks') && r.request().method() === 'POST');
  await add.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: { id: string; secret: string } };
  await expect(page.getByRole('dialog', { name: 'Webhook created' })).toBeVisible();
  return data;
}

// ---------------------------------------------------------------- API keys page

test('INTEG-001 API keys page for an owner with no keys', async ({ page }) => {
  const p = await ownerWithProject();
  const lists: Array<{ status: number; body: unknown }> = [];
  page.on('response', async (r) => {
    if (new URL(r.url()).pathname === `/api/projects/${p.project.id}/api-keys` && r.request().method() === 'GET') {
      lists.push({ status: r.status(), body: await r.json().catch(() => null) });
    }
  });
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await expect(page.getByRole('button', { name: 'Create Key' })).toBeVisible();
  await expect(page.getByText('No API keys yet. Create one to get started.', { exact: true })).toBeVisible();
  const identity = identityCard(page);
  await expect(identity).toBeVisible();
  // The identity card comes after the key list.
  const empty = await page.getByText('No API keys yet. Create one to get started.').boundingBox();
  const card = await identity.boundingBox();
  expect(card!.y).toBeGreaterThan(empty!.y);

  await expect.poll(() => lists.length).toBe(1);
  await page.waitForTimeout(500);
  expect(lists).toEqual([{ status: 200, body: { data: [] } }]);
});

test('INTEG-007 create needs a name; Cancel sends nothing', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  const posts = recordApiRequests(page, `/projects/${p.project.id}/api-keys`);

  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  const create = dialog.getByRole('button', { name: 'Create', exact: true });
  await expect(dialog.getByPlaceholder(NAME_FIELD)).toHaveValue('');
  await expect(create).toBeDisabled();
  await dialog.getByPlaceholder(NAME_FIELD).fill('   ');
  await expect(create).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Create Key' }).click();
  await dialog.getByPlaceholder(NAME_FIELD).fill('x');
  await expect(create).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.waitForTimeout(300);
  expect(posts.filter((r) => r.method === 'POST')).toEqual([]);
  await expect(page.getByText('No API keys yet. Create one to get started.', { exact: true })).toBeVisible();
  expect(await apiKeyRows(p.project.id)).toHaveLength(0);
});

test('INTEG-008 a key name with markup is shown as text', async ({ page }) => {
  const p = await ownerWithProject();
  const name = '<img src=x onerror=alert(1)>"Key"';
  let dialogs = 0;
  page.on('dialog', async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(NAME_FIELD).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  await expect(keyCard(page, name)).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText(`${p.owner.name} created the API key "${name}"`, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(dialogs).toBe(0);
});

test('INTEG-018 an admin manages ordinary keys but sees no privacy option', async ({ page }) => {
  const p = await ownerWithProject();
  const admin = await teammate(p, 'admin', 'Ada Admin');
  await signIn(page, admin);
  await openApiKeys(page, p.project.id);
  await expect(page.getByText('No API keys yet. Create one to get started.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create Key' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create API Key' })).toBeVisible();
  await expect(dialog.getByText('Server-only privacy key')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByPlaceholder(NAME_FIELD).fill('Admin key');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'API Key Created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  const card = keyCard(page, 'Admin key');
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  const [row] = await apiKeyRows(p.project.id);
  expect(row.permissions).toBe('read,write');

  await card.getByRole('button').click();
  await expect(toast(page, 'API key revoked')).toBeVisible();
  await expect(card.getByText('Revoked', { exact: true })).toBeVisible();
  expect((await apiKeyRows(p.project.id))[0].is_active).toBe(false);

  for (const action of ['api_key.created', 'api_key.revoked']) {
    const entries = await activityRows(p.project.id, action);
    expect(entries, action).toHaveLength(1);
    expect(entries[0].actor_user_id, action).toBe(admin.userId);
    expect(entries[0].target_label, action).toBe('Admin key');
  }
});

test('INTEG-020 a member sees no keys', async ({ page }) => {
  const p = await ownerWithProject();
  await createApiKey(p.owner, p.project.id, p.owner.ip);
  const member = await teammate(p, 'member', 'Mo Member');
  const requests = recordApiRequests(page, '');
  await signIn(page, member);
  await openApiKeys(page, p.project.id);
  await expect(
    page.getByText('Only owners and admins can see and manage API keys. Ask one of them for the key your app needs.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Key' })).toHaveCount(0);
  await expect(page.getByText('Identity verification')).toHaveCount(0);
  await expect(page.getByText('E2E SDK key')).toHaveCount(0);
  await openSidebarGroup(page, 'Configure');
  await expect(sidebarLink(page, 'API Keys')).toBeVisible();

  await page.waitForTimeout(500);
  // The dashboard did call the API (a positive control), but never about keys.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((r) => r.path.includes('/api-keys') || r.path.includes('/identity-secret'))).toEqual([]);
});

// ------------------------------------------------------------- key API edges

test('INTEG-024 create key: request validation', async () => {
  const p = await ownerWithProject();
  const path = `/api/projects/${p.project.id}/api-keys`;
  const cases: Array<[unknown, string]> = [
    [{}, 'name must be a string'],
    [{ name: 'k'.repeat(256) }, 'name must be shorter than or equal to 255 characters'],
    [{ name: 'k', permissions: 'read' }, 'permissions must be an array'],
    [{ name: 'k', permissions: ['admin'] }, 'each value in permissions must be one of the following values: read, write, privacy'],
    [{ name: 'k', permissions: ['read', 'write', 'privacy', 'read'] }, 'permissions must contain no more than 3 elements'],
    [
      { name: 'k', permissions: ['privacy', 'read'] },
      'A privacy key is for servers only and cannot also have read or write. Create a separate key for your app.',
    ],
    [{ name: 'k', expiresAt: 'tomorrow' }, 'expiresAt must be a valid ISO 8601 date string'],
    [{ name: 'k', foo: 1 }, 'property foo should not exist'],
  ];
  for (const [body, message] of cases) {
    const response = await as(p.owner, 'POST', path, body);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(messageOf(response), JSON.stringify(body)).toContain(message);
  }
  expect(await apiKeyRows(p.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'api_key.created')).toHaveLength(0);

  // The same route takes a valid body, so the refusals above are the bodies' own.
  expect((await as(p.owner, 'POST', path, { name: 'k' })).status).toBe(201);

  // The global pipe converts to the declared type, so a number name is stored as text.
  const numeric = await as(p.owner, 'POST', path, { name: 5 });
  expect(numeric.status).toBe(201);
  expect(numeric.body.data.apiKey.name).toBe('5');
});

test('INTEG-026 a key with an expiry', async ({ page }) => {
  const p = await ownerWithProject();
  const path = `/api/projects/${p.project.id}/api-keys`;
  const soon = await as(p.owner, 'POST', path, { name: 'soon', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const past = await as(p.owner, 'POST', path, { name: 'past', expiresAt: new Date(Date.now() - 60_000).toISOString() });
  expect(soon.status).toBe(201);
  expect(past.status).toBe(201);

  const track = (apiKey: string) =>
    raw('POST', '/api/events/track', {
      apiKey,
      ip: p.owner.ip,
      body: { projectId: p.project.id, eventName: 'integ_expiry', deviceFingerprint: `integ-fp-${randomUUID()}` },
    });
  const works = await track(soon.body.data.fullKey);
  expect(works.status).toBeGreaterThanOrEqual(200);
  expect(works.status).toBeLessThan(300);
  const refused = await track(past.body.data.fullKey);
  expect(refused.status).toBe(401);
  expect(messageOf(refused)).toBe('Invalid or expired API key');

  // As the case is written: the page shows neither expiry, and the expired key reads "Active".
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  for (const name of ['soon', 'past']) {
    const card = keyCard(page, name);
    await expect(card.getByText('Active', { exact: true })).toBeVisible();
    await expect(card).not.toContainText(/expir/i);
  }
});

test('INTEG-027 revoke edge cases', async () => {
  const o = await ownerWithProject();
  const x = await ownerWithProject('integ-x', 'Xena Other');
  await createApiKey(x.owner, x.project.id, x.owner.ip);
  const [k2] = await apiKeyRows(x.project.id);
  const base = `/api/projects/${o.project.id}/api-keys`;

  for (const id of [randomUUID(), k2.id]) {
    const response = await as(o.owner, 'DELETE', `${base}/${id}`);
    expect(response.status, id).toBe(404);
    expect(messageOf(response)).toBe('API key not found');
  }
  expect((await apiKeyRows(x.project.id))[0].is_active).toBe(true);

  const malformed = await as(o.owner, 'DELETE', `${base}/abc`);
  expect(malformed.status).toBe(400);
  expect(messageOf(malformed)).toBe('Validation failed (uuid is expected)');

  const key = await api<{ apiKey: { id: string } }>('POST', base, { name: 'Twice' }, { token: o.owner.accessToken, ip: o.owner.ip });
  for (let i = 0; i < 2; i += 1) {
    const response = await as(o.owner, 'DELETE', `${base}/${key.apiKey.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { message: 'API key revoked successfully' } });
  }
  const entries = (await activityRows(o.project.id, 'api_key.revoked')).filter((e) => e.target_id === key.apiKey.id);
  expect(entries).toHaveLength(1);
  expect(await activityRows(x.project.id, 'api_key.revoked')).toHaveLength(0);
});

// --------------------------------------------------------------- identity secret

test('INTEG-031 the identity verification card', async ({ page }) => {
  const p = await ownerWithProject();
  const { secret } = (await as(p.owner, 'GET', `/api/projects/${p.project.id}/identity-secret`)).body.data as { secret: string };
  await signIn(page, p.owner);
  await openApiKeys(page, p.project.id);
  const card = identityCard(page);
  const text = card.locator('p').first();
  await expect(text).toHaveText(
    /^When your app identifies a signed-in user, pass a userHash with their external user id.*Keep this secret on your server, never in your app\.$/,
  );
  const field = card.getByRole('textbox');
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toHaveValue(DOTS);
  const sample = card.locator('pre');
  await expect(sample).toContainText('// Node, on your server');
  await expect(sample).toContainText("crypto.createHmac('sha256', IDENTITY_SECRET).update(userId).digest('hex')");
  await expect(card.getByRole('button', { name: 'Rotate secret' })).toBeVisible();
  await expect(card.locator('button:has(svg.lucide-copy)')).toBeVisible();

  await card.getByRole('button', { name: 'Show' }).click();
  await expect(field).toHaveValue(/^[0-9a-f]{64}$/);
  await expect(field).toHaveValue(secret);
  await expect(card.getByRole('button', { name: 'Hide' })).toBeVisible();
  await card.getByRole('button', { name: 'Hide' }).click();
  await expect(field).toHaveValue(DOTS);
  await expect(card.getByRole('button', { name: 'Show' })).toBeVisible();
});

test('INTEG-033 the identity secret is stable and per project', async () => {
  const o = await ownerWithProject();
  const x = await ownerWithProject('integ-x', 'Xena Other');
  await addMember(o.project.id, x.owner, 'owner', o.owner);
  const read = async (person: typeof o.owner, projectId: string) => {
    const response = await as(person, 'GET', `/api/projects/${projectId}/identity-secret`);
    expect(response.status).toBe(200);
    return response.body.data as { secret: string; version: number };
  };
  const first = await read(o.owner, o.project.id);
  expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(first.version).toBe(1);
  expect(Object.keys(first).sort()).toEqual(['secret', 'version']);
  expect(await read(o.owner, o.project.id)).toEqual(first);
  expect(await read(x.owner, o.project.id)).toEqual(first);
  const other = await read(x.owner, x.project.id);
  expect(other.version).toBe(1);
  expect(other.secret).not.toBe(first.secret);

  const secretColumns = await sql(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND (column_name ILIKE '%secret%' OR column_name ILIKE '%identity%')`,
  );
  expect(secretColumns.map((c) => c.column_name)).toEqual(['identity_key_version']);
  const [row] = await sql<{ json: string }>(`SELECT row_to_json(p)::text AS json FROM projects p WHERE id = $1`, [o.project.id]);
  expect(row.json).not.toContain(first.secret);
});

test('INTEG-038 an admin can read and rotate the identity secret', async ({ page }) => {
  const p = await ownerWithProject();
  const admin = await teammate(p, 'admin', 'Ada Admin');
  await signIn(page, admin);
  await openApiKeys(page, p.project.id);
  const card = identityCard(page);
  await card.getByRole('button', { name: 'Show' }).click();
  const field = card.getByRole('textbox');
  await expect(field).toHaveValue(/^[0-9a-f]{64}$/);
  const before = await field.inputValue();
  const { secret: ownerView } = (await as(p.owner, 'GET', `/api/projects/${p.project.id}/identity-secret`)).body.data as { secret: string };
  expect(before).toBe(ownerView);

  page.once('dialog', (d) => d.accept());
  const rotated = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}/identity-secret/rotate`));
  await card.getByRole('button', { name: 'Rotate secret' }).click();
  const response = await rotated;
  expect(response.status()).toBe(200);
  const { data } = (await response.json()) as { data: { secret: string; version: number } };
  expect(data.version).toBe(2);
  expect(data.secret).not.toBe(before);
  await expect(toast(page, 'Identity secret rotated')).toBeVisible();
  await expect(field).toHaveValue(data.secret);
  expect(await identityKeyVersion(p.project.id)).toBe(2);

  const entries = await activityRows(p.project.id, 'identity.secret_rotated');
  expect(entries).toHaveLength(1);
  expect(entries[0].actor_user_id).toBe(admin.userId);
});

// ------------------------------------------------------------------ webhooks page

test('INTEG-041 Webhooks page for an owner with none', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Configure');
  await sidebarLink(page, 'Webhooks').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/webhooks$`));
  await expect(page.getByRole('heading', { name: 'Webhooks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Webhook' })).toBeVisible();
  await expect(page.getByText('No webhooks configured. Add one to receive event notifications.', { exact: true })).toBeVisible();
  await expect(breadcrumb(page).getByText('Webhooks', { exact: true })).toBeVisible();

  // And by deep link.
  await openWebhooks(page, p.project.id);
  await expect(page.getByText('No webhooks configured. Add one to receive event notifications.', { exact: true })).toBeVisible();
});

test('INTEG-045 add a webhook with a host name', async () => {
  const resolved = await lookup('example.com', { all: true }).catch(() => []);
  test.skip(resolved.length === 0, 'No outbound DNS on this runner');
  const p = await ownerWithProject();
  const response = await as(p.owner, 'POST', `/api/projects/${p.project.id}/webhooks`, { url: 'https://example.com/hook', events: ['click'] });
  expect(response.status).toBe(201);
  expect(response.body.data).toMatchObject({ url: 'https://example.com/hook', events: ['click'], isActive: true });
  const rows = await webhookRows(p.project.id);
  expect(rows.map((r) => r.url)).toEqual(['https://example.com/hook']);
});

test('INTEG-046 copy the signing secret, and a refused copy', async ({ page, browser, baseURL }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  await allowClipboard(page);
  const { secret } = await addWebhookInPage(page, literalHookUrl('copy'));
  const reveal = page.getByRole('dialog', { name: 'Webhook created' });
  const copy = reveal.getByRole('button', { name: 'Copy signing secret' });
  await expect(copy.locator('svg.lucide-copy')).toBeVisible();
  await copy.click();
  await expect(copy.locator('svg.lucide-check')).toBeVisible();
  expect(await readClipboard(page)).toBe(secret);
  await expect(toast(page, 'Copy failed')).toHaveCount(0);
  await expect(copy.locator('svg.lucide-copy')).toBeVisible({ timeout: 4000 });

  // A browser with no clipboard permission: writes are refused.
  const { context } = await newPersonContext(browser, baseURL);
  try {
    const other = await context.newPage();
    await signIn(other, p.owner);
    await openWebhooks(other, p.project.id);
    const second = await addWebhookInPage(other, literalHookUrl('refused'));
    const otherReveal = other.getByRole('dialog', { name: 'Webhook created' });
    await otherReveal.getByRole('button', { name: 'Copy signing secret' }).click();
    await expect(toast(other, 'Copy failed').filter({ hasText: 'Select the secret and copy it manually.' })).toBeVisible();
    await expect(otherReveal.getByRole('button', { name: 'Copy signing secret' }).locator('svg.lucide-check')).toHaveCount(0);
    const code = otherReveal.locator('code');
    await expect(code).toHaveText(second.secret);
    await expect(code).toHaveClass(/select-all/);
  } finally {
    await context.close();
  }
});

test('INTEG-054 turn a webhook off and on', async ({ page }) => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id, { events: ['click', 'install'] });
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  const toggle = webhookCard(page, webhook.url).getByRole('switch');
  await expect(toggle).toBeChecked();

  const patches: Array<{ status: number; body: unknown }> = [];
  page.on('response', async (r) => {
    if (r.url().endsWith(`/webhooks/${webhook.id}`) && r.request().method() === 'PATCH') {
      patches.push({ status: r.status(), body: r.request().postDataJSON() });
    }
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => patches.length).toBe(1);
  await page.reload();
  await expect(webhookCard(page, webhook.url).getByRole('switch')).not.toBeChecked();
  expect((await webhookRows(p.project.id))[0].is_active).toBe(false);

  await webhookCard(page, webhook.url).getByRole('switch').click();
  await expect(webhookCard(page, webhook.url).getByRole('switch')).toBeChecked();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches).toEqual([
    { status: 200, body: { isActive: false } },
    { status: 200, body: { isActive: true } },
  ]);
  await page.reload();
  await expect(webhookCard(page, webhook.url).getByRole('switch')).toBeChecked();

  const entries = await activityRows(p.project.id, 'webhook.changed');
  expect(entries.map((e) => e.details)).toEqual([
    { events: ['click', 'install'], fields: ['isActive'] },
    { events: ['click', 'install'], fields: ['isActive'] },
  ]);
});

test('INTEG-060 delete a webhook', async ({ page }) => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id);
  let confirms = 0;
  page.on('dialog', async (d) => {
    confirms += 1;
    await d.accept();
  });
  await signIn(page, p.owner);
  await openWebhooks(page, p.project.id);
  const card = webhookCard(page, webhook.url);
  const deleted = page.waitForResponse((r) => r.url().endsWith(`/webhooks/${webhook.id}`) && r.request().method() === 'DELETE');
  await card.getByRole('button').last().click();
  const response = await deleted;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ data: { message: 'Webhook deleted successfully' } });
  await expect(card).toHaveCount(0);
  await expect(page.getByText('No webhooks configured. Add one to receive event notifications.', { exact: true })).toBeVisible();
  expect(confirms).toBe(0);
  expect(await webhookRows(p.project.id)).toHaveLength(0);

  const entries = await activityRows(p.project.id, 'webhook.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_type: 'webhook', target_id: webhook.id, target_label: webhook.id, details: null });

  const again = await as(p.owner, 'DELETE', `/api/projects/${p.project.id}/webhooks/${webhook.id}`);
  expect(again.status).toBe(404);
  expect(messageOf(again)).toBe('Webhook not found');
  expect(await activityRows(p.project.id, 'webhook.deleted')).toHaveLength(1);

  // A failed delete: the card stays and nothing is said.
  const kept = await createWebhook(p.owner, p.project.id);
  await page.route(`**/webhooks/${kept.id}`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) })
      : route.fallback(),
  );
  await page.reload();
  const keptCard = webhookCard(page, kept.url);
  await expect(keptCard).toBeVisible();
  const failed = page.waitForResponse((r) => r.url().endsWith(`/webhooks/${kept.id}`) && r.request().method() === 'DELETE');
  await keptCard.getByRole('button').last().click();
  expect((await failed).status()).toBe(500);
  await page.waitForTimeout(1000);
  await expect(page.locator('li[data-swipe-direction]')).toHaveCount(0);
  await expect(keptCard).toBeVisible();
  expect(await webhookRows(p.project.id)).toHaveLength(1);
});

test('INTEG-062 an admin manages webhooks', async ({ page }) => {
  const p = await ownerWithProject();
  const admin = await teammate(p, 'admin', 'Ada Admin');
  await signIn(page, admin);
  await openWebhooks(page, p.project.id);
  const url = literalHookUrl('admin');
  const created = await addWebhookInPage(page, url);
  await page.getByRole('dialog', { name: 'Webhook created' }).getByRole('button', { name: 'Done' }).click();
  const card = webhookCard(page, url);
  await expect(card.getByText(url, { exact: true })).toBeVisible();

  await card.getByRole('button', { name: 'Rotate secret' }).click();
  const confirm = page.getByRole('dialog', { name: 'Rotate signing secret?' });
  await expect(confirm).toContainText(`Deliveries to ${url} will fail verification`);
  await confirm.getByRole('button', { name: 'Rotate', exact: true }).click();
  const reveal = page.getByRole('dialog', { name: 'New signing secret' });
  await expect(reveal.locator('code')).toHaveText(/^[0-9a-f]{64}$/);
  expect(await reveal.locator('code').textContent()).not.toBe(created.secret);
  await reveal.getByRole('button', { name: 'Done' }).click();

  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).not.toBeChecked();
  await expect.poll(async () => (await webhookRows(p.project.id))[0]?.is_active).toBe(false);

  await card.getByRole('button').last().click();
  await expect(card).toHaveCount(0);
  expect(await webhookRows(p.project.id)).toHaveLength(0);

  for (const action of ['webhook.created', 'webhook.secret_rotated', 'webhook.changed', 'webhook.deleted']) {
    const entries = await activityRows(p.project.id, action);
    expect(entries, action).toHaveLength(1);
    expect(entries[0].actor_user_id, action).toBe(admin.userId);
    expect(entries[0].target_id, action).toBe(created.id);
  }
});

// --------------------------------------------------------------- webhook API edges

test('INTEG-050 create webhook: request validation', async () => {
  const p = await ownerWithProject();
  const path = `/api/projects/${p.project.id}/webhooks`;
  const longUrl = `https://1.1.1.1/${'a'.repeat(2049 - 'https://1.1.1.1/'.length)}`;
  expect(longUrl).toHaveLength(2049);
  const cases: Array<[unknown, string]> = [
    [{ events: ['click'] }, 'url must be a URL address'],
    [{ url: 'https://1.1.1.1/a' }, 'events must be an array'],
    [{ url: 'https://1.1.1.1/a', events: 'click' }, 'events must be an array'],
    [{ url: 'https://1.1.1.1/a', events: [1] }, 'each value in events must be a string'],
    [{ url: longUrl, events: ['click'] }, 'url must be shorter than or equal to 2048 characters'],
    [{ url: 'https://1.1.1.1/a', events: ['click'], isActive: ['yes'] }, 'isActive must be a boolean value'],
    [{ url: 'https://1.1.1.1/a', events: ['click'], secret: 'mine' }, 'property secret should not exist'],
    [{ url: 'https://1.1.1.1/a', events: ['click'], foo: 1 }, 'property foo should not exist'],
  ];
  for (const [body, message] of cases) {
    const response = await as(p.owner, 'POST', path, body);
    expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect(messageOf(response), JSON.stringify(body).slice(0, 80)).toContain(message);
  }
  expect(await webhookRows(p.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'webhook.created')).toHaveLength(0);

  // A URL of exactly 2048 characters and a well-formed body are taken.
  const atLimit = await as(p.owner, 'POST', path, { url: longUrl.slice(0, 2048), events: ['click'] });
  expect(atLimit.status).toBe(201);

  // The global pipe converts to the declared type, so the string "yes" arrives as true.
  const yes = await as(p.owner, 'POST', path, { url: literalHookUrl('yes'), events: ['click'], isActive: 'yes' });
  expect(yes.status).toBe(201);
  expect(yes.body.data.isActive).toBe(true);
});

test('INTEG-056 two creates at the ninth webhook', async () => {
  const p = await ownerWithProject();
  for (let round = 0; round < 3; round += 1) {
    // A project of its own per round, each with nine active webhooks.
    const project = await api<{ id: string }>('POST', '/api/projects', { name: `Race ${round}`, domain: 'e2e.example.test' }, { token: p.owner.accessToken, ip: p.owner.ip });
    for (let i = 0; i < 9; i += 1) await createWebhook(p.owner, project.id, { url: literalHookUrl(`r${round}-${i}`) });
    const path = `/api/projects/${project.id}/webhooks`;
    const results = await Promise.all([
      as(p.owner, 'POST', path, { url: literalHookUrl(`r${round}-a`), events: ['click'] }),
      as(p.owner, 'POST', path, { url: literalHookUrl(`r${round}-b`), events: ['click'] }),
    ]);
    expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([201, 400]);
    expect(messageOf(results.find((r) => r.status === 400)!)).toBe(WEBHOOK_CAP);
    const rows = await webhookRows(project.id);
    expect(rows.filter((w) => w.is_active), `round ${round}`).toHaveLength(10);
    expect(await activityRows(project.id, 'webhook.created')).toHaveLength(10);
  }
});

test("INTEG-067 change a webhook's URL through the API", async () => {
  const p = await ownerWithProject();
  const webhook = await createWebhook(p.owner, p.project.id, { url: 'https://1.1.1.1/a', events: ['click', 'conversion'] });
  const path = `/api/projects/${p.project.id}/webhooks/${webhook.id}`;

  const moved = await as(p.owner, 'PATCH', path, { url: 'https://8.8.8.8/b' });
  expect(moved.status).toBe(200);
  expect(moved.body.data.url).toBe('https://8.8.8.8/b');
  const entries = await activityRows(p.project.id, 'webhook.changed');
  expect(entries).toHaveLength(1);
  expect(entries[0].details).toEqual({ events: ['click', 'conversion'], fields: ['url'] });
  const logged = JSON.stringify(entries[0]);
  expect(logged).not.toContain('8.8.8.8');
  expect(logged).not.toContain('1.1.1.1');

  const refused = await as(p.owner, 'PATCH', path, { url: 'http://10.0.0.1/c' });
  expect(refused.status).toBe(400);
  expect(messageOf(refused)).toBe(PUBLIC_ADDRESS);
  const [afterRefusal] = await webhookRows(p.project.id);
  expect(afterRefusal.url).toBe('https://8.8.8.8/b');

  const same = await as(p.owner, 'PATCH', path, { url: 'https://8.8.8.8/b' });
  expect(same.status).toBe(200);
  expect(same.body.data.url).toBe('https://8.8.8.8/b');
  expect(await webhookRows(p.project.id)).toEqual([afterRefusal]);
  expect(await activityRows(p.project.id, 'webhook.changed')).toHaveLength(1);
});

test('INTEG-077 a failing endpoint never slows the redirect or loses the click', async () => {
  const p = await ownerWithProject();
  await createWebhook(p.owner, p.project.id, { url: 'https://1.1.1.1:81/never', events: ['click'] });
  const link = await seedShortLink(p.owner, p.project.id, 'integ-slow');
  const timings: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const opened = await openShortCode(link.shortCode, p.owner.ip);
    expect(opened.status).toBe(302);
    expect(opened.location).toBe('https://example.com/integ-slow');
    timings.push(opened.ms);
  }
  // The delivery's own deadline is 5 s: a redirect that waited for it would take that long.
  for (const ms of timings) expect(ms).toBeLessThan(2000);
  expect(await waitForClickRows(link.id, 5)).toBe(5);
});

// ------------------------------------------------------------------ Mixpanel configure

test('INTEG-082 the configure page before Mixpanel is connected', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openMixpanel(page, p.project.id);
  await expect(page.locator('button:has(svg.lucide-arrow-left)')).toBeVisible();
  await expect(breadcrumb(page).getByText('Mixpanel', { exact: true })).toBeVisible();

  const status = page.locator('[data-slot="card"]').filter({ hasText: 'Current Status' });
  await expect(status.getByText('Status:', { exact: true })).toBeVisible();
  await expect(status.getByText('Not Configured', { exact: true })).toBeVisible();
  await expect(status.getByText('Active', { exact: true })).toHaveCount(0);
  await expect(status.getByText('Project ID:')).toHaveCount(0);
  await expect(status.getByText('Service Account:')).toHaveCount(0);

  const form = page.locator('[data-slot="card"]').filter({ hasText: 'Service Account Credentials' });
  await expect(form.getByText('Enter your Mixpanel service account credentials to enable cohort syncing.', { exact: true })).toBeVisible();
  for (const label of ['Service Account Username', 'Service Account Password', 'Mixpanel Project ID']) {
    await expect(form.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByPlaceholder('service-account@mixpanel.com')).toBeVisible();
  const password = page.getByPlaceholder('Service account secret');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(page.getByPlaceholder('123456')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Show' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Configuration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Cohorts' })).toBeVisible();
});

test('INTEG-083 the configure form requires every field', async ({ page }) => {
  const p = await ownerWithProject();
  await signIn(page, p.owner);
  await openMixpanel(page, p.project.id);
  const requests = recordApiRequests(page, '/mixpanel/configure');
  const messages = ['Username is required', 'Password is required', 'Project ID is required'];

  await page.getByRole('button', { name: 'Save Configuration' }).click();
  for (const message of messages) await expect(page.getByText(message, { exact: true })).toBeVisible();

  await page.getByPlaceholder('service-account@mixpanel.com').fill(MIXPANEL_ACCOUNT.username);
  await page.getByRole('button', { name: 'Save Configuration' }).click();
  await expect(page.getByText('Username is required', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Password is required', { exact: true })).toBeVisible();
  await expect(page.getByText('Project ID is required', { exact: true })).toBeVisible();

  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
  expect(await mixpanelConfigRows(p.project.id)).toHaveLength(0);
});

test('INTEG-086 saving the same Mixpanel account again changes nothing', async () => {
  const p = await ownerWithProject();
  const path = `/api/projects/${p.project.id}/mixpanel/configure`;
  const account = {
    serviceAccountUsername: MIXPANEL_ACCOUNT.username,
    serviceAccountPassword: MIXPANEL_ACCOUNT.password,
    mixpanelProjectId: MIXPANEL_ACCOUNT.projectId,
  };
  expect((await as(p.owner, 'POST', path, account)).status).toBe(201);
  const [first] = await mixpanelConfigRows(p.project.id);
  expect(await activityRows(p.project.id, 'mixpanel.configured')).toHaveLength(1);

  const same = await as(p.owner, 'POST', path, account);
  expect(same.status).toBe(201);
  expect(same.body.data).toEqual({ id: first.id, projectId: p.project.id, isActive: true });
  expect(await mixpanelConfigRows(p.project.id)).toEqual([first]);
  expect(await activityRows(p.project.id, 'mixpanel.configured')).toHaveLength(1);

  const otherProject = await as(p.owner, 'POST', path, { ...account, mixpanelProjectId: '654321' });
  expect(otherProject.status).toBe(201);
  const [second] = await mixpanelConfigRows(p.project.id);
  expect(second.mixpanelProjectId).toBe('654321');
  expect(second.id).toBe(first.id);
  expect(await activityRows(p.project.id, 'mixpanel.configured')).toHaveLength(2);

  const otherPassword = await as(p.owner, 'POST', path, { ...account, mixpanelProjectId: '654321', serviceAccountPassword: 'another-pass' });
  expect(otherPassword.status).toBe(201);
  const [third] = await mixpanelConfigRows(p.project.id);
  expect(third.serviceAccountPasswordEncrypted).not.toBe(second.serviceAccountPasswordEncrypted);
  expect(third.mixpanelProjectId).toBe('654321');
  expect(await activityRows(p.project.id, 'mixpanel.configured')).toHaveLength(3);
});

test('INTEG-088 configure: request validation', async () => {
  const p = await ownerWithProject();
  const path = `/api/projects/${p.project.id}/mixpanel/configure`;
  const good = { serviceAccountUsername: 'svc@mixpanel.test', serviceAccountPassword: 'pw', mixpanelProjectId: '1' };
  const cases: Array<[unknown, string[]]> = [
    [{}, ['serviceAccountUsername should not be empty', 'serviceAccountPassword should not be empty', 'mixpanelProjectId should not be empty']],
    [{ ...good, serviceAccountUsername: 'u'.repeat(256) }, ['serviceAccountUsername must be shorter than or equal to 255 characters']],
    [{ ...good, serviceAccountPassword: '' }, ['serviceAccountPassword should not be empty']],
    [{ ...good, mixpanelProjectId: '1'.repeat(51) }, ['mixpanelProjectId must be shorter than or equal to 50 characters']],
    [{ ...good, isActive: false }, ['property isActive should not exist']],
  ];
  for (const [body, expected] of cases) {
    const response = await as(p.owner, 'POST', path, body);
    expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    const message = messageOf(response);
    for (const part of expected) expect(message, JSON.stringify(body).slice(0, 80)).toContain(part);
  }
  expect(await mixpanelConfigRows(p.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'mixpanel.configured')).toHaveLength(0);

  // The longest allowed values are taken.
  const atLimit = await as(p.owner, 'POST', path, { ...good, serviceAccountUsername: 'u'.repeat(255), mixpanelProjectId: '1'.repeat(50) });
  expect(atLimit.status).toBe(201);
});

test('INTEG-090 an admin can connect Mixpanel', async ({ page }) => {
  const p = await ownerWithProject();
  const admin = await teammate(p, 'admin', 'Ada Admin');
  await signIn(page, admin);
  await openMixpanel(page, p.project.id);
  await page.getByPlaceholder('service-account@mixpanel.com').fill(MIXPANEL_ACCOUNT.username);
  await page.getByPlaceholder('Service account secret').fill(MIXPANEL_ACCOUNT.password);
  await page.getByPlaceholder('123456').fill(MIXPANEL_ACCOUNT.projectId);
  const saved = page.waitForResponse((r) => r.url().endsWith('/mixpanel/configure'));
  await page.getByRole('button', { name: 'Save Configuration' }).click();
  expect((await saved).status()).toBe(201);
  await expect(toast(page, 'Mixpanel configured successfully')).toBeVisible();
  const status = page.locator('[data-slot="card"]').filter({ hasText: 'Current Status' });
  await expect(status.getByText('Configured', { exact: true })).toBeVisible();
  await expect(status.getByText('Service Account:', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText(MIXPANEL_ACCOUNT.username);

  const [config] = await mixpanelConfigRows(p.project.id);
  expect(config).toMatchObject({ serviceAccountUsername: MIXPANEL_ACCOUNT.username, mixpanelProjectId: MIXPANEL_ACCOUNT.projectId, isActive: true });
  const entries = await activityRows(p.project.id, 'mixpanel.configured');
  expect(entries).toHaveLength(1);
  expect(entries[0].actor_user_id).toBe(admin.userId);
  expect((await allActivity(p.project.id)).filter((e) => e.actor_user_id === p.owner.userId && e.action === 'mixpanel.configured')).toHaveLength(0);
});
