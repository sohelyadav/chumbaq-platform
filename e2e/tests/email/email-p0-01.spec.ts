import { apiUrl, uniqueEmail } from '../../support/api';
import { emailWebhookPath, seedEmailCredentials } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import { pathAndQuery, publicApiUrl, signConfirmLink, signUnsubscribeLink } from '../../support/signing';
import {
  activityRows,
  brevoCallsTo,
  call,
  campaignRows,
  card,
  CONNECT_FIRST,
  confirmEmail,
  consentRows,
  dataOf,
  emailPreview,
  emailProject,
  emailSettingsRow,
  emailSuppressionList,
  identifyEmail,
  messageOf,
  MISSED_DURING_SUSPENSION,
  NOBODY_NO_OPT_IN,
  NOBODY_OPT_IN,
  NOT_SET_UP,
  openEmail,
  OPTED_OUT,
  optInSwitch,
  PEOPLE,
  PROJECT_NOT_FOUND,
  publicRequest,
  reachLine,
  reactivateAccount,
  scheduleEmailCampaign,
  seedPeople,
  sinceLabel,
  sql,
  STOPPED_BY_SUSPENSION,
  suppress,
  SUPPRESSED,
  suppressionRows,
  suspendAccount,
  teammate,
  whenLabel,
} from '../../support/areas/email';

/**
 * Email: the Suppressions tab, the Sender and Provider cards, the settings API's
 * secrets, Replace URL, the test send card, the composer (preview frame, reach,
 * scheduling, sending, A/B), the send API's refusals, another tenant's campaign,
 * suspension, and the unsubscribe link. Provider connections are seeded (the real
 * connect checks the key with the provider); sends reach the provider stub's Brevo;
 * people arrive through the SDK's identify route; unsubscribe links are signed with
 * the run's key as the API signs them.
 */

test.describe.configure({ mode: 'parallel' });

// ------------------------------------------------------------ C. Suppressions ---

test('EMAIL-023 add an address by hand', async ({ page }) => {
  const p = await emailProject('email-023', { provider: 'brevo' });
  const { E1 } = await seedPeople(p, p.owner.ip, ['E1']);

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Suppressions');
  await expect(page.getByText('Nobody is suppressed.')).toBeVisible();
  const input = page.getByPlaceholder('someone@example.com');
  await input.fill(' E1@Example.TEST ');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/suppressions') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Suppress', exact: true }).click(),
  ]);
  expect(response.request().postDataJSON()).toMatchObject({ projectId: p.project.id, reason: 'manual' });
  expect(((await response.json()) as { data: unknown }).data).toEqual({ suppressed: true });
  await expect(input).toHaveValue('');

  const listed = (await emailSuppressionList(p.owner, p.project.id)).data;
  expect(listed).toHaveLength(1);
  const row = page.getByRole('row').filter({ hasText: 'e1@example.test' });
  await expect(row.getByRole('cell').nth(0)).toHaveText('e1@example.test');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Added by hand');
  await expect(row.getByRole('cell').nth(2)).toHaveText(sinceLabel(listed[0].createdAt));
  await expect(row.getByTitle('Resubscribe')).toBeVisible();

  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ channel: 'email', address: 'e1@example.test', reason: 'manual', source: 'dashboard' }),
  ]);
  expect(await consentRows(E1)).toContainEqual({ channel: 'email', granted: false, source: 'dashboard' });
  const added = await activityRows(p.project.id, 'suppression.added');
  expect(added).toHaveLength(1);
  expect(added[0].details).toEqual({ channel: 'email', address: 'e***@example.test' });
});

test("EMAIL-026 a suppressed address leaves every campaign's audience", async ({ page }) => {
  const p = await emailProject('email-026', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');

  await openEmail(page, p.project.id, 'Suppressions');
  await page.getByPlaceholder('someone@example.com').fill(PEOPLE.E1.email!);
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: PEOPLE.E1.email! })).toBeVisible();

  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('1 recipient(s)');
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 1 });
});

