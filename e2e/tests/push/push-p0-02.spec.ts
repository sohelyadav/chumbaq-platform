import { randomBytes } from 'crypto';
import { format } from 'date-fns';
import { fakeServiceAccount } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import { api } from '../../support/api';
import {
  activityRows,
  addDevice,
  addMember,
  call,
  campaignRow,
  campaignRows,
  card,
  createTemplate,
  credentialRows,
  dataOf,
  eventRows,
  fcmSendsFor,
  field,
  figureTile,
  HIDDEN,
  messageOf,
  newPerson,
  newToken,
  openPush,
  openViewAs,
  privacyKey,
  PROJECT_NOT_FOUND,
  projectReach,
  pushConfigRow,
  pushProject,
  READ_ONLY,
  ROLE_REFUSAL,
  sdkCall,
  seedCampaign,
  seedSentCampaign,
  signedInStaff,
  sql,
  statusValue,
  teammate,
  templateRow,
  templateRows,
  toastBehindDialog,
  toastTitled,
  tokenRows,
  tokenRowsByValue,
  touchpointRows,
  viewAsCaller,
  viewAsLink,
  type Caller,
  type PushProject,
} from '../../support/areas/push';

/**
 * Push: the campaign detail page and cancel, the Templates tab and template API, the
 * SDK's token and event routes, and the rules every push route shares (sign-in, roles,
 * which project id is checked, view-as). FCM is seeded; devices arrive through the
 * SDK's identify and token routes.
 */

const SERVER_ONLY_KEY =
  'This is a server-only privacy key and cannot be used by an app or SDK. Use an ordinary API key in your app.';
const CAMPAIGN_NOT_FOUND = 'Campaign not found for this project';
const TEMPLATE_NOT_FOUND = 'Template not found for this project';
const DEVICE_NOT_FOUND = 'Device identity not found. Call identify() first.';
const HTML_TITLE = '<img src=x onerror=alert(1)>';
const SCRIPT_TEXT = '<script>alert(1)</script>';

const inAMonth = () => new Date(Date.now() + 30 * 86_400_000);
const TEMPLATES = (projectId: string) => `/api/projects/${projectId}/push-templates`;

/** A campaign scheduled a month ahead through the real send route. */
async function scheduleCampaign(p: PushProject, title: string): Promise<{ id: string; scheduledAt: string }> {
  const sent = dataOf(
    await call('POST', '/api/push-notifications/send', p.owner, {
      projectId: p.project.id,
      title,
      scheduledAt: inAMonth().toISOString(),
    }),
  );
  expect(sent.status).toBe('scheduled');
  return { id: sent.id, scheduledAt: sent.scheduledAt };
}

/** Every dialog a page opens (alert, confirm), answered with `accept`. */
function recordDialogs(page: import('@playwright/test').Page, accept: (type: string) => boolean = () => false) {
  const seen: Array<{ type: string; message: string }> = [];
  page.on('dialog', (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    void (accept(dialog.type()) ? dialog.accept() : dialog.dismiss());
  });
  return seen;
}

// ------------------------------------------------------- M. Campaign detail ---

