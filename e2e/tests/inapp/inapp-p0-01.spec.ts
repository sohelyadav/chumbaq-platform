import { randomUUID } from 'crypto';
import { expect, signIn, test } from '../../support/fixtures';
import {
  activityRows,
  API_KEY_REQUIRED,
  BACKGROUND_REFUSED,
  call,
  campaignRow,
  checkMessages,
  createInAppMessage,
  createPrivacyKey,
  createRevokedKey,
  dataOf,
  deliveredIds,
  detailBadge,
  dismissToasts,
  EDITOR_DEFAULT_THEME,
  editorField,
  fingerprint,
  identifyDevice,
  identitySecret,
  IMAGE_URL_REFUSED,
  impressionRows,
  inAppProject,
  INVALID_API_KEY,
  MESSAGE_NOT_FOUND,
  messageActivity,
  messageIn,
  messageOf,
  messageRow,
  messageRows,
  openInAppList,
  pendingRows,
  PRIVACY_KEY_REFUSED,
  PROJECT_MISMATCH,
  reactivateAccount,
  recordInAppEvent,
  refuseDialogs,
  rowMenuItem,
  seedCohort,
  setMessageStatus,
  sql,
  suspendAccount,
  teammate,
  toastTitled,
  traitSegment,
  triggerFor,
  userHash,
} from '../../support/areas/inapp';

/**
 * In-app messages: the campaign list's row actions, the editor's create and its
 * validation, the detail page's activate, pause and Trigger Now, the lifecycle routes
 * and their activity entries, and the SDK's check and event routes (keys, project
 * scope, targeting, the trigger queue, suspension and do-not-track).
 */

const MESSAGES = (projectId: string) => `/api/projects/${projectId}/in-app-messages`;

// ------------------------------------------------------------ A. Campaign list ---

test('INAPP-019 activate from the list', async ({ page }) => {
  const p = await inAppProject('inapp-019');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Welcome modal' });
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  const row = campaignRow(page, 'Welcome modal');
  await expect(row.getByText('Draft', { exact: true })).toBeVisible();

  const activated = page.waitForResponse((r) => r.url().endsWith(`/in-app-messages/${message.id}/activate`) && r.request().method() === 'POST');
  await rowMenuItem(page, 'Welcome modal', 'Activate');
  const response = await activated;
  expect(response.status()).toBe(201);
  expect((await response.json()).data.status).toBe('active');

  await expect(toastTitled(page, 'Campaign activated')).toBeVisible();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  expect((await messageRow(message.id))?.status).toBe('active');

  const entries = await activityRows(p.project.id, 'in_app_message.activated');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ actor_user_id: p.owner.userId, target_id: message.id, target_label: 'Welcome modal' });

  // The log shows the entry as a sentence.
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('activated the in-app message "Welcome modal"')).toBeVisible();
});

test('INAPP-020 pause from the list', async ({ page }) => {
  const p = await inAppProject('inapp-020');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Live promo' });
  const device = await identifyDevice(p);
  expect(await deliveredIds(p, device.fingerprint)).toContain(message.id);

  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  const row = campaignRow(page, 'Live promo');
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  await rowMenuItem(page, 'Live promo', 'Pause');

  await expect(toastTitled(page, 'Campaign paused')).toBeVisible();
  await expect(row.getByText('Paused', { exact: true })).toBeVisible();
  const entries = await activityRows(p.project.id, 'in_app_message.paused');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ actor_user_id: p.owner.userId, target_label: 'Live promo', details: null });

  expect(await deliveredIds(p, device.fingerprint)).not.toContain(message.id);

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('paused the in-app message "Live promo"')).toBeVisible();
});