test('EMAIL-027 lift a suppression (Resubscribe) after confirming', async ({ page }) => {
  const p = await emailProject('email-027', { provider: 'brevo', requireOptIn: false });
  // Two devices hold the address: both get the consent change.
  const first = await identifyEmail(p, p.owner.ip, PEOPLE.E1);
  const second = await identifyEmail(p, p.owner.ip, { email: PEOPLE.E1.email, firstName: 'Asha phone' });
  await suppress(p.owner, p.project.id, PEOPLE.E1.email!);
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 0 });

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Suppressions');
  const row = page.getByRole('row').filter({ hasText: 'e1@example.test' });
  await expect(row).toBeVisible();
  let message = '';
  page.once('dialog', async (dialog) => {
    message = dialog.message();
    await dialog.accept();
  });
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/email/suppressions/')),
    row.getByTitle('Resubscribe').click(),
  ]);
  expect(message).toBe('Email e1@example.test again? Only do this if they asked to be resubscribed.');
  expect(response.url()).toContain(`/api/email/suppressions/${p.project.id}/e1%40example.test`);
  expect(((await response.json()) as { data: unknown }).data).toEqual({ removed: true });
  await expect(page.getByText('Nobody is suppressed.')).toBeVisible();
  await expect(row).toHaveCount(0);

  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  for (const identity of [first, second]) {
    const history = await consentRows(identity);
    expect(history[history.length - 1]).toEqual({ channel: 'email', granted: true, source: 'dashboard' });
  }
  const removed = await activityRows(p.project.id, 'suppression.removed');
  expect(removed).toHaveLength(1);
  expect(removed[0].details).toEqual({ channel: 'email', address: 'e***@example.test' });
  // One address, one recipient again.
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 1 });
});

// ------------------------------------------------------------ D. Sender card ---

test('EMAIL-040 first save creates the settings and the webhook URLs', async ({ page }) => {
  const p = await emailProject('email-040');
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(card(page, 'Provider')).toContainText('Save the sender first, then connect Amazon SES, Resend or Brevo.');

  await page.getByLabel('From address').fill('News@Example.TEST');
  await page.getByLabel('From name').fill('Acme News');
  await page.getByLabel('Reply-to (optional)').fill('Support@Example.TEST');
  await page.getByLabel('Postal address').fill('Acme Ltd\n1 Main Road, Pune 411001');

  // Held for a moment, so the button's spinner can be seen.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/email/settings', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  const save = page.getByRole('button', { name: 'Save sender' });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(save.locator('svg.animate-spin')).toBeVisible();
  release();
  await expect(page.getByText('Sender saved', { exact: true })).toBeVisible();

  await expect(page.getByLabel('From address')).toHaveValue('news@example.test');
  await expect(page.getByLabel('Reply-to (optional)')).toHaveValue('support@example.test');
  for (const name of ['Resend', 'Amazon SES', 'Brevo']) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: 'Resend', exact: true })).toHaveAttribute('aria-selected', 'true');
  const row = await emailSettingsRow(p.project.id);
  expect(row).toMatchObject({
    from_email: 'news@example.test',
    from_name: 'Acme News',
    reply_to: 'support@example.test',
    postal_address: 'Acme Ltd\n1 Main Road, Pune 411001',
    require_opt_in: true,
    provider: null,
  });
  expect(row!.webhook_token).toMatch(/^[0-9a-f]{48}$/);
  const box = page.locator('div.rounded-md.border').filter({ has: page.getByText('Delivery events', { exact: true }) });
  await expect(box.locator('code')).toHaveText(publicApiUrl(`/api/email/webhooks/resend/${row!.webhook_token}`));

  const changed = await activityRows(p.project.id, 'channel.settings_changed');
  expect(changed).toHaveLength(1);
  expect(changed[0].details).toEqual({
    channel: 'email',
    fields: ['fromEmail', 'fromName', 'replyTo', 'postalAddress', 'requireOptIn'],
  });
});