test('PUSH-192 campaign copy and failure text are inert', async ({ page }) => {
  const p = await pushProject('push-192', { fcm: true });
  const token = newToken();
  const id = await seedCampaign(p.project.id, {
    title: HTML_TITLE,
    status: 'failed',
    errorMessage: SCRIPT_TEXT,
    failureDetails: [{ token, error: SCRIPT_TEXT }],
    totalTokens: 1,
    failureCount: 1,
  });

  const dialogs = recordDialogs(page);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: HTML_TITLE, exact: true })).toBeVisible();
  // The error card, the failure badge and the failure table all show the text as written.
  await expect(page.locator('div.border-destructive\\/40').getByText(SCRIPT_TEXT, { exact: true })).toBeVisible();
  await expect(page.getByText(`${SCRIPT_TEXT} × 1`, { exact: true })).toBeVisible();
  const failureRow = page.getByRole('row').filter({ hasText: `…${token.slice(-10)}` });
  await expect(failureRow.locator('span.font-mono')).toHaveText(SCRIPT_TEXT);
  await expect(failureRow.getByRole('cell').first()).toHaveAttribute('title', token);

  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('main script')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('PUSH-200 cancel a scheduled campaign', async ({ page }) => {
  const p = await pushProject('push-200', { fcm: true });
  await addDevice(p, p.owner.ip);
  const promo = await scheduleCampaign(p, 'Promo');
  const when = format(new Date(promo.scheduledAt), 'MMM d, yyyy HH:mm');

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${promo.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Promo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Cancel this campaign?' })).toBeVisible();
  await expect(dialog).toContainText(
    `"Promo" is scheduled for ${when}. Cancelling now means it will never be sent. This can't be undone.`,
  );
  await dialog.getByRole('button', { name: 'Keep it scheduled' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await campaignRow(promo.id))?.status).toBe('scheduled');

  // Hold the request so the pending label can be seen.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/push-notifications/cancel/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await dialog.getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  const answered = page.waitForResponse((r) => r.url().includes('/api/push-notifications/cancel/'));
  release();
  expect((await answered).status()).toBe(201);
  await expect(toastTitled(page, 'Campaign cancelled')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const row = await campaignRow(promo.id);
  expect(row?.status).toBe('cancelled');
  expect(row?.completed_at).not.toBeNull();
  const entries = await activityRows(p.project.id, 'campaign.cancelled');
  expect(entries).toHaveLength(1);
  expect(entries[0].actor_user_id).toBe(p.owner.userId);
  const viaApi = dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${promo.id}`, p.owner));
  expect(viaApi.status).toBe('cancelled');
  expect(viaApi.completedAt).toBeTruthy();
  // Only the list query is refreshed by the cancel: this page keeps its loaded state.
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();

  await openPush(page, p.project.id);
  await page.getByRole('tab', { name: 'Failed', exact: true }).click();
  const listed = page.getByRole('row').filter({ hasText: 'Promo' });
  await expect(listed.getByText('Cancelled', { exact: true })).toBeVisible();
});

test('PUSH-203 cancel API: roles, tenants, view-as', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const p = await pushProject('push-203', { fcm: true });
  await addDevice(p, p.owner.ip);
  const member = await teammate(p.project.id, 'member', p.owner);
  const outsider = await pushProject('push-203-o');
  const other = await pushProject('push-203-x');
  const foreign = await seedCampaign(other.project.id, { title: 'Theirs', status: 'scheduled', scheduledAt: inAMonth() });
  const mine = await scheduleCampaign(p, 'Member cancels');
  const kept = await scheduleCampaign(p, 'Stays scheduled');
  const cancel = (as: Caller, projectId: string, campaignId: string) =>
    call('POST', `/api/push-notifications/cancel/${projectId}/${campaignId}`, as);

  const asOutsider = await cancel(outsider.owner, p.project.id, kept.id);
  expect([asOutsider.status, messageOf(asOutsider)]).toEqual([404, PROJECT_NOT_FOUND]);
  for (const as of [member, p.owner]) {
    const crossed = await cancel(as, p.project.id, foreign);
    expect([crossed.status, messageOf(crossed)]).toEqual([404, CAMPAIGN_NOT_FOUND]);
  }
  const staff = await signedInStaff(browser, baseURL);
  const viewAs = await viewAsCaller(staff, p.owner);
  const asViewAs = await cancel(viewAs, p.project.id, kept.id);
  expect([asViewAs.status, messageOf(asViewAs)]).toEqual([403, READ_ONLY]);

  const byMember = await cancel(member, p.project.id, mine.id);
  expect(byMember.status).toBe(201);
  expect(dataOf(byMember).status).toBe('cancelled');

  expect((await campaignRow(mine.id))?.status).toBe('cancelled');
  expect((await campaignRow(kept.id))?.status).toBe('scheduled');
  expect((await campaignRow(foreign))?.status).toBe('scheduled');
  const entries = await activityRows(p.project.id, 'campaign.cancelled');
  expect(entries.map((e) => e.actor_user_id)).toEqual([member.userId]);
});

test('PUSH-205 report and experiment APIs are tenant-scoped', async () => {
  const p = await pushProject('push-205', { fcm: true });
  const own = await seedSentCampaign(p.project.id, 'Ours');
  const other = await pushProject('push-205-x');
  const theirs = await seedSentCampaign(other.project.id, 'Theirs');
  const outsider = await pushProject('push-205-o');
  const routes = ['report', 'experiment', 'campaign'];

  for (const route of routes) {
    const ok = await call('GET', `/api/push-notifications/${route}/${p.project.id}/${own}`, p.owner);
    expect(ok.status, route).toBe(200);
    const crossed = await call('GET', `/api/push-notifications/${route}/${p.project.id}/${theirs}`, p.owner);
    expect([crossed.status, messageOf(crossed)], route).toEqual([404, CAMPAIGN_NOT_FOUND]);
    expect(crossed.text).not.toContain('Theirs');
  }
  const asOutsider = await call('GET', `/api/push-notifications/report/${p.project.id}/${own}`, outsider.owner);
  expect([asOutsider.status, messageOf(asOutsider)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(asOutsider.body.data).toBeUndefined();
});

// -------------------------------------------------------- N. Templates ---

test('PUSH-221 template text is inert', async ({ page }) => {
  const p = await pushProject('push-221', { fcm: true });
  await addDevice(p, p.owner.ip);
  const template = await createTemplate(p.owner, p.project.id, { name: HTML_TITLE, description: HTML_TITLE, title: '<b>bold</b>' });

  const dialogs = recordDialogs(page);
  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Templates');
  const row = page.getByRole('row').filter({ hasText: '<b>bold</b>' });
  await expect(row.getByRole('cell').nth(0)).toHaveText(HTML_TITLE);
  await expect(row.getByRole('cell').nth(1)).toHaveText(HTML_TITLE);
  await expect(row.getByRole('cell').nth(2)).toHaveText('<b>bold</b>');

  await row.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('heading', { name: 'Edit template' })).toBeVisible();
  await expect(field(editor, 'Name *').getByRole('textbox')).toHaveValue(HTML_TITLE);
  await expect(field(editor, 'Description').getByRole('textbox')).toHaveValue(HTML_TITLE);
  await expect(field(editor, 'Title *').getByRole('textbox')).toHaveValue('<b>bold</b>');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveCount(0);

  await row.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toEqual({ type: 'confirm', message: `Delete the template "${HTML_TITLE}"? This cannot be undone.` });
  expect(await templateRow(template.id)).toBeDefined();

  await page.goto(`/projects/${p.project.id}/push-notifications/new`);
  await page.getByRole('button', { name: 'Next' }).click();
  const tile = page.getByRole('button').filter({ hasText: HTML_TITLE });
  await expect(tile.getByText(HTML_TITLE, { exact: true })).toHaveCount(2);
  await tile.click();
  await expect(field(page, 'Title *').getByRole('textbox')).toHaveValue('<b>bold</b>');

  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('main b', { hasText: 'bold' })).toHaveCount(0);
  expect(dialogs.filter((d) => d.type !== 'confirm')).toEqual([]);
});

test('PUSH-225 template API: tenant scoping', async () => {
  const p = await pushProject('push-225');
  const other = await pushProject('push-225-x');
  const outsider = await pushProject('push-225-o');
  const theirs = await createTemplate(other.owner, other.project.id, { name: 'Their template', title: 'Their title' });
  const before = await templateRow(theirs.id);
  const path = `${TEMPLATES(p.project.id)}/${theirs.id}`;

  for (const [method, body] of [['GET'], ['PATCH', { title: 'Taken over' }], ['DELETE']] as const) {
    const crossed = await call(method, path, p.owner, body);
    expect([crossed.status, messageOf(crossed)], method).toEqual([404, TEMPLATE_NOT_FOUND]);
    expect(crossed.text).not.toContain('Their title');
  }
  expect(await templateRow(theirs.id)).toEqual(before);
  expect(await templateRows(p.project.id)).toHaveLength(0);

  const asOutsider = await call('GET', TEMPLATES(p.project.id), outsider.owner);
  expect([asOutsider.status, messageOf(asOutsider)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(asOutsider.body.data).toBeUndefined();
  const intoTheirs = await call('GET', `${TEMPLATES(other.project.id)}/${theirs.id}`, p.owner);
  expect([intoTheirs.status, messageOf(intoTheirs)]).toEqual([404, PROJECT_NOT_FOUND]);

  // A template id that is not a uuid reaches the database (current behaviour), and the
  // answer carries no detail.
  const malformed = await call('GET', `${TEMPLATES(p.project.id)}/abc`, p.owner);
  expect([malformed.status, messageOf(malformed)]).toEqual([500, 'Internal server error']);
  expect(malformed.text).not.toMatch(/uuid|syntax|postgres|query/i);
});

test('PUSH-226 templates: member and view-as', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const p = await pushProject('push-226', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);

  // The member creates, edits and deletes through the Templates tab.
  const memberDialogs = recordDialogs(page, (type) => type === 'confirm');
  await signIn(page, member);
  await openPush(page, p.project.id, 'Templates');
  await page.getByRole('button', { name: 'New template' }).click();
  let editor = page.getByRole('dialog');
  await field(editor, 'Name *').getByRole('textbox').fill('Member template');
  await field(editor, 'Title *').getByRole('textbox').fill('Hello from a member');
  await editor.getByRole('button', { name: 'Create template' }).click();
  await expect(toastTitled(page, 'Template created')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Member template' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();
  editor = page.getByRole('dialog');
  await field(editor, 'Title *').getByRole('textbox').fill('Edited by a member');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(toastTitled(page, 'Template updated')).toBeVisible();
  await expect(row.getByRole('cell').nth(2)).toHaveText('Edited by a member');
  expect((await templateRows(p.project.id)).map((t) => [t.name, t.title])).toEqual([['Member template', 'Edited by a member']]);
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
  expect(memberDialogs.map((d) => d.type)).toEqual(['confirm']);
  expect(await templateRows(p.project.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'content.deleted')).toHaveLength(1);

  // View-as sees the owner's template, and every write is refused.
  const kept = await createTemplate(p.owner, p.project.id, { name: 'Owner template', title: 'Owner title' });
  const before = await templateRow(kept.id);
  const staff = await signedInStaff(browser, baseURL);
  const viewAsPage = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  recordDialogs(viewAsPage, (type) => type === 'confirm');
  await openViewAs(viewAsPage, await viewAsLink(staff, p.owner));
  await openPush(viewAsPage, p.project.id, 'Templates');
  const ownerRow = viewAsPage.getByRole('row').filter({ hasText: 'Owner template' });
  await expect(ownerRow).toBeVisible();

  await viewAsPage.getByRole('button', { name: 'New template' }).click();
  editor = viewAsPage.getByRole('dialog');
  await field(editor, 'Name *').getByRole('textbox').fill('View-as template');
  await field(editor, 'Title *').getByRole('textbox').fill('Should not save');
  await editor.getByRole('button', { name: 'Create template' }).click();
  await expect(toastBehindDialog(viewAsPage, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(toastBehindDialog(viewAsPage, 'Could not create template')).toContainText(READ_ONLY);
  await editor.getByRole('button', { name: 'Cancel' }).click();

  await ownerRow.getByRole('button', { name: 'Edit' }).click();
  editor = viewAsPage.getByRole('dialog');
  await field(editor, 'Title *').getByRole('textbox').fill('Changed in view-as');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(toastBehindDialog(viewAsPage, 'Could not update template')).toContainText(READ_ONLY);
  await editor.getByRole('button', { name: 'Cancel' }).click();

  await ownerRow.getByRole('button', { name: 'Delete' }).click();
  await expect(toastTitled(viewAsPage, 'Could not delete template')).toContainText(READ_ONLY);
  await expect(ownerRow).toBeVisible();

  expect(await templateRow(kept.id)).toEqual(before);
  expect((await templateRows(p.project.id)).map((t) => t.name)).toEqual(['Owner template']);
  expect(await activityRows(p.project.id, 'content.deleted')).toHaveLength(1);
  await viewAsPage.context().close();
});

// ---------------------------------------------- O. SDK token and event routes ---

test('PUSH-227 register a push token', async () => {
  const p = await pushProject('push-227', { fcm: true });
  const device = await addDevice(p, p.owner.ip, { tokens: 0 });
  const reachBefore = await projectReach(p.owner, p.project.id);
  const token = newToken();

  const registered = await sdkCall(
    'POST',
    '/api/push-tokens/register',
    p.sdkKey,
    { projectId: p.project.id, deviceFingerprint: device.fingerprint, token, platform: 'android' },
    p.owner.ip,
  );
  expect(registered.status).toBe(201);
  expect(dataOf(registered)).toMatchObject({
    projectId: p.project.id,
    deviceIdentityId: device.id,
    token,
    platform: 'android',
    provider: 'fcm',
    isActive: true,
    deactivatedAt: null,
    deactivationReason: null,
  });
  const rows = await tokenRows(p.project.id);
  expect(rows.map((r) => [r.token, r.device_identity_id, r.provider, r.is_active])).toEqual([[token, device.id, 'fcm', true]]);
  expect(await projectReach(p.owner, p.project.id)).toBe(reachBefore + 1);
});

test('PUSH-228 register: API key checks', async () => {
  const p = await pushProject('push-228', { fcm: true });
  const device = await addDevice(p, p.owner.ip, { tokens: 0 });
  const other = await pushProject('push-228-x');
  const privacy = await privacyKey(p.owner, p.project.id);
  const token = newToken();
  const body = { projectId: p.project.id, deviceFingerprint: device.fingerprint, token, platform: 'android' };
  const register = (key: string | null) => sdkCall('POST', '/api/push-tokens/register', key, body, p.owner.ip);

  const none = await register(null);
  expect([none.status, messageOf(none)]).toEqual([401, 'API key is required']);
  const nope = await register('nope');
  expect([nope.status, messageOf(nope)]).toEqual([401, 'Invalid or expired API key']);
  const server = await register(privacy);
  expect([server.status, messageOf(server)]).toEqual([403, SERVER_ONLY_KEY]);
  const foreign = await register(other.sdkKey);
  expect([foreign.status, messageOf(foreign)]).toEqual([403, 'Project mismatch']);
  expect(await tokenRowsByValue(token)).toHaveLength(0);

  // The same body with the project's own key is stored.
  expect((await register(p.sdkKey)).status).toBe(201);
  expect(await tokenRowsByValue(token)).toHaveLength(1);
});

test('PUSH-234 record a push event', async ({ page }) => {
  const p = await pushProject('push-234', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const title = `PUSH-234 ${randomBytes(3).toString('hex')}`;
  const campaignId = await seedSentCampaign(p.project.id, title);
  const occurredAt = new Date(Date.now() - 2 * 3_600_000 - 1234);

  const recorded = await sdkCall(
    'POST',
    '/api/push-notifications/events',
    p.sdkKey,
    { projectId: p.project.id, campaignId, deviceFingerprint: device.fingerprint, type: 'delivered', platform: 'android', occurredAt: occurredAt.toISOString() },
    p.owner.ip,
  );
  expect(recorded.status).toBe(201);
  expect(dataOf(recorded)).toEqual({ recorded: true });
  const events = await eventRows(campaignId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'delivered', device_identity_id: device.id, platform: 'android' });
  // The device's time, not the time the report arrived.
  expect(new Date(events[0].occurred_at).getTime()).toBe(occurredAt.getTime());

  await signIn(page, p.owner);
  await openPush(page, p.project.id);
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row.getByRole('cell').nth(4)).toHaveText('1');
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(figureTile(page, 'Engagement', 'Delivered')).toHaveText('1');
  await expect(figureTile(page, 'Engagement', 'Clicks')).toHaveText('0');
});

test('PUSH-236 event types the SDK may not report', async () => {
  const p = await pushProject('push-236', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const campaignId = await seedSentCampaign(p.project.id);
  const base = { projectId: p.project.id, campaignId, deviceFingerprint: device.fingerprint, type: 'delivered' };
  const post = (body: Record<string, unknown>) => sdkCall('POST', '/api/push-notifications/events', p.sdkKey, { ...base, ...body }, p.owner.ip);
  const TYPE_REFUSED = 'type must be one of the following values: delivered, impression, click, dismissed';

  for (const [body, message] of [
    [{ type: 'sent' }, TYPE_REFUSED],
    [{ type: 'bounced' }, TYPE_REFUSED],
    [{ occurredAt: 'yesterday' }, 'occurredAt must be a valid ISO 8601 date string'],
    [{ metadata: 'x' }, 'metadata must be an object'],
  ] as const) {
    const refused = await post(body);
    expect([refused.status, messageOf(refused)], JSON.stringify(body)).toEqual([400, message]);
  }
  expect(await eventRows(campaignId)).toHaveLength(0);
  // A client report is accepted only as one of the four types.
  expect(dataOf(await post({ type: 'impression' }))).toEqual({ recorded: true });
  expect((await eventRows(campaignId)).map((e) => e.type)).toEqual(['impression']);
});

test('PUSH-237 event scoping and identity', async () => {
  const p = await pushProject('push-237', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const own = await seedSentCampaign(p.project.id);
  const other = await pushProject('push-237-x', { fcm: true });
  await addDevice(other, other.owner.ip);
  const theirs = await seedSentCampaign(other.project.id);
  const event = (body: Record<string, unknown>, key: string | null = p.sdkKey) =>
    sdkCall('POST', '/api/push-notifications/events', key, { projectId: p.project.id, campaignId: own, deviceFingerprint: device.fingerprint, type: 'click', ...body }, p.owner.ip);

  const crossed = await event({ campaignId: theirs });
  expect([crossed.status, messageOf(crossed)]).toEqual([404, CAMPAIGN_NOT_FOUND]);
  const mismatch = await event({ projectId: other.project.id, campaignId: theirs });
  expect([mismatch.status, messageOf(mismatch)]).toEqual([403, 'Project mismatch']);
  const unknown = await event({ deviceFingerprint: `never-identified-${randomBytes(4).toString('hex')}` });
  expect([unknown.status, messageOf(unknown)]).toEqual([404, DEVICE_NOT_FOUND]);
  const noKey = await event({}, null);
  expect([noKey.status, messageOf(noKey)]).toEqual([401, 'API key is required']);

  expect(await eventRows(own)).toHaveLength(0);
  expect(await eventRows(theirs)).toHaveLength(0);
  expect(await touchpointRows(p.project.id, device.fingerprint)).toHaveLength(0);
});

test('PUSH-239 do-not-track device: click kept, touchpoint dropped', async () => {
  const p = await pushProject('push-239', { fcm: true });
  const title = `Spring sale ${randomBytes(2).toString('hex')}`;
  const campaignId = await seedSentCampaign(p.project.id, title);
  const tracked = await addDevice(p, p.owner.ip);
  const dntFingerprint = `push-dnt-${randomBytes(6).toString('hex')}`;
  await api(
    'POST',
    '/api/identity/identify',
    { projectId: p.project.id, deviceFingerprint: dntFingerprint, platform: 'android', doNotTrack: true },
    { apiKey: p.sdkKey, ip: p.owner.ip },
  );
  const click = (deviceFingerprint: string) =>
    sdkCall('POST', '/api/push-notifications/events', p.sdkKey, { projectId: p.project.id, campaignId, deviceFingerprint, type: 'click', platform: 'android' }, p.owner.ip);

  // A tracked device's click credits the campaign with a touchpoint.
  const trackedClick = await click(tracked.fingerprint);
  expect([trackedClick.status, dataOf(trackedClick)]).toEqual([201, { recorded: true }]);
  const credited = await touchpointRows(p.project.id, tracked.fingerprint);
  expect(credited.map((t) => [t.touchpoint_type, t.campaign, t.metadata])).toEqual([['push_click', title, { campaignId }]]);

  const dntClick = await click(dntFingerprint);
  expect([dntClick.status, dataOf(dntClick)]).toEqual([201, { recorded: true }]);
  expect(await touchpointRows(p.project.id, dntFingerprint)).toHaveLength(0);
  const report = dataOf(await call('GET', `/api/push-notifications/report/${p.project.id}/${campaignId}`, p.owner));
  expect(report.clicks).toBe(2);
  expect((await eventRows(campaignId)).filter((e) => e.type === 'click')).toHaveLength(2);
});

// --------------------------------------------------------- P. Cross-cutting ---

test('PUSH-241 every dashboard push route needs a signed-in user', async () => {
  const p = await pushProject('push-241', { fcm: true });
  const device = await addDevice(p, p.owner.ip, { distinctId: `push-241-${randomBytes(3).toString('hex')}` });
  const campaignId = await scheduleCampaign(p, 'Stays scheduled').then((c) => c.id);
  const template = await createTemplate(p.owner, p.project.id, { name: 'Kept', title: 'Kept' });
  const pid = p.project.id;
  const routes: Array<[string, string, unknown?]> = [
    ['GET', `/api/push-notifications/experiment/${pid}/${campaignId}`],
    ['GET', `/api/push-notifications/report/${pid}/${campaignId}`],
    ['POST', '/api/push-notifications/configure', { projectId: pid, fcmServiceAccountJson: JSON.stringify(fakeServiceAccount()) }],
    ['POST', '/api/push-notifications/audience-preview', { projectId: pid }],
    ['POST', '/api/push-notifications/test-send', { projectId: pid, token: device.tokens[0] }],
    ['POST', '/api/push-notifications/settings', { projectId: pid, frequencyCapPerDay: 3 }],
    ['GET', `/api/push-notifications/reachability/${pid}`],
    ['POST', '/api/push-notifications/channels/credentials', { projectId: pid, provider: 'mi_push', credentials: '{}' }],
    ['GET', `/api/push-notifications/channels/${pid}`],
    ['GET', `/api/push-notifications/history/${pid}/${device.id}`],
    ['GET', `/api/push-notifications/config-status/${pid}`],
    ['POST', '/api/push-notifications/send', { projectId: pid, title: 'Anonymous' }],
    ['POST', '/api/push-notifications/send-to-user', { projectId: pid, distinctId: 'x', title: 'Anonymous' }],
    ['POST', `/api/push-notifications/cancel/${pid}/${campaignId}`],
    ['GET', `/api/push-notifications/campaign/${pid}/${campaignId}`],
    ['GET', `/api/push-notifications/logs/${pid}`],
    ['GET', TEMPLATES(pid)],
    ['POST', TEMPLATES(pid), { name: 'Anonymous', title: 'Anonymous' }],
    ['GET', `${TEMPLATES(pid)}/${template.id}`],
    ['PATCH', `${TEMPLATES(pid)}/${template.id}`, { title: 'Anonymous' }],
    ['DELETE', `${TEMPLATES(pid)}/${template.id}`],
  ];
  for (const [method, path, body] of routes) {
    const anonymous = await call(method, path, null, body);
    expect(anonymous.status, `${method} ${path}`).toBe(401);
    expect(anonymous.body?.data, `${method} ${path}`).toBeUndefined();
    // The project's SDK key is no dashboard credential either.
    const withKey = await sdkCall(method, path, p.sdkKey, body);
    expect(withKey.status, `${method} ${path} with an SDK key`).toBe(401);
  }

  expect((await campaignRows(pid)).map((c) => [c.title, c.status])).toEqual([['Stays scheduled', 'scheduled']]);
  expect((await templateRows(pid)).map((t) => t.title)).toEqual(['Kept']);
  expect((await pushConfigRow(pid))?.frequency_cap_per_day ?? null).toBeNull();
  expect((await credentialRows(pid)).map((r) => r.provider)).toEqual(['fcm']);
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);
});

test('PUSH-242 role refusals per route', async () => {
  const p = await pushProject('push-242', { fcm: true });
  const member = await teammate(p.project.id, 'member', p.owner);
  const distinctId = `push-242-${randomBytes(3).toString('hex')}`;
  const device = await addDevice(p, p.owner.ip, { distinctId });
  const sent = await seedSentCampaign(p.project.id, 'Sent earlier');
  const scheduled = await scheduleCampaign(p, 'Member cancels this');
  const pid = p.project.id;

  for (const [path, body] of [
    ['/api/push-notifications/configure', { projectId: pid, fcmServiceAccountJson: JSON.stringify(fakeServiceAccount()) }],
    ['/api/push-notifications/settings', { projectId: pid, frequencyCapPerDay: 3 }],
    [
      '/api/push-notifications/channels/credentials',
      { projectId: pid, provider: 'mi_push', credentials: JSON.stringify({ appSecret: 's3cret', packageName: 'com.example.e2e', region: 'global' }) },
    ],
  ] as const) {
    const refused = await call('POST', path, member, body);
    expect([refused.status, messageOf(refused)], path).toEqual([403, ROLE_REFUSAL]);
  }
  expect((await credentialRows(pid)).map((r) => r.provider)).toEqual(['fcm']);
  expect((await pushConfigRow(pid))?.frequency_cap_per_day ?? null).toBeNull();

  const reads: string[] = [
    `/api/push-notifications/experiment/${pid}/${sent}`,
    `/api/push-notifications/report/${pid}/${sent}`,
    `/api/push-notifications/campaign/${pid}/${sent}`,
    `/api/push-notifications/logs/${pid}`,
    `/api/push-notifications/config-status/${pid}`,
    `/api/push-notifications/channels/${pid}`,
    `/api/push-notifications/reachability/${pid}`,
    `/api/push-notifications/history/${pid}/${device.id}`,
    TEMPLATES(pid),
  ];
  for (const path of reads) {
    expect((await call('GET', path, member)).status, path).toBe(200);
  }

  const writes: Array<[string, unknown]> = [
    ['/api/push-notifications/audience-preview', { projectId: pid }],
    ['/api/push-notifications/test-send', { projectId: pid, token: device.tokens[0], dryRun: true }],
    ['/api/push-notifications/send', { projectId: pid, title: 'From a member', scheduledAt: inAMonth().toISOString() }],
    ['/api/push-notifications/send-to-user', { projectId: pid, distinctId, title: 'To one person' }],
    [`/api/push-notifications/cancel/${pid}/${scheduled.id}`, undefined],
  ];
  for (const [path, body] of writes) {
    expect((await call('POST', path, member, body)).status, path).toBe(201);
  }
  const created = await call('POST', TEMPLATES(pid), member, { name: 'Member template', title: 'Member title' });
  expect(created.status).toBe(201);
  const templateId = dataOf(created).id;
  expect((await call('GET', `${TEMPLATES(pid)}/${templateId}`, member)).status).toBe(200);
  expect((await call('PATCH', `${TEMPLATES(pid)}/${templateId}`, member, { title: 'Edited' })).status).toBe(200);
  expect((await call('DELETE', `${TEMPLATES(pid)}/${templateId}`, member)).status).toBe(200);

  expect((await campaignRow(scheduled.id))?.status).toBe('cancelled');
  expect((await campaignRows(pid)).map((c) => c.title).sort()).toEqual(['From a member', 'Member cancels this', 'Sent earlier', 'To one person']);
});

test('PUSH-243 body project id is the one checked', async () => {
  const p = await pushProject('push-243', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const other = await pushProject('push-243-x', { fcm: true });
  await addDevice(other, other.owner.ip);
  const configBefore = await pushConfigRow(other.project.id);

  for (const [path, body] of [
    ['/api/push-notifications/send', { projectId: other.project.id, title: 'Into another tenant' }],
    ['/api/push-notifications/audience-preview', { projectId: other.project.id }],
    ['/api/push-notifications/test-send', { projectId: other.project.id, token: device.tokens[0] }],
    ['/api/push-notifications/settings', { projectId: other.project.id, frequencyCapPerDay: 1 }],
  ] as const) {
    const refused = await call('POST', path, p.owner, body);
    expect([refused.status, messageOf(refused)], path).toEqual([404, PROJECT_NOT_FOUND]);
    expect(refused.body.data, path).toBeUndefined();
  }
  expect(await campaignRows(other.project.id)).toHaveLength(0);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  expect(await pushConfigRow(other.project.id)).toEqual(configBefore);
  expect(await activityRows(other.project.id, 'channel.settings_changed')).toHaveLength(0);
  expect(await fcmSendsFor(other.fcm!.project_id)).toHaveLength(0);
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);
});

test('PUSH-244 view-as is read-only across push', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  const p = await pushProject('push-244', { fcm: true });
  const device = await addDevice(p, p.owner.ip);
  const scheduled = await scheduleCampaign(p, 'Scheduled in view-as');
  const sentId = await seedSentCampaign(p.project.id, 'Sent in view-as');
  const template = await createTemplate(p.owner, p.project.id, { name: 'View-as template', title: 'Template title' });
  expect((await call('POST', '/api/push-notifications/settings', p.owner, { projectId: p.project.id, frequencyCapPerDay: 2 })).status).toBe(201);
  const joined = await pushProject('push-244-j', { fcm: true });
  await addMember(joined.project.id, p.owner, 'admin', joined.owner);
  await seedSentCampaign(joined.project.id, 'Joined project campaign');
  const configBefore = await pushConfigRow(p.project.id);
  const credentialsBefore = await credentialRows(p.project.id);
  const activityBefore = await sql(`SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1 AND action <> 'staff.viewed_as'`, [p.project.id]);
  const staff = await signedInStaff(browser, baseURL);
  recordDialogs(page, (type) => type === 'confirm');

  await openViewAs(page, await viewAsLink(staff, p.owner));
  // The list and a sent campaign's report render.
  await openPush(page, p.project.id);
  await expect(page.getByRole('row').filter({ hasText: 'Sent in view-as' })).toBeVisible();
  await page.getByRole('row').filter({ hasText: 'Scheduled in view-as' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Scheduled in view-as', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(toastBehindDialog(page, 'Read-only session').first()).toContainText(READ_ONLY);
  await expect(toastBehindDialog(page, 'Error')).toContainText(READ_ONLY);
  await page.goto(`/projects/${p.project.id}/push-notifications/${sentId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sent in view-as', exact: true })).toBeVisible();
  await expect(card(page, 'Engagement')).toBeVisible();

  // Templates.
  await openPush(page, p.project.id, 'Templates');
  const templateRowLocator = page.getByRole('row').filter({ hasText: 'View-as template' });
  await expect(templateRowLocator).toBeVisible();
  await page.getByRole('button', { name: 'New template' }).click();
  const editor = page.getByRole('dialog');
  await field(editor, 'Name *').getByRole('textbox').fill('Made in view-as');
  await field(editor, 'Title *').getByRole('textbox').fill('Made in view-as');
  await editor.getByRole('button', { name: 'Create template' }).click();
  await expect(toastBehindDialog(page, 'Could not create template')).toContainText(READ_ONLY);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await templateRowLocator.getByRole('button', { name: 'Delete' }).click();
  await expect(toastTitled(page, 'Could not delete template')).toContainText(READ_ONLY);

  // Settings: status, guardrails, Mi Push, FCM replacement and test send.
  await openPush(page, p.project.id, 'Settings');
  await expect(statusValue(page, 'Service account')).toHaveText(HIDDEN);
  const guardrails = card(page, 'Delivery guardrails');
  await field(guardrails, 'Maximum campaigns per device, per day').getByRole('spinbutton').fill('7');
  await guardrails.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toastTitled(page, 'Could not save')).toContainText(READ_ONLY);

  const channels = card(page, 'Delivery channels');
  await field(channels, 'App secret').locator('input').fill('view-as-secret');
  await field(channels, 'Package name').getByRole('textbox').fill('com.example.viewas');
  await channels.getByRole('button', { name: 'Save Mi Push credentials' }).click();
  await expect(channels.getByText(READ_ONLY, { exact: true })).toBeVisible();

  const replace = card(page, 'Replace credentials');
  await field(replace, 'Service account JSON').getByRole('textbox').fill(JSON.stringify(fakeServiceAccount()));
  await replace.getByRole('button', { name: 'Save and replace' }).click();
  await expect(replace.getByText(READ_ONLY, { exact: true })).toBeVisible();

  const testSend = card(page, 'Test send');
  await field(testSend, 'Device registration token').getByRole('textbox').fill(device.tokens[0]);
  await testSend.getByRole('button', { name: 'Deliver' }).click();
  await expect(testSend.getByText(READ_ONLY, { exact: true })).toBeVisible();

  // Composer: the reach preview is a write, so it is refused too.
  const [preview] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/push-notifications/audience-preview')),
    page.goto(`/projects/${p.project.id}/push-notifications/new`),
  ]);
  expect(preview.status()).toBe(403);
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

  // Nothing changed.
  expect((await campaignRow(scheduled.id))?.status).toBe('scheduled');
  expect((await campaignRows(p.project.id)).map((c) => c.title).sort()).toEqual(['Scheduled in view-as', 'Sent in view-as']);
  expect((await templateRows(p.project.id)).map((t) => t.id)).toEqual([template.id]);
  expect(await pushConfigRow(p.project.id)).toEqual(configBefore);
  expect(await credentialRows(p.project.id)).toEqual(credentialsBefore);
  expect(await sql(`SELECT count(*)::int AS n FROM project_activity WHERE project_id = $1 AND action <> 'staff.viewed_as'`, [p.project.id])).toEqual(activityBefore);
  expect(await fcmSendsFor(p.fcm!.project_id)).toHaveLength(0);

  // View-as reaches only projects billed to the tenant, not ones they joined.
  const viewAs = await viewAsCaller(staff, p.owner);
  expect((await call('GET', `/api/push-notifications/logs/${p.project.id}`, viewAs)).status).toBe(200);
  const joinedLogs = await call('GET', `/api/push-notifications/logs/${joined.project.id}`, viewAs);
  expect([joinedLogs.status, messageOf(joinedLogs)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(joinedLogs.text).not.toContain('Joined project campaign');
});

// ---------------------------------------------------- Q. Coverage additions ---

test('PUSH-247 unregister with no token must not touch other tokens', async ({ page }) => {
  const p = await pushProject('push-247', { fcm: true });
  for (let i = 0; i < 3; i++) await addDevice(p, p.owner.ip);
  const reachability = async () => dataOf(await call('GET', `/api/push-notifications/reachability/${p.project.id}`, p.owner));
  expect(await projectReach(p.owner, p.project.id)).toBe(3);
  expect(await reachability()).toMatchObject({ activeTokens: 3, appRequested: 0 });

  const unregistered = await sdkCall('DELETE', `/api/push-tokens/unregister?projectId=${p.project.id}`, p.sdkKey, undefined, p.owner.ip);
  expect(unregistered.status).toBe(200);
  expect(dataOf(unregistered)).toEqual({ success: true });

  expect(await projectReach(p.owner, p.project.id)).toBe(3);
  expect(await reachability()).toMatchObject({ activeTokens: 3, appRequested: 0, providerRejected: 0 });
  const rows = await tokenRows(p.project.id);
  expect(rows).toHaveLength(3);
  for (const row of rows) expect([row.is_active, row.deactivation_reason, row.deactivated_at]).toEqual([true, null, null]);

  await signIn(page, p.owner);
  await openPush(page, p.project.id, 'Settings');
  await expect(statusValue(page, 'Active tokens')).toHaveText('3');
  await expect(statusValue(page, 'Logouts / opt-outs')).toHaveText('0');
});

test('PUSH-250 token rows belong to one project', async () => {
  const p = await pushProject('push-250', { fcm: true });
  const other = await pushProject('push-250-x', { fcm: true });
  const fingerprint = `fp-shared-${randomBytes(6).toString('hex')}`;
  const token = newToken();
  for (const project of [p, other]) {
    await api(
      'POST',
      '/api/identity/identify',
      { projectId: project.project.id, deviceFingerprint: fingerprint, platform: 'android' },
      { apiKey: project.sdkKey, ip: project.owner.ip },
    );
    const registered = await sdkCall(
      'POST',
      '/api/push-tokens/register',
      project.sdkKey,
      { projectId: project.project.id, deviceFingerprint: fingerprint, token, platform: 'android' },
      project.owner.ip,
    );
    expect(registered.status).toBe(201);
  }
  const byProject = async () =>
    Object.fromEntries((await tokenRowsByValue(token)).map((r) => [r.project_id, [r.is_active, r.deactivation_reason]]));
  expect((await tokenRowsByValue(token)).map((r) => r.id)).toHaveLength(2);
  expect(await byProject()).toEqual({ [p.project.id]: [true, null], [other.project.id]: [true, null] });

  const query = (projectId: string) => `/api/push-tokens/unregister?${new URLSearchParams({ projectId, token })}`;
  const own = await sdkCall('DELETE', query(p.project.id), p.sdkKey, undefined, p.owner.ip);
  expect([own.status, dataOf(own)]).toEqual([200, { success: true }]);
  expect(await byProject()).toEqual({ [p.project.id]: [false, 'app_requested'], [other.project.id]: [true, null] });
  expect(await projectReach(other.owner, other.project.id)).toBe(1);
  expect(await projectReach(p.owner, p.project.id)).toBe(0);

  const crossed = await sdkCall('DELETE', query(other.project.id), p.sdkKey, undefined, p.owner.ip);
  expect([crossed.status, messageOf(crossed)]).toEqual([403, 'Project mismatch']);
  expect(await byProject()).toEqual({ [p.project.id]: [false, 'app_requested'], [other.project.id]: [true, null] });
});

test('PUSH-260 a second project id in the query is checked too', async () => {
  const p = await pushProject('push-260', { fcm: true });
  await addDevice(p, p.owner.ip);
  const other = await pushProject('push-260-x', { fcm: true });
  await addDevice(other, other.owner.ip);
  const both = await newPerson('push-260-m', 'Mo Both');
  await addMember(p.project.id, both, 'member', p.owner);
  await addMember(other.project.id, both, 'member', other.owner);
  const send = (as: Caller) =>
    call('POST', `/api/push-notifications/send?projectId=${other.project.id}`, as, {
      projectId: p.project.id,
      title: 'Second project id',
      scheduledAt: inAMonth().toISOString(),
    });

  const refused = await send(p.owner);
  expect([refused.status, messageOf(refused)]).toEqual([404, PROJECT_NOT_FOUND]);
  const logs = await call('GET', `/api/push-notifications/logs/${p.project.id}?projectId=${other.project.id}`, p.owner);
  expect([logs.status, messageOf(logs)]).toEqual([404, PROJECT_NOT_FOUND]);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  expect(await campaignRows(other.project.id)).toHaveLength(0);

  const accepted = await send(both);
  expect(accepted.status).toBe(201);
  expect(dataOf(accepted).projectId).toBe(p.project.id);
  expect((await campaignRows(p.project.id)).map((c) => c.title)).toEqual(['Second project id']);
  expect(await campaignRows(other.project.id)).toHaveLength(0);
});

test('PUSH-305 a non-member opens push pages by URL', async ({ page }) => {
  const p = await pushProject('push-305', { fcm: true });
  const campaignId = await seedSentCampaign(p.project.id, 'Not for outsiders');
  const outsider = await pushProject('push-305-o');

  const pushRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/push-notifications/') || url.includes(`/api/projects/${p.project.id}/push-templates`)) pushRequests.push(url);
  });
  await signIn(page, outsider.owner);
  for (const path of [`/projects/${p.project.id}/push-notifications`, `/projects/${p.project.id}/push-notifications/${campaignId}`]) {
    const [projectAnswer] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.project.id}`)),
      page.goto(path),
    ]);
    expect(projectAnswer.status(), path).toBe(404);
    expect((await projectAnswer.json()).message).toBe(PROJECT_NOT_FOUND);
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();
    await expect(page.getByText('Not for outsiders')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Push Notifications', exact: true })).toHaveCount(0);
  }
  expect(pushRequests).toEqual([]);
});