test('INAPP-025 delete a draft from the list', async ({ page }) => {
  const p = await inAppProject('inapp-025');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Old promo' });
  const device = await identifyDevice(p);
  dataOf(await recordInAppEvent(p, { messageId: message.id, deviceFingerprint: device.fingerprint, eventType: 'impression' }));
  dataOf(await recordInAppEvent(p, { messageId: message.id, deviceFingerprint: device.fingerprint, eventType: 'dismiss' }));
  await triggerFor(p.owner, p.project.id, message.id, [fingerprint('queued')]);
  expect(await impressionRows(message.id)).toHaveLength(2);
  expect(await pendingRows(message.id)).toHaveLength(1);

  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  const prompts: string[] = [];
  page.once('dialog', async (dialog) => {
    prompts.push(dialog.message());
    await dialog.accept();
  });
  const deleted = page.waitForResponse((r) => r.url().endsWith(`/in-app-messages/${message.id}`) && r.request().method() === 'DELETE');
  await rowMenuItem(page, 'Old promo', 'Delete');
  const response = await deleted;

  expect(prompts).toEqual(['Are you sure you want to delete this campaign?']);
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toEqual({ deleted: true });
  await expect(toastTitled(page, 'Campaign deleted')).toBeVisible();
  await expect(campaignRow(page, 'Old promo')).toHaveCount(0);

  expect(await messageRow(message.id)).toBeUndefined();
  expect(await impressionRows(message.id)).toHaveLength(0);
  expect(await pendingRows(message.id)).toHaveLength(0);
  const entries = await activityRows(p.project.id, 'content.deleted');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    actor_user_id: p.owner.userId,
    target_type: 'in_app_message',
    target_id: message.id,
    target_label: 'Old promo',
    details: { kind: 'in_app_message' },
  });

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('deleted the in-app message "Old promo"')).toBeVisible();
});

test('INAPP-029 names and titles with markup show as text', async ({ page }) => {
  const p = await inAppProject('inapp-029');
  const name = '<img src=x onerror=alert(1)>';
  const title = '<b>bold</b>';
  const message = await createInAppMessage(p.owner, p.project.id, { name, title });
  const dialogs = refuseDialogs(page);
  await signIn(page, p.owner);

  const noMarkup = async () => {
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator('b', { hasText: 'bold' })).toHaveCount(0);
  };

  await openInAppList(page, p.project.id);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await noMarkup();

  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: title, exact: true })).toBeVisible();
  await noMarkup();

  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}/edit`);
  await expect(editorField(page, 'Campaign Name')).toHaveValue(name);
  await expect(editorField(page, 'Title *')).toHaveValue(title);
  // The editor's header repeats the name, and the live preview the title, as text.
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await noMarkup();

  expect(dialogs).toEqual([]);
});

// ------------------------------------------------------------ C. Editor step 1 ---

test('INAPP-049 create a minimal campaign', async ({ page }) => {
  const p = await inAppProject('inapp-049');
  await signIn(page, p.owner);
  await openInAppList(page, p.project.id);
  await page.getByRole('button', { name: 'New Campaign', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages/new$`));

  await editorField(page, 'Campaign Name').fill('Welcome modal');
  await editorField(page, 'Title *').fill('Welcome');
  const activityBefore = (await activityRows(p.project.id)).length;
  await page.getByRole('button', { name: 'Save Campaign', exact: true }).click();

  await expect(toastTitled(page, 'Campaign created')).toBeVisible();
  await page.waitForURL(new RegExp(`/projects/${p.project.id}/in-app-messages/[0-9a-f-]{36}$`));
  const id = page.url().split('/').pop()!;

  const stored = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${id}`, p.owner));
  expect(stored).toMatchObject({
    name: 'Welcome modal',
    title: 'Welcome',
    status: 'draft',
    messageType: 'modal',
    triggerType: 'on_app_open',
    userType: 'all',
    priority: 0,
    triggerDelaySeconds: 0,
    dismissOnTapOutside: true,
    body: null,
    imageUrl: null,
    tags: null,
  });
  expect(stored.theme).toEqual(EDITOR_DEFAULT_THEME);
  expect((await messageRow(id))?.created_by).toBe(p.owner.userId);
  // Creating is not logged: the project's log is as long as before the save.
  expect(await activityRows(p.project.id)).toHaveLength(activityBefore);

  // The editor's address was replaced, so Back goes to the list, not to /new.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/in-app-messages$`));
  await expect(campaignRow(page, 'Welcome modal')).toBeVisible();
});