test('EMAIL-044 turn "Only email people who opted in" off and on', async ({ page }) => {
  const p = await emailProject('email-044', { provider: 'brevo', requireOptIn: true });
  const { E1 } = await seedPeople(p, p.owner.ip, ['E1', 'E5', 'E3']);
  await confirmEmail(E1);

  const withOptIn = 'People with an email address who have not unsubscribed or bounced, and who opted in.';
  const withoutOptIn = 'People with an email address who have not unsubscribed or bounced.';

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(optInSwitch(page)).toBeChecked();
  await optInSwitch(page).click();
  await expect(optInSwitch(page)).not.toBeChecked();
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(page.getByText('Sender saved', { exact: true })).toBeVisible();

  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(page.getByText(withoutOptIn, { exact: true })).toBeVisible();
  await expect(reachLine(page)).toHaveText('2 recipient(s)');

  await openEmail(page, p.project.id, 'Settings');
  await expect(optInSwitch(page)).not.toBeChecked();
  await optInSwitch(page).click();
  await expect(optInSwitch(page)).toBeChecked();
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(page.getByText('Sender saved', { exact: true })).toBeVisible();

  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(page.getByText(withOptIn, { exact: true })).toBeVisible();
  await expect(reachLine(page)).toHaveText('1 recipient(s)');

  // The first entry is the API save that created the row; then one per switch.
  const changed = await activityRows(p.project.id, 'channel.settings_changed');
  expect(changed.slice(1).map((row) => row.details)).toEqual([
    { channel: 'email', fields: ['requireOptIn'] },
    { channel: 'email', fields: ['requireOptIn'] },
  ]);
});

// ------------------------------------------------------------ E. Provider card ---