test('INAPP-053 image URL must be an http(s) URL', async ({ page }) => {
  const p = await inAppProject('inapp-053');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/new`);
  await editorField(page, 'Campaign Name').fill('Image check');
  await editorField(page, 'Title *').fill('Has a picture');

  const save = async (imageUrl: string) => {
    await dismissToasts(page);
    await editorField(page, 'Image URL').fill(imageUrl);
    const answered = page.waitForResponse((r) => r.url().endsWith(MESSAGES(p.project.id)) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save Campaign', exact: true }).click();
    return answered;
  };

  for (const bad of [
    'javascript:alert(document.domain)',
    'x" onerror="alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    '/local/promo.png',
    'example.com/promo.png',
  ]) {
    const response = await save(bad);
    expect(response.status(), bad).toBe(400);
    expect((await response.json()).message, bad).toContain(IMAGE_URL_REFUSED);
    await expect(toastTitled(page, 'Failed to save'), bad).toHaveCount(1);
  }
  expect(await messageRows(p.project.id)).toEqual([]);

  const accepted = await save('http://assets.local/p.png');
  expect(accepted.status()).toBe(201);
  await expect(toastTitled(page, 'Campaign created')).toBeVisible();
  const rows = await messageRows(p.project.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].image_url).toBe('http://assets.local/p.png');
});

test('INAPP-062 theme colour validation refuses anything else', async ({ page }) => {
  const p = await inAppProject('inapp-062');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/new`);
  await editorField(page, 'Campaign Name').fill('Colour check');
  await editorField(page, 'Title *').fill('Colourful');

  for (const bad of ['red', '#fff" onmouseover="alert(1)', 'red; background-image: url(//evil/pixel)', 'url(//evil/pixel)', 'hsl(0,0%,0%)']) {
    await dismissToasts(page);
    await editorField(page, 'Background').fill(bad);
    const answered = page.waitForResponse((r) => r.url().endsWith(MESSAGES(p.project.id)) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save Campaign', exact: true }).click();
    const response = await answered;
    expect(response.status(), bad).toBe(400);
    expect((await response.json()).message, bad).toContain(BACKGROUND_REFUSED);
    await expect(toastTitled(page, 'Failed to save'), bad).toHaveCount(1);
  }
  expect(await messageRows(p.project.id)).toEqual([]);
});

// ------------------------------------------------------------ F. Campaign detail ---

test('INAPP-094 activate on the detail page', async ({ page }) => {
  const p = await inAppProject('inapp-094');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Detail activate' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  await expect(detailBadge(page, 'Detail activate').getByText('Draft', { exact: true })).toBeVisible();

  const activated = page.waitForResponse((r) => r.url().endsWith(`/in-app-messages/${message.id}/activate`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  const response = await activated;
  expect(response.status()).toBe(201);
  expect((await response.json()).data.status).toBe('active');
  expect(await activityRows(p.project.id, 'in_app_message.activated')).toHaveLength(1);

  // Expected (current code): no toast, and the page keeps the old status until a reload.
  // Nothing on the page changes to wait for, so it is given a moment to show a toast.
  await page.waitForTimeout(1000);
  await expect(toastTitled(page, 'Campaign activated')).toHaveCount(0);
  await expect(detailBadge(page, 'Detail activate').getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate', exact: true })).toBeVisible();

  await page.reload();
  await expect(detailBadge(page, 'Detail activate').getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate', exact: true })).toHaveCount(0);
});

test('INAPP-095 pause on the detail page', async ({ page }) => {
  const p = await inAppProject('inapp-095');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Detail pause' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  await expect(detailBadge(page, 'Detail pause').getByText('Active', { exact: true })).toBeVisible();

  const paused = page.waitForResponse((r) => r.url().endsWith(`/in-app-messages/${message.id}/pause`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const response = await paused;
  expect(response.status()).toBe(201);
  expect((await response.json()).data.status).toBe('paused');
  const entries = await activityRows(p.project.id, 'in_app_message.paused');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ target_id: message.id, target_label: 'Detail pause', actor_user_id: p.owner.userId });

  await page.reload();
  await expect(detailBadge(page, 'Detail pause').getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
});

test('INAPP-109 message from another project', async ({ page }) => {
  const p = await inAppProject('inapp-109');
  const p2 = await inAppProject('inapp-109-b', p.owner);
  const m2 = await messageIn(p.owner, p2.project.id, 'active', { name: 'Other project message' });
  const device = await identifyDevice(p2);
  dataOf(await recordInAppEvent(p2, { messageId: m2.id, deviceFingerprint: device.fingerprint, eventType: 'impression' }));
  dataOf(await recordInAppEvent(p2, { messageId: m2.id, deviceFingerprint: device.fingerprint, eventType: 'click', buttonId: 'go' }));

  const got = await call('GET', `${MESSAGES(p.project.id)}/${m2.id}`, p.owner);
  expect(got.status).toBe(404);
  expect(messageOf(got)).toBe(MESSAGE_NOT_FOUND);

  const foreign = dataOf(await call('GET', `${MESSAGES(p.project.id)}/${m2.id}/analytics`, p.owner));
  expect(foreign).toMatchObject({ totalImpressions: 0, totalClicks: 0, uniqueUsers: 0, clickRate: 0 });
  // Under its own project the same message has the numbers.
  const own = dataOf(await call('GET', `${MESSAGES(p2.project.id)}/${m2.id}/analytics`, p.owner));
  expect(own).toMatchObject({ totalImpressions: 1, totalClicks: 1, uniqueUsers: 1 });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${m2.id}`);
  await expect(page.getByText('Campaign not found.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Other project message')).toHaveCount(0);
});

// ------------------------------------------------------------ G. Trigger Now ---

test('INAPP-111 trigger to all users', async ({ page }) => {
  const p = await inAppProject('inapp-111');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Flash sale', triggerType: 'immediate' });
  const devices = [];
  for (const label of ['fp-d1', 'fp-d2', 'fp-d3', 'fp-d4', 'fp-d5']) devices.push(await identifyDevice(p, {}, label));

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/in-app-messages/${message.id}`);
  await page.getByRole('button', { name: 'Trigger Now', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trigger Message Now' });
  await expect(dialog.getByText('Push "Flash sale" to users immediately. Select target:')).toBeVisible();
  await dialog.getByRole('button', { name: 'All Users', exact: true }).click();

  await expect(toastTitled(page, 'Queued for 5 devices')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const rows = await pendingRows(message.id);
  expect(rows.map((r) => r.device_fingerprint).sort()).toEqual(devices.map((d) => d.fingerprint).sort());
  for (const row of rows) {
    expect(row.status).toBe('pending');
    const hoursAhead = (new Date(row.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(hoursAhead).toBeGreaterThan(23.9);
    expect(hoursAhead).toBeLessThanOrEqual(24);
  }
  const entries = await activityRows(p.project.id, 'in_app.triggered');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ actor_user_id: p.owner.userId, target_id: message.id, target_label: 'Flash sale' });
  const [order] = await sql(
    `SELECT bool_and(a.occurred_at <= q.created_at) AS before
       FROM project_activity a, pending_in_app_messages q
      WHERE a.id = $1 AND q.message_id = $2`,
    [entries[0].id, message.id],
  );
  expect(order.before).toBe(true);

  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('triggered the in-app message "Flash sale"')).toBeVisible();
});

test('INAPP-120 trigger an unknown or foreign message', async () => {
  const p = await inAppProject('inapp-120');
  const other = await inAppProject('inapp-120-other');
  const m2 = await messageIn(other.owner, other.project.id, 'active', { triggerType: 'immediate' });
  await identifyDevice(p);

  for (const messageId of [m2.id, randomUUID()]) {
    const result = await call('POST', `${MESSAGES(p.project.id)}/trigger`, p.owner, { messageId, targetType: 'all' });
    expect(result.status, messageId).toBe(404);
    expect(messageOf(result)).toBe(MESSAGE_NOT_FOUND);
  }
  expect(await pendingRows(m2.id)).toHaveLength(0);
  expect(await activityRows(p.project.id, 'in_app.triggered')).toHaveLength(0);
  expect(await activityRows(other.project.id, 'in_app.triggered')).toHaveLength(0);
});

// ------------------------------------------------------------ H. Messages API ---

test('INAPP-127 PATCH status transitions and their log entries', async ({ page }) => {
  const p = await inAppProject('inapp-127');
  const member = await teammate(p.project.id, 'member', p.owner);
  const message = await createInAppMessage(member, p.project.id, { name: 'Summer modal' });

  const steps: Array<{ to: string; expect: { action: string; details: Record<string, unknown> | null } | null }> = [
    { to: 'active', expect: { action: 'in_app_message.activated', details: null } },
    { to: 'archived', expect: { action: 'in_app_message.paused', details: { to: 'archived' } } },
    { to: 'active', expect: { action: 'in_app_message.activated', details: null } },
    { to: 'paused', expect: { action: 'in_app_message.paused', details: null } },
    { to: 'completed', expect: null },
    { to: 'draft', expect: null },
  ];
  let seen = 0;
  for (const step of steps) {
    const updated = await setMessageStatus(member, p.project.id, message.id, step.to);
    expect(updated.status).toBe(step.to);
    const entries = await messageActivity(p.project.id);
    if (step.expect) {
      expect(entries, `after ${step.to}`).toHaveLength(seen + 1);
      expect(entries[seen]).toMatchObject({
        action: step.expect.action,
        details: step.expect.details,
        actor_user_id: member.userId,
        target_id: message.id,
        target_label: 'Summer modal',
      });
      seen += 1;
    } else {
      expect(entries, `after ${step.to}`).toHaveLength(seen);
    }
  }

  // The owner reads the archive as a pause with where it went.
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/activity`);
  await expect(page.getByText('paused the in-app message "Summer modal" (now archived)')).toBeVisible();
});

test('INAPP-129 PATCH validation applies the create rules', async () => {
  const p = await inAppProject('inapp-129');
  const message = await createInAppMessage(p.owner, p.project.id, {
    name: 'Validated',
    imageUrl: 'https://example.com/a.png',
    theme: { backgroundColor: '#ffffff' },
    buttons: [{ id: 'ok', text: 'OK', action: 'dismiss', style: 'primary' }],
  });
  const before = await messageRow(message.id);

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    { body: { imageUrl: 'javascript:alert(1)' }, message: IMAGE_URL_REFUSED },
    { body: { theme: { backgroundColor: 'red; background-image: url(//evil)' } }, message: BACKGROUND_REFUSED },
    { body: { buttons: [{ id: 'b', action: 'dismiss', style: 'primary' }] }, message: 'buttons.0.text must be a string' },
  ];
  for (const c of cases) {
    const result = await call('PATCH', `${MESSAGES(p.project.id)}/${message.id}`, p.owner, c.body);
    expect(result.status, JSON.stringify(c.body)).toBe(400);
    expect(messageOf(result)).toContain(c.message);
  }
  expect(await messageRow(message.id)).toEqual(before);
});

// ------------------------------------------------------------ J. SDK delivery ---

test('INAPP-144 check requires an API key', async () => {
  const p = await inAppProject('inapp-144');
  await messageIn(p.owner, p.project.id, 'active');
  const revoked = await createRevokedKey(p);
  const fp = fingerprint('fp-144');

  const none = await checkMessages(p, fp, { apiKey: null });
  expect(none.status).toBe(401);
  expect(messageOf(none)).toBe(API_KEY_REQUIRED);
  for (const key of ['nope', revoked]) {
    const result = await checkMessages(p, fp, { apiKey: key });
    expect(result.status).toBe(401);
    expect(messageOf(result)).toBe(INVALID_API_KEY);
  }
});

test('INAPP-145 check refuses a privacy key', async () => {
  const p = await inAppProject('inapp-145');
  await messageIn(p.owner, p.project.id, 'active');
  const privacyKey = await createPrivacyKey(p);

  const result = await checkMessages(p, fingerprint('fp-145'), { apiKey: privacyKey });
  expect(result.status).toBe(403);
  expect(messageOf(result)).toBe(PRIVACY_KEY_REFUSED);
});

test('INAPP-146 check refuses a key for another project', async () => {
  const p = await inAppProject('inapp-146');
  const other = await inAppProject('inapp-146-other');
  const message = await messageIn(p.owner, p.project.id, 'active', { title: 'Only for P' });

  const result = await checkMessages(p, fingerprint('fp-146'), { apiKey: other.sdkKey });
  expect(result.status).toBe(403);
  expect(messageOf(result)).toBe(PROJECT_MISMATCH);
  expect(result.text).not.toContain(message.id);
  expect(result.text).not.toContain('Only for P');
});

test('INAPP-149 active app-open message is delivered', async () => {
  const p = await inAppProject('inapp-149');
  const buttons = [
    { id: 'start', text: 'Get started', action: 'deep_link', actionUrl: 'myapp://home', style: 'primary' },
    { id: 'later', text: 'Later', action: 'dismiss', style: 'secondary' },
  ];
  const theme = { ...EDITOR_DEFAULT_THEME, backgroundColor: '#ECFDF5', animation: 'slide_up' };
  const message = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Internal name',
    title: 'Welcome aboard',
    body: 'Take the tour',
    imageUrl: 'https://example.com/hero.png',
    imagePosition: 'center',
    buttons,
    theme,
    dismissOnTapOutside: false,
    autoDismissSeconds: 8,
    triggerDelaySeconds: 2,
    userFilters: { platforms: ['ios'] },
    tags: ['onboarding'],
  });
  await identifyDevice(p, { deviceFingerprint: fingerprint('fp-d5') });

  const result = await checkMessages(p, fingerprint('fp-d5'), { context: { platform: 'ios' } });
  expect(result.status).toBe(201);
  const { messages } = dataOf<{ messages: Array<Record<string, unknown>> }>(result);
  expect(messages).toEqual([
    {
      id: message.id,
      messageType: 'modal',
      title: 'Welcome aboard',
      body: 'Take the tour',
      imageUrl: 'https://example.com/hero.png',
      imagePosition: 'center',
      buttons,
      theme,
      dismissOnTapOutside: false,
      autoDismissSeconds: 8,
      triggerDelay: 2,
    },
  ]);
});

test('INAPP-151 draft, paused, scheduled, completed and archived messages are not delivered', async () => {
  const p = await inAppProject('inapp-151');
  const messages = [];
  for (const status of ['draft', 'paused', 'scheduled', 'completed', 'archived']) {
    messages.push(await messageIn(p.owner, p.project.id, status, { name: `In ${status}` }));
  }
  const device = await identifyDevice(p, {}, 'fp-d5');

  const result = await checkMessages(p, device.fingerprint);
  expect(result.status).toBe(201);
  expect(dataOf(result).messages).toEqual([]);

  // Control: the same check delivers one of them once it is active.
  await setMessageStatus(p.owner, p.project.id, messages[0].id, 'active');
  expect(await deliveredIds(p, device.fingerprint)).toEqual([messages[0].id]);
});

test('INAPP-158 paused message stops being delivered', async () => {
  const p = await inAppProject('inapp-158');
  const message = await messageIn(p.owner, p.project.id, 'active');
  const device = await identifyDevice(p, {}, 'fp-d5');
  expect(await deliveredIds(p, device.fingerprint)).toEqual([message.id]);

  dataOf(await call('POST', `${MESSAGES(p.project.id)}/${message.id}/pause`, p.owner));
  expect(await deliveredIds(p, device.fingerprint)).toEqual([]);
});

test('INAPP-162 Mixpanel cohort targeting', async () => {
  const p = await inAppProject('inapp-162');
  const d1 = await identifyDevice(p, { distinctId: 'user-42' }, 'fp-d1');
  const d3 = await identifyDevice(p, { doNotTrack: true }, 'fp-d3');
  const d5 = await identifyDevice(p, {}, 'fp-d5');
  const cohortId = await seedCohort(p.project.id, 'Engaged', [
    { deviceIdentityId: d1.id, resolved: true },
    { deviceIdentityId: d3.id, resolved: true },
    { deviceIdentityId: d5.id, resolved: false },
  ]);
  const message = await messageIn(p.owner, p.project.id, 'active', { userType: 'cohort', mixpanelCohortId: cohortId });

  expect(await deliveredIds(p, d1.fingerprint)).toEqual([message.id]);
  expect(await deliveredIds(p, d5.fingerprint)).toEqual([]);
  expect(await deliveredIds(p, fingerprint('fp-unknown'))).toEqual([]);
  expect(await deliveredIds(p, d3.fingerprint)).toEqual([]);
});

test('INAPP-163 segment targeting', async () => {
  const p = await inAppProject('inapp-163');
  const secret = await identitySecret(p);
  const externalUserId = `ext-4-${randomUUID().slice(0, 8)}`;
  const d4 = await identifyDevice(
    p,
    { externalUserId, distinctId: externalUserId, userHash: userHash(secret, externalUserId), traits: { plan: 'pro' } },
    'fp-d4',
  );
  const d5 = await identifyDevice(p, { traits: { plan: 'free' } }, 'fp-d5');
  const segmentId = await traitSegment(p.owner, p.project.id, 'plan', 'pro');
  const message = await createInAppMessage(p.owner, p.project.id, { name: 'Pro offer' });
  const patched = dataOf(await call('PATCH', `${MESSAGES(p.project.id)}/${message.id}`, p.owner, { userType: 'segment', segmentId, status: 'active' }));
  expect(patched).toMatchObject({ userType: 'segment', segmentId, status: 'active' });

  expect(await deliveredIds(p, d4.fingerprint)).toEqual([message.id]);
  expect(await deliveredIds(p, d5.fingerprint)).toEqual([]);
  expect(await deliveredIds(p, fingerprint('fp-unknown'))).toEqual([]);
});

test('INAPP-168 triggered message is delivered from the queue', async () => {
  const p = await inAppProject('inapp-168');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Queued', triggerType: 'immediate' });
  const d1 = await identifyDevice(p, {}, 'fp-d1');
  const d5 = await identifyDevice(p, {}, 'fp-d5');
  // An immediate message is never delivered by matching alone.
  expect(await deliveredIds(p, d1.fingerprint)).toEqual([]);

  expect(await triggerFor(p.owner, p.project.id, message.id, [d1.fingerprint])).toBe(1);
  expect(await deliveredIds(p, d1.fingerprint)).toEqual([message.id]);
  expect(await deliveredIds(p, d5.fingerprint)).toEqual([]);
});

test('INAPP-172 suspension stops delivery and keeps the queue', async () => {
  const p = await inAppProject('inapp-172');
  const appOpen = await messageIn(p.owner, p.project.id, 'active', { name: 'App open' });
  const queued = await messageIn(p.owner, p.project.id, 'active', { name: 'Queued', triggerType: 'immediate' });
  const d1 = await identifyDevice(p, {}, 'fp-d1');
  await triggerFor(p.owner, p.project.id, queued.id, [d1.fingerprint]);

  await suspendAccount(p.owner.userId);
  try {
    const result = await checkMessages(p, d1.fingerprint);
    expect(result.status).toBe(201);
    expect(dataOf(result).messages).toEqual([]);
    const [row] = await pendingRows(queued.id);
    expect(row.status).toBe('pending');
  } finally {
    await reactivateAccount(p.owner.userId);
  }

  expect((await deliveredIds(p, d1.fingerprint)).sort()).toEqual([appOpen.id, queued.id].sort());
});

test('INAPP-174 event recording requires key and project scope', async () => {
  const p = await inAppProject('inapp-174');
  const other = await inAppProject('inapp-174-other');
  const message = await messageIn(p.owner, p.project.id, 'active');
  const privacyKey = await createPrivacyKey(p);
  const event = { messageId: message.id, deviceFingerprint: fingerprint('fp-174'), eventType: 'impression' };

  const none = await recordInAppEvent(p, event, { apiKey: null });
  expect(none.status).toBe(401);
  expect(messageOf(none)).toBe(API_KEY_REQUIRED);
  const foreign = await recordInAppEvent(p, event, { apiKey: other.sdkKey });
  expect(foreign.status).toBe(403);
  expect(messageOf(foreign)).toBe(PROJECT_MISMATCH);
  const privacy = await recordInAppEvent(p, event, { apiKey: privacyKey });
  expect(privacy.status).toBe(403);
  expect(messageOf(privacy)).toBe(PRIVACY_KEY_REFUSED);

  expect(await impressionRows(message.id)).toHaveLength(0);
  expect((await messageRow(message.id))?.total_impressions).toBe(0);
});

test('INAPP-176 event for an unknown or foreign message', async () => {
  const p = await inAppProject('inapp-176');
  const other = await inAppProject('inapp-176-other');
  const m2 = await messageIn(other.owner, other.project.id, 'active');
  const fp = fingerprint('fp-176');

  for (const messageId of [randomUUID(), m2.id]) {
    const result = await recordInAppEvent(p, { messageId, deviceFingerprint: fp, eventType: 'impression' });
    expect(result.status, messageId).toBe(404);
    expect(messageOf(result)).toBe(MESSAGE_NOT_FOUND);
  }
  const row = await messageRow(m2.id);
  expect(row).toMatchObject({ total_impressions: 0, total_clicks: 0, total_dismissals: 0 });
  expect(await impressionRows(m2.id)).toHaveLength(0);
});

test('INAPP-179 do-not-track person: only the cap is kept', async () => {
  const p = await inAppProject('inapp-179');
  const d3 = await identifyDevice(p, { doNotTrack: true, distinctId: 'user-dnt' }, 'fp-d3');
  const message = await messageIn(p.owner, p.project.id, 'active', { maxImpressionsPerUser: 1 });
  expect(await deliveredIds(p, d3.fingerprint)).toEqual([message.id]);

  for (const eventType of ['impression', 'click', 'dismiss']) {
    const result = await recordInAppEvent(p, {
      messageId: message.id,
      deviceFingerprint: d3.fingerprint,
      distinctId: 'user-dnt',
      eventType,
      ...(eventType === 'click' ? { buttonId: 'start' } : {}),
    });
    expect(result.status, eventType).toBe(201);
  }

  const rows = await impressionRows(message.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    event_type: 'impression',
    device_fingerprint: d3.fingerprint,
    device_identity_id: null,
    distinct_id: null,
    button_id: null,
    ip_address: null,
    user_agent: null,
  });
  // The counters still move (they are written after the response).
  await expect
    .poll(async () => {
      const row = await messageRow(message.id);
      return [row?.total_impressions, row?.total_clicks, row?.total_dismissals];
    })
    .toEqual([1, 1, 1]);
  // And the cap still sees the showing.
  expect(await deliveredIds(p, d3.fingerprint)).toEqual([]);
});