test('EMAIL-069 secrets never come back from the API', async ({ page }) => {
  const p = await emailProject('email-069', { sender: true });
  const ses = await seedEmailCredentials(p.project.id, 'ses', { activate: false });
  const resend = await seedEmailCredentials(p.project.id, 'resend', { activate: false });
  const brevo = await seedEmailCredentials(p.project.id, 'brevo');

  const answered = await call('GET', `/api/email/settings/${p.project.id}`, p.owner);
  const status = dataOf(answered);
  for (const secret of [
    ses.credentials.secretAccessKey,
    ses.credentials.accessKeyId,
    resend.credentials.apiKey,
    resend.credentials.webhookSecret!,
    brevo.credentials.apiKey,
  ]) {
    expect(answered.text).not.toContain(secret);
  }
  expect(status.settings).not.toHaveProperty('webhookToken');
  expect(status.providers).toEqual([
    {
      provider: 'ses',
      keyHint: ses.credentials.accessKeyId.slice(-4),
      region: 'ap-south-1',
      configurationSetName: ses.credentials.configurationSetName,
    },
    { provider: 'resend', keyHint: resend.credentials.apiKey.slice(-4), hasWebhookSecret: true },
    { provider: 'brevo', keyHint: brevo.credentials.apiKey.slice(-4) },
  ]);

  // A key of four characters or fewer has no hint.
  const short = await emailProject('email-069-short', { sender: true });
  await seedEmailCredentials(short.project.id, 'brevo', { credentials: { apiKey: 'abcd' } });
  const shortStatus = dataOf(await call('GET', `/api/email/settings/${short.project.id}`, short.owner));
  expect(shortStatus.providers).toEqual([{ provider: 'brevo', keyHint: null }]);

  await signIn(page, short.owner);
  await openEmail(page, short.project.id, 'Settings');
  await expect(page.getByRole('tab', { name: /Brevo\s*Active/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Key ending •••• is stored.', { exact: true })).toBeVisible();
});

test('EMAIL-071 Replace URL after confirming', async ({ page }) => {
  const p = await emailProject('email-071', { provider: 'brevo' });
  const topic = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events';
  await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, topic]);
  const t1 = (await emailSettingsRow(p.project.id))!.webhook_token as string;

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  const webhook = page.locator('code').filter({ hasText: '/api/email/webhooks/' });
  await expect(webhook).toHaveText(publicApiUrl(`/api/email/webhooks/brevo/${t1}`));

  let message = '';
  page.once('dialog', async (dialog) => {
    message = dialog.message();
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Replace URL' }).click();
  await expect(page.getByText('Webhook URL replaced', { exact: true })).toBeVisible();
  await expect(page.getByText('Give your provider the new URL.', { exact: true })).toBeVisible();
  expect(message).toBe(
    'Replace the webhook URL? The current URL stops working at once for Amazon SES, Resend and Brevo. Give your provider the new URL afterwards.',
  );

  const after = (await emailSettingsRow(p.project.id))!;
  const t2 = after.webhook_token as string;
  expect(t2).toMatch(/^[0-9a-f]{48}$/);
  expect(t2).not.toBe(t1);
  expect(after.ses_topic_arn).toBe(topic);
  for (const [tab, provider] of [['Resend', 'resend'], ['Amazon SES', 'ses'], ['Brevo', 'brevo']] as const) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await expect(webhook).toHaveText(publicApiUrl(`/api/email/webhooks/${provider}/${t2}`));
  }

  const event = { contentType: 'application/json', text: JSON.stringify({ event: 'delivered', email: 'nobody@example.test' }) };
  expect((await publicRequest('POST', emailWebhookPath('brevo', t1), event)).status).toBe(404);
  const accepted = await publicRequest('POST', emailWebhookPath('brevo', t2), event);
  expect(accepted.status).toBe(200);

  const rotated = await activityRows(p.project.id, 'email.webhook_token_rotated');
  expect(rotated).toHaveLength(1);
  const logged = JSON.stringify(rotated[0]);
  expect(logged).not.toContain(t1);
  expect(logged).not.toContain(t2);
});

// ------------------------------------------------------------ F. Send a test ---

test('EMAIL-082 test send to a suppressed or opted-out address', async ({ page }) => {
  const p = await emailProject('email-082', { provider: 'brevo' });
  await seedPeople(p, p.owner.ip, ['E3']);
  await suppress(p.owner, p.project.id, 'blocked@example.test');

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  const testCard = card(page, 'Send a test');
  const to = testCard.getByPlaceholder('you@yourapp.com');
  await to.fill('BLOCKED@example.test');
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const suppressedLine = testCard.getByText(SUPPRESSED, { exact: true });
  await expect(suppressedLine).toBeVisible();
  await expect(suppressedLine).toHaveClass(/text-destructive/);

  await to.fill('e3@example.test');
  await testCard.getByRole('button', { name: 'Send test' }).click();
  const optedOutLine = testCard.getByText(OPTED_OUT, { exact: true });
  await expect(optedOutLine).toBeVisible();
  await expect(optedOutLine).toHaveClass(/text-destructive/);

  for (const [address, error] of [['BLOCKED@example.test', SUPPRESSED], ['e3@example.test', OPTED_OUT]] as const) {
    const answered = await call('POST', '/api/email/test-send', p.owner, {
      projectId: p.project.id,
      to: address,
      subject: 'Test',
      html: '<p>Test</p>',
    });
    expect(answered.status).toBe(201);
    expect(dataOf(answered)).toEqual({ delivered: false, error });
  }
  expect(await brevoCallsTo('blocked@example.test')).toHaveLength(0);
  expect(await brevoCallsTo('e3@example.test')).toHaveLength(0);
});

// ------------------------------------------------------------ G. Composer ---

test('EMAIL-088 script in the HTML does not run in the dashboard', async ({ page }) => {
  const p = await emailProject('email-088', { provider: 'brevo' });
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(page.getByRole('heading', { name: 'New email' })).toBeVisible();
  const title = await page.title();
  await page.getByLabel('HTML', { exact: true }).fill(
    `<script>parent.document.title='pwned';alert(1)</script><img src=x onerror="alert(2)"><p>ok</p>`,
  );

  const frame = page.locator('iframe[title="Email preview"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title="Email preview"]').getByText('ok', { exact: true })).toBeVisible();
  // Long enough for an onerror on a broken image to have fired.
  await page.waitForTimeout(1_000);
  expect(dialogs).toEqual([]);
  expect(await page.title()).toBe(title);
});

test('EMAIL-096 preview counts each address once and honours every exclusion', async () => {
  const p = await emailProject('email-096', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2', 'E5']);
  expect(await emailPreview(p.owner, p.project.id)).toEqual({ targetType: 'project', recipients: 3, requireOptIn: false });

  // Two devices with one address count once.
  await seedPeople(p, p.owner.ip, ['E6', 'E7']);
  expect((await emailPreview(p.owner, p.project.id)).recipients).toBe(4);

  // An opt-out on any row holding the address keeps it out.
  await seedPeople(p, p.owner.ip, ['E8']);
  expect((await emailPreview(p.owner, p.project.id)).recipients).toBe(3);

  // A suppressed address is out.
  await suppress(p.owner, p.project.id, PEOPLE.E2.email!);
  expect(await emailPreview(p.owner, p.project.id)).toEqual({ targetType: 'project', recipients: 2, requireOptIn: false });
});

test('EMAIL-097 opt-in required needs a confirmed opt-in', async () => {
  const blank = await emailProject('email-097-blank');
  expect(await emailPreview(blank.owner, blank.project.id)).toEqual({ targetType: 'project', recipients: 0, requireOptIn: true });

  const p = await emailProject('email-097', { provider: 'brevo', requireOptIn: true });
  const { E1 } = await seedPeople(p, p.owner.ip, ['E1', 'E2', 'E5']);
  expect(await emailPreview(p.owner, p.project.id)).toEqual({ targetType: 'project', recipients: 0, requireOptIn: true });
  await confirmEmail(E1);
  expect(await emailPreview(p.owner, p.project.id)).toEqual({ targetType: 'project', recipients: 1, requireOptIn: true });
});

test('EMAIL-101 schedule for later', async ({ page }) => {
  const p = await emailProject('email-101', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Launch');
  await page.getByText('Schedule for later', { exact: true }).locator('..').getByRole('switch').click();
  const schedule = page.getByRole('button', { name: 'Schedule email' });
  await expect(schedule).toBeDisabled();
  await page.getByRole('button', { name: 'Pick date & time' }).click();
  await page.getByRole('button', { name: /next month/i }).click();
  await page.getByRole('gridcell', { name: '15' }).getByRole('button').click();
  await page.locator('input[type="time"]').fill('10:30');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /10:30$/ })).toBeVisible();
  await expect(schedule).toBeEnabled();

  const now = new Date();
  const expected = new Date(now.getFullYear(), now.getMonth() + 1, 15, 10, 30, 0, 0);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    schedule.click(),
  ]);
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: Record<string, any> }).data;
  await expect(page.getByText('Email scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('2 recipient(s).', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Launch', exact: true }) });
  await expect(row).toContainText('Scheduled');
  await expect(row.locator('span.text-blue-600')).toHaveText(whenLabel(expected));

  const [stored] = await campaignRows(p.project.id);
  expect(stored).toMatchObject({
    id: created.id,
    channel: 'email',
    status: 'scheduled',
    target_type: 'project',
    total_tokens: 2,
    title: 'Launch',
  });
  expect(new Date(stored.scheduled_at).toISOString()).toBe(expected.toISOString());
  expect(stored.email_content.subject).toBe('Launch');
  expect(stored.email_content.html).toContain('{{firstName|there}}');
  const scheduled = await activityRows(p.project.id, 'campaign.scheduled');
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].details).toEqual({ channel: 'email', audienceSize: 2 });

  // A time already past: queued at once, though the toast still says scheduled.
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Already due');
  await page.getByText('Schedule for later', { exact: true }).locator('..').getByRole('switch').click();
  await page.getByRole('button', { name: 'Pick date & time' }).click();
  await page.getByRole('button', { name: /previous month/i }).click();
  await page.getByRole('gridcell', { name: '15' }).getByRole('button').click();
  await page.locator('input[type="time"]').fill('10:30');
  await page.keyboard.press('Escape');
  const [past] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Schedule email' }).click(),
  ]);
  expect(((await past.json()) as { data: Record<string, any> }).data).toMatchObject({ status: 'queued', scheduledAt: null });
  await expect(page.getByText('Email scheduled', { exact: true })).toBeVisible();
  const sent = await activityRows(p.project.id, 'campaign.sent');
  expect(sent).toHaveLength(1);
  expect(sent[0].details).toEqual({ channel: 'email', audienceSize: 2 });
});

test('EMAIL-102 send now', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await emailProject('email-102', { provider: 'brevo', requireOptIn: false });
  const anu = uniqueEmail('email-102-anu');
  const bela = uniqueEmail('email-102-bela');
  await identifyEmail(p, p.owner.ip, { email: anu, firstName: 'Anu' });
  await identifyEmail(p, p.owner.ip, { email: bela, firstName: 'Bela' });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Flash sale');
  await page.getByLabel('HTML', { exact: true }).fill('<p>Hi {{firstName|there}}, the sale is on.</p>');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Send email' }).click(),
  ]);
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: Record<string, any> }).data;
  expect(created).toMatchObject({ channel: 'email', status: 'queued', totalTokens: 2, scheduledAt: null, title: 'Flash sale' });
  await expect(page.getByText('Email queued', { exact: true })).toBeVisible();
  await expect(page.getByText('2 recipient(s).', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));

  // The worker sends through the stubbed Brevo; each recipient gets their own name.
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Flash sale', exact: true }) });
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText('Sent', { timeout: 2_000 });
    await expect(row.getByRole('cell').nth(2)).toHaveText('2/2', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  for (const [address, name] of [[anu, 'Anu'], [bela, 'Bela']] as const) {
    const calls = await brevoCallsTo(address);
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { subject: string; htmlContent: string };
    expect(body.subject).toBe('Flash sale');
    expect(body.htmlContent).toContain(`Hi ${name}, the sale is on.`);
  }
  expect(await activityRows(p.project.id, 'campaign.sent')).toHaveLength(1);
});

test('EMAIL-107 A/B test: create', async ({ page }) => {
  const p = await emailProject('email-107', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Which subject wins');
  await page.getByText('A/B test', { exact: true }).locator('../..').getByRole('switch').click();
  const subjects = page.getByPlaceholder('Subject for this arm');
  await expect(subjects).toHaveCount(2);
  await subjects.nth(0).fill('Subject A');
  await subjects.nth(1).fill('Subject B');
  await page.getByPlaceholder('HTML for this arm (optional, defaults to the message HTML)').nth(1).fill('<p>Arm B</p>');
  await page.getByText('Hold back as control', { exact: true }).locator('..').getByRole('spinbutton').fill('10');

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start experiment' }).click(),
  ]);
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: Record<string, any> }).data;
  expect(created.status).toBe('scheduled');
  await expect(page.getByText('Experiment created', { exact: true })).toBeVisible();
  await expect(page.getByText('2 recipient(s).', { exact: true })).toBeVisible();

  const [stored] = await campaignRows(p.project.id);
  expect(stored.id).toBe(created.id);
  expect(stored.control_percentage).toBe(10);
  expect(stored.variants).toEqual([
    { key: 'A', title: 'Subject A', body: null, html: null, preheader: null, weight: 50 },
    { key: 'B', title: 'Subject B', body: null, html: '<p>Arm B</p>', preheader: null, weight: 50 },
  ]);
});

test('EMAIL-114 send API: not set up and nobody reachable', async () => {
  const send = (as: Parameters<typeof call>[2], projectId: string) =>
    call('POST', '/api/email/send', as, { projectId, subject: 'Hello', html: '<p>Hello</p>' });

  const blank = await emailProject('email-114-blank');
  const sender = await emailProject('email-114-sender', { sender: true });
  const optIn = await emailProject('email-114-optin', { provider: 'brevo', requireOptIn: true });
  await seedPeople(optIn, optIn.owner.ip, ['E1']);
  const noAddress = await emailProject('email-114-noaddress', { provider: 'brevo', requireOptIn: false });
  await seedPeople(noAddress, noAddress.owner.ip, ['E4']);

  const cases: Array<[typeof blank, number, string]> = [
    [blank, 404, NOT_SET_UP],
    [sender, 400, CONNECT_FIRST],
    [optIn, 400, NOBODY_OPT_IN],
    [noAddress, 400, NOBODY_NO_OPT_IN],
  ];
  for (const [p, status, message] of cases) {
    const refused = await send(p.owner, p.project.id);
    expect(refused.status, message).toBe(status);
    expect(messageOf(refused)).toBe(message);
    expect(await campaignRows(p.project.id)).toHaveLength(0);
    expect(await activityRows(p.project.id, 'campaign.sent')).toHaveLength(0);
    expect(await activityRows(p.project.id, 'campaign.scheduled')).toHaveLength(0);
  }
});

// ------------------------------------------------------------ H/P. Campaigns ---

test("EMAIL-127 another tenant's email campaign", async () => {
  const mine = await emailProject('email-127', { provider: 'brevo', requireOptIn: false });
  const other = await emailProject('email-127-other', { provider: 'brevo', requireOptIn: false });
  await seedPeople(other, other.owner.ip, ['E1']);
  const subject = `Other tenant subject ${Date.now()}`;
  const campaign = await scheduleEmailCampaign(other.owner, other.project.id, subject);

  const viaMine = await call('GET', `/api/push-notifications/campaign/${mine.project.id}/${campaign.id}`, mine.owner);
  expect(viaMine.status).toBe(404);
  expect(messageOf(viaMine)).toBe('Campaign not found for this project');
  expect(viaMine.text).not.toContain(subject);

  const viaTheirs = await call('GET', `/api/push-notifications/campaign/${other.project.id}/${campaign.id}`, mine.owner);
  expect(viaTheirs.status).toBe(404);
  expect(messageOf(viaTheirs)).toBe(PROJECT_NOT_FOUND);
  expect(viaTheirs.text).not.toContain(subject);

  const list = await call('GET', `/api/push-notifications/logs/${mine.project.id}?channel=email`, mine.owner);
  expect(list.status).toBe(200);
  expect(list.text).not.toContain(subject);
});

test('EMAIL-134 suspension stops an email campaign', async () => {
  test.setTimeout(200_000);
  const p = await emailProject('email-134', { provider: 'brevo', requireOptIn: false });
  const address = uniqueEmail('email-134');
  await identifyEmail(p, p.owner.ip, { email: address, firstName: 'Sus' });
  const admin = await teammate(p.project.id, 'admin', p.owner);
  const due = await scheduleEmailCampaign(p.owner, p.project.id, 'Due during the suspension');

  await suspendAccount(p.owner.userId);
  // Its time comes while the account is suspended.
  await sql(`UPDATE push_notification_logs SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [due.id]);
  // Creating one is not refused while suspended; the worker stops it.
  const queued = await call('POST', '/api/email/send', admin, { projectId: p.project.id, subject: 'Sent while suspended', html: '<p>Hi</p>' });
  expect(queued.status).toBe(201);
  expect(dataOf(queued).status).toBe('queued');

  const campaign = async (id: string) => dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${id}`, admin));
  await expect.poll(async () => (await campaign(dataOf(queued).id)).status, { timeout: 60_000 }).toBe('failed');
  expect((await campaign(dataOf(queued).id)).errorMessage).toBe(STOPPED_BY_SUSPENSION);
  await expect.poll(async () => (await campaign(due.id)).status, { timeout: 100_000, intervals: [2_000] }).toBe('cancelled');
  expect((await campaign(due.id)).errorMessage).toBe(MISSED_DURING_SUSPENSION);
  expect(await brevoCallsTo(address)).toHaveLength(0);

  // Reactivated: neither resumes.
  await reactivateAccount(p.owner.userId);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect((await campaign(dataOf(queued).id)).status).toBe('failed');
  expect((await campaign(due.id)).status).toBe('cancelled');
  expect(await brevoCallsTo(address)).toHaveLength(0);
});

// ------------------------------------------------------------ J. Unsubscribe ---

test('EMAIL-137 opening the unsubscribe link shows a confirmation and changes nothing', async ({ page }) => {
  const p = await emailProject('email-137', { provider: 'brevo' });
  await seedPeople(p, p.owner.ip, ['E1']);
  const link = signUnsubscribeLink(p.project.id, 'e1@example.test');

  const response = await page.goto(apiUrl(pathAndQuery(link)));
  expect(response!.status()).toBe(200);
  const headers = response!.headers();
  expect(headers['cache-control']).toBe('no-store');
  expect(headers['content-security-policy']).toBeTruthy();
  await expect(page).toHaveTitle('Unsubscribe');
  await expect(page.getByRole('heading', { name: 'Unsubscribe?' })).toBeVisible();
  await expect(page.getByText('Stop marketing email to e1@example.test.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unsubscribe' })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');

  expect(await suppressionRows(p.project.id)).toHaveLength(0);
});

test('EMAIL-138 clicking Unsubscribe suppresses the address', async ({ page }) => {
  const p = await emailProject('email-138', { provider: 'brevo' });
  const first = await identifyEmail(p, p.owner.ip, PEOPLE.E1);
  const second = await identifyEmail(p, p.owner.ip, { email: PEOPLE.E1.email, firstName: 'Asha tablet' });
  const link = signUnsubscribeLink(p.project.id, 'e1@example.test');

  await page.goto(apiUrl(pathAndQuery(link)));
  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page).toHaveTitle('Unsubscribed');
  await expect(page.getByRole('heading', { name: "You're unsubscribed" })).toBeVisible();
  await expect(
    page.getByText('e1@example.test will not receive marketing email from this sender again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Changed your mind? Contact the sender to be added back.', { exact: true })).toBeVisible();

  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: 'e1@example.test', reason: 'unsubscribed', source: 'link' }),
  ]);
  for (const identity of [first, second]) {
    expect(await consentRows(identity)).toContainEqual({ channel: 'email', granted: false, source: 'unsubscribe_link' });
  }
  expect(await activityRows(p.project.id, 'suppression.added')).toHaveLength(0);

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Suppressions');
  const row = page.getByRole('row').filter({ hasText: 'e1@example.test' });
  await expect(row.getByRole('cell').nth(1)).toHaveText('Unsubscribed');
});

test('EMAIL-139 RFC 8058 one-click POST', async () => {
  const p = await emailProject('email-139', { provider: 'brevo' });
  await seedPeople(p, p.owner.ip, ['E1']);
  const link = signUnsubscribeLink(p.project.id, 'e1@example.test');

  const answered = await publicRequest('POST', pathAndQuery(link), {
    contentType: 'application/x-www-form-urlencoded',
    text: 'List-Unsubscribe=One-Click',
  });
  expect(answered.status).toBe(200);
  expect(answered.headers.get('content-type')).toMatch(/^text\/plain/);
  expect(answered.text).toBe('Unsubscribed.');
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: 'e1@example.test', reason: 'unsubscribed', source: 'link' }),
  ]);
});

test('EMAIL-141 tampered, partial or swapped unsubscribe links', async () => {
  const p = await emailProject('email-141', { provider: 'brevo' });
  const other = await emailProject('email-141-other', { provider: 'brevo' });
  await seedPeople(p, p.owner.ip, ['E1']);
  await identifyEmail(p, p.owner.ip, { email: 'victim@example.test', emailOptIn: true });
  await identifyEmail(other, other.owner.ip, { email: 'e1@example.test', emailOptIn: true });

  const good = new URL(signUnsubscribeLink(p.project.id, 'e1@example.test'));
  const params = (change: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams(good.search);
    change(q);
    const text = q.toString();
    return `/api/email/unsubscribe${text ? `?${text}` : ''}`;
  };
  const s = good.searchParams.get('s')!;
  const confirm = new URL(signConfirmLink(p.project.id, 'e1@example.test', new Date()));

  const variants: Array<[string, string]> = [
    ['signature changed by one character', params((q) => q.set('s', `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`))],
    ['address re-encoded for someone else', params((q) => q.set('e', Buffer.from('victim@example.test').toString('base64url')))],
    ['project swapped', params((q) => q.set('p', other.project.id))],
    ['signature missing', params((q) => q.delete('s'))],
    ['no query at all', '/api/email/unsubscribe'],
    ['a confirmation link on the unsubscribe route', `/api/email/unsubscribe${confirm.search}`],
  ];

  for (const [label, path] of variants) {
    const shown = await publicRequest('GET', path);
    expect(shown.status, label).toBe(400);
    expect(shown.headers.get('content-type'), label).toMatch(/^text\/html/);
    expect(shown.text, label).toContain('<title>Link not valid</title>');
    expect(shown.text, label).toContain('<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>');

    const posted = await publicRequest('POST', path, { contentType: 'application/x-www-form-urlencoded', text: '' });
    expect(posted.status, label).toBe(400);
    expect(posted.headers.get('content-type'), label).toMatch(/^text\/plain/);
    expect(posted.text, label).toBe('This unsubscribe link is not valid.');

    const oneClick = await publicRequest('POST', path, {
      contentType: 'application/x-www-form-urlencoded',
      text: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status, label).toBe(400);
  }

  expect(await suppressionRows(p.project.id)).toHaveLength(0);
  expect(await suppressionRows(other.project.id)).toHaveLength(0);
  expect(
    await sql(`SELECT 1 FROM channel_suppressions WHERE project_id = ANY($1::uuid[])`, [[p.project.id, other.project.id]]),
  ).toHaveLength(0);
});
