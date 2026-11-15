import { DEFAULT_EMAIL_SENDER, emailWebhookPath, seedEmailCredentials } from '../../support/channels';
import { allowClipboard, readClipboard } from '../../support/browser-tools';
import { expect, openSidebarGroup, sidebarLink, signIn, test } from '../../support/fixtures';
import { stubCalls } from '../../support/provider-stub';
import { publicApiUrl } from '../../support/signing';
import {
  activityRows,
  call,
  campaignRow,
  card,
  cellTexts,
  credentialProviders,
  dataOf,
  emailLogs,
  emailProject,
  emailSettingsRow,
  emailSuppressionList,
  identifyEmail,
  messageOf,
  openEmail,
  optInSwitch,
  PROJECT_NOT_FOUND,
  providerTab,
  publicRequest,
  saveSender,
  seedCampaign,
  seedCampaignEvent,
  sql,
  suppress,
  suppressionRows,
  toastWith,
  webhookCode,
  whenLabel,
  type CampaignStatus,
} from '../../support/areas/email';

/**
 * Email, P1: the page shell (sidebar entry, URL, not-set-up states, other tenants'
 * projects), the campaign list (columns, statuses, channel filter, row links, subjects
 * as text), the suppression list (empty, refusals, channel), the Sender card (empty
 * form, reload, refusals, webhook token kept, from name made header-safe) and the
 * Provider card (format refusals, a Resend key without a signing secret, switching the
 * active provider, the webhook URL box and Copy, the pinned SES topic). Provider
 * connections are seeded or go to the provider stub; campaign rows and their events are
 * written as the worker and the webhook ingest leave them.
 */

test.describe.configure({ mode: 'parallel' });

const NOT_SET_UP_CARD = 'Email is not set up yet. Add a sender and connect a provider under Settings.';
const CAMPAIGNS_DESCRIPTION = 'Sent is what your provider accepted. Delivered, opened and bounced come from its delivery events.';

// ------------------------------------------------------------ A. Page shell ---

test(
  'EMAIL-001 Email in the sidebar opens the Email page',
  { annotation: { type: 'issue', description: 'EMAIL-001' } },
  async ({ page }) => {
    test.fail();
    const p = await emailProject('email-001', { provider: 'brevo' });
    await signIn(page, p.owner);
    await page.goto(`/projects/${p.project.id}`);

    await openSidebarGroup(page, 'Engagement');
    const group = page
      .locator('[data-sidebar="menu-item"]')
      .filter({ has: page.getByRole('button', { name: 'Engagement', exact: true }) });
    await expect(group.getByRole('link')).toHaveText(
      ['Audiences', 'In-App Messages', 'Push Notifications', 'Email', 'SMS', 'WhatsApp', 'Journeys'],
      { timeout: 5_000 },
    );

    await sidebarLink(page, 'Email').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));
    await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
    await expect(sidebarLink(page, 'Email')).toHaveAttribute('data-active', 'true');

    await page.getByRole('link', { name: 'New email' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email/new$`));
    await expect(sidebarLink(page, 'Email')).toHaveAttribute('data-active', 'true');
  },
);

test('EMAIL-002 open the Email page by URL', async ({ page }) => {
  const p = await emailProject('email-002', { provider: 'brevo' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email`);

  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Campaigns sent through your own Amazon SES, Resend or Brevo account, with the same audiences, schedules and experiments as push.',
      { exact: true },
    ),
  ).toBeVisible();
  const newEmail = page.getByRole('link', { name: 'New email' });
  await expect(newEmail).toBeVisible();
  await expect(newEmail).not.toHaveAttribute('disabled');
  for (const name of ['Campaigns', 'Suppressions', 'Settings']) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  // The list has loaded (its empty state), so the absence below is not a page still loading.
  await expect(page.getByText('No email campaigns yet.', { exact: true })).toBeVisible();
  await expect(page.getByText(NOT_SET_UP_CARD, { exact: true })).toHaveCount(0);
});

test('EMAIL-003 not set up: warning card on Campaigns', async ({ page }) => {
  const p = await emailProject('email-003');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email`);

  await expect(page.getByRole('tab', { name: 'Campaigns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(NOT_SET_UP_CARD, { exact: true })).toBeVisible();
  await expect(card(page, 'Campaigns')).toContainText(CAMPAIGNS_DESCRIPTION);
  await expect(page.getByText('No email campaigns yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first email' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New email' })).toHaveAttribute('disabled');
});

test('EMAIL-004 sender saved but no provider still counts as not set up', async ({ page }) => {
  const p = await emailProject('email-004', { sender: true });
  const status = dataOf(await call('GET', `/api/email/settings/${p.project.id}`, p.owner));
  expect(status).toMatchObject({ configured: true, readyToSend: false, providers: [] });

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email`);
  await expect(page.getByText(NOT_SET_UP_CARD, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('From address')).toHaveValue(DEFAULT_EMAIL_SENDER.fromEmail);
  await expect(page.getByLabel('Postal address')).toHaveValue(DEFAULT_EMAIL_SENDER.postalAddress);
  for (const label of ['Resend', 'Amazon SES', 'Brevo'] as const) {
    await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: 'Resend', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /Active/ })).toHaveCount(0);
  await expect(card(page, 'Send a test')).toHaveCount(0);
});

test('EMAIL-009 unknown, foreign or malformed project id', async ({ page }) => {
  const mine = await emailProject('email-009', { provider: 'brevo' });
  const other = await emailProject('email-009-other');
  const otherSender = 'secret-sender@other.example.test';
  const otherSuppressed = 'other-secret@example.test';
  await saveSender(other.owner, other.project.id, { fromEmail: otherSender, fromName: 'Other Tenant News' });
  await suppress(other.owner, other.project.id, otherSuppressed);
  // Positive control: the other tenant reads its own settings and suppressions.
  expect(dataOf(await call('GET', `/api/email/settings/${other.project.id}`, other.owner)).settings.fromEmail).toBe(otherSender);
  expect((await emailSuppressionList(other.owner, other.project.id)).total).toBe(1);

  for (const path of [`/api/email/settings/${other.project.id}`, `/api/email/suppressions/${other.project.id}`, '/api/email/settings/not-a-uuid']) {
    const refused = await call('GET', path, mine.owner);
    expect(refused.status, path).toBe(404);
    expect(messageOf(refused), path).toBe(PROJECT_NOT_FOUND);
  }

  const emailAnswers: Array<{ url: string; status: number }> = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/email/')) emailAnswers.push({ url: response.url(), status: response.status() });
  });
  await signIn(page, mine.owner);
  for (const id of [other.project.id, 'not-a-uuid']) {
    await page.goto(`/projects/${id}/email`);
    await page.waitForLoadState('networkidle');
    const shown = await page.evaluate(() =>
      [
        document.body.innerText,
        ...Array.from(document.querySelectorAll('input, textarea')).map((field) => (field as HTMLInputElement).value),
      ].join('\n'),
    );
    expect(shown).not.toContain(otherSender);
    expect(shown).not.toContain('Other Tenant News');
    expect(shown).not.toContain(otherSuppressed);
  }
  expect(emailAnswers.filter((answer) => answer.status < 400)).toEqual([]);
});

// ------------------------------------------------------------ B. Campaign list ---

test('EMAIL-011 configured, no campaigns: first-email call to action', async ({ page }) => {
  const p = await emailProject('email-011', { provider: 'brevo' });
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  await expect(page.getByText('No email campaigns yet.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Create your first email' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email/new$`));
  await expect(page.getByRole('heading', { name: 'New email', exact: true })).toBeVisible();
});

test('EMAIL-013 columns and row content', async ({ page }) => {
  const p = await emailProject('email-013', { provider: 'brevo' });
  const campaignId = await seedCampaign(p.project.id, { subject: 'Spring sale', status: 'sent', totalTokens: 10, successCount: 9, processedTokens: 10 });
  const people: string[] = [];
  for (let i = 0; i < 4; i += 1) people.push(await identifyEmail(p, p.owner.ip, { email: `e13-${i}@example.test`, emailOptIn: true }));
  for (const id of people) await seedCampaignEvent(p.project.id, campaignId, id, 'delivered');
  for (const id of people.slice(0, 3)) await seedCampaignEvent(p.project.id, campaignId, id, 'impression');
  await seedCampaignEvent(p.project.id, campaignId, people[0], 'click');
  await seedCampaignEvent(p.project.id, campaignId, people[3], 'bounced');
  const [log] = await emailLogs(p.owner, p.project.id);

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  const headers = card(page, 'Campaigns').getByRole('columnheader');
  await expect(headers).toHaveText(['Subject', 'Status', 'Sent', 'Delivered', 'Opened', 'CTR', 'Bounced', 'When']);
  const row = campaignRow(page, 'Spring sale');
  await expect(row).toBeVisible();
  expect(await cellTexts(row)).toEqual(['Spring sale', 'Sent', '9/10', '4', '3', '25%', '1', whenLabel(new Date(log.sentAt))]);
});

test('EMAIL-014 status labels for every status', async ({ page }) => {
  const p = await emailProject('email-014', { provider: 'brevo' });
  const labels: Record<CampaignStatus, string> = {
    scheduled: 'Scheduled',
    queued: 'Queued',
    sending: 'Sending',
    sent: 'Sent',
    failed: 'Failed',
    partial: 'Partial',
    expanded: 'Split',
    cancelled: 'Cancelled',
  };
  for (const status of Object.keys(labels) as CampaignStatus[]) {
    await seedCampaign(p.project.id, {
      subject: `Status ${status}`,
      status,
      scheduledAt: status === 'scheduled' ? new Date(Date.now() + 30 * 24 * 3600 * 1000) : null,
    });
  }

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  for (const [status, label] of Object.entries(labels)) {
    await expect(campaignRow(page, `Status ${status}`).getByRole('cell').nth(1), status).toHaveText(label);
  }
  await expect(card(page, 'Campaigns').getByText('By timezone', { exact: true })).toHaveCount(0);
});

test('EMAIL-017 only email campaigns appear; push campaigns do not', async ({ page }) => {
  const p = await emailProject('email-017', { provider: 'brevo' });
  const emailId = await seedCampaign(p.project.id, { subject: 'The email one' });
  await seedCampaign(p.project.id, { subject: 'The push one', channel: 'push' });
  await seedCampaign(p.project.id, { subject: 'The sms one', channel: 'sms' });
  // Positive control: unfiltered, the logs route returns all three.
  const all = dataOf(await call('GET', `/api/push-notifications/logs/${p.project.id}`, p.owner));
  expect(all.data).toHaveLength(3);

  const emails = await emailLogs(p.owner, p.project.id);
  expect(emails.map((log) => [log.id, log.channel])).toEqual([[emailId, 'email']]);

  const fax = await call('GET', `/api/push-notifications/logs/${p.project.id}?channel=fax`, p.owner);
  expect(fax.status).toBe(400);
  expect(messageOf(fax)).toBe('channel must be one of: push, email, sms, whatsapp');

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  await expect(campaignRow(page, 'The email one')).toBeVisible();
  await expect(card(page, 'Campaigns').getByRole('row')).toHaveCount(2);
  await expect(page.getByText('The push one')).toHaveCount(0);
  await expect(page.getByText('The sms one')).toHaveCount(0);
});

test('EMAIL-019 clicking a row opens the shared campaign page', async ({ page }) => {
  const p = await emailProject('email-019', { provider: 'brevo' });
  const id = await seedCampaign(p.project.id, { subject: 'Row to open', totalTokens: 3, successCount: 3 });

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  await campaignRow(page, 'Row to open').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/push-notifications/${id}$`));
  const title = page.getByRole('heading', { name: 'Row to open', level: 1 });
  await expect(title).toBeVisible();
  await expect(title.locator('..').getByText('Email', { exact: true })).toBeVisible();

  await page.getByRole('link').filter({ has: page.locator('svg.lucide-arrow-left') }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
  await expect(campaignRow(page, 'Row to open')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/push-notifications/${id}$`));
  await expect(title).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));
  await expect(campaignRow(page, 'Row to open')).toBeVisible();
});

test('EMAIL-020 subject with HTML is shown as text in the list', async ({ page }) => {
  const p = await emailProject('email-020', { provider: 'brevo' });
  const subject = '<img src=x onerror=alert(1)>Deal';
  await seedCampaign(p.project.id, { subject });
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Campaigns');
  const row = campaignRow(page, subject);
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell').first()).toHaveText(subject);
  await expect(row.locator('img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

// ------------------------------------------------------------ C. Suppressions ---

test('EMAIL-021 empty suppression list', async ({ page }) => {
  const p = await emailProject('email-021', { provider: 'brevo' });
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Suppressions');
  const list = card(page, 'Suppressed addresses');
  await expect(list).toContainText(
    'Never emailed, whatever the campaign. Unsubscribes, hard bounces and spam complaints are added automatically.',
  );
  await expect(list.getByPlaceholder('someone@example.com')).toBeVisible();
  await expect(list.getByRole('button', { name: 'Suppress' })).toBeDisabled();
  await expect(list.getByText('Nobody is suppressed.', { exact: true })).toBeVisible();
});

test('EMAIL-030 invalid address: toast and nothing stored', async ({ page }) => {
  const p = await emailProject('email-030', { provider: 'brevo' });
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Suppressions');
  const input = page.getByPlaceholder('someone@example.com');
  await input.fill('a@b');
  await page.getByRole('button', { name: 'Suppress' }).click();
  await expect(page.getByText('That is not a valid address', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('a@b');
  await expect(page.getByText('Nobody is suppressed.', { exact: true })).toBeVisible();

  const notAnEmail = await call('POST', '/api/email/suppressions', p.owner, { projectId: p.project.id, address: 'not-an-email' });
  expect(notAnEmail.status).toBe(400);
  expect(messageOf(notAnEmail)).toContain('address must be an email');
  const badReason = await call('POST', '/api/email/suppressions', p.owner, {
    projectId: p.project.id,
    address: 'fine@example.test',
    reason: 'spam',
  });
  expect(badReason.status).toBe(400);
  expect(messageOf(badReason)).toContain('reason must be one of the following values: unsubscribed, bounced, complained, manual');
  expect(await suppressionRows(p.project.id)).toEqual([]);
});

test('EMAIL-034 only email suppressions are listed', async () => {
  const p = await emailProject('email-034', { provider: 'brevo' });
  const sms = await call('POST', '/api/sms/suppressions', p.owner, { projectId: p.project.id, address: '+919876543210' });
  expect(sms.status).toBe(201);
  await suppress(p.owner, p.project.id, 'e1@example.test');
  // Positive control: the SMS row is stored and listed under SMS.
  const smsList = dataOf(await call('GET', `/api/sms/suppressions/${p.project.id}`, p.owner));
  expect(smsList.data.map((row: any) => row.address)).toEqual(['+919876543210']);

  const list = await emailSuppressionList(p.owner, p.project.id);
  expect(list.total).toBe(1);
  expect(list.data.map((row) => [row.channel, row.address])).toEqual([['email', 'e1@example.test']]);
});

// ------------------------------------------------------------ D. Sender card ---

test('EMAIL-038 Sender card on a new project', async ({ page }) => {
  const p = await emailProject('email-038');
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');

  const sender = card(page, 'Sender');
  await expect(sender).toContainText(
    'Who your emails come from. The from address must be on a domain you have verified with your provider.',
  );
  const fields: Array<[string, string]> = [
    ['From address', 'hello@yourapp.com'],
    ['From name', 'Your App'],
    ['Reply-to (optional)', 'support@yourapp.com'],
    ['Postal address', 'Your Company Pvt Ltd\n12 MG Road, Bengaluru 560001, India'],
  ];
  for (const [label, placeholder] of fields) {
    await expect(page.getByLabel(label)).toHaveValue('');
    await expect(page.getByLabel(label)).toHaveAttribute('placeholder', placeholder);
  }
  await expect(
    sender.getByText(
      'Printed in every email footer. Anti-spam law (CAN-SPAM) requires a physical address in marketing email.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(optInSwitch(page)).toBeChecked();
  await expect(sender).toContainText('On: only people whose app sent emailOptIn: true.');
  await expect(page.getByRole('button', { name: 'Save sender' })).toBeDisabled();
  await expect(card(page, 'Provider')).toContainText('Save the sender first, then connect Amazon SES, Resend or Brevo.');
  await expect(card(page, 'Send a test')).toHaveCount(0);
});

test('EMAIL-041 values survive a reload', async ({ page }) => {
  const p = await emailProject('email-041');
  const saved = {
    fromEmail: 'kept@e2e.example.test',
    fromName: 'Kept Name',
    replyTo: 'help@e2e.example.test',
    postalAddress: 'Kept Ltd\n2 Side Road, Pune 411002',
    requireOptIn: false,
  };
  await saveSender(p.owner, p.project.id, saved);

  await signIn(page, p.owner);
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass === 1) await page.reload();
    await openEmail(page, p.project.id, 'Settings');
    await expect(page.getByLabel('From address')).toHaveValue(saved.fromEmail);
    await expect(page.getByLabel('From name')).toHaveValue(saved.fromName);
    await expect(page.getByLabel('Reply-to (optional)')).toHaveValue(saved.replyTo);
    await expect(page.getByLabel('Postal address')).toHaveValue(saved.postalAddress);
    await expect(optInSwitch(page)).not.toBeChecked();
  }
});

test('EMAIL-045 invalid from address', async ({ page }) => {
  const p = await emailProject('email-045');
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await page.getByLabel('From address').fill('news@example');
  await page.getByLabel('Postal address').fill('Acme Ltd, 1 Main Road');
  await page.getByRole('button', { name: 'Save sender' }).click();
  await expect(toastWith(page, 'Could not save', 'fromEmail must be an email')).toBeVisible();

  const nope = await call('POST', '/api/email/settings', p.owner, {
    projectId: p.project.id,
    fromEmail: 'nope',
    postalAddress: 'Acme Ltd, 1 Main Road',
  });
  expect(nope.status).toBe(400);
  expect(messageOf(nope)).toBe('fromEmail must be an email');
  expect(await emailSettingsRow(p.project.id)).toBeUndefined();
});

test('EMAIL-049 sender save does not undo a webhook URL replacement', async () => {
  const p = await emailProject('email-049', { provider: 'brevo' });
  const topic = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events';
  await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, topic]);
  const t1 = (await emailSettingsRow(p.project.id))!.webhook_token as string;
  const event = { contentType: 'application/json', text: JSON.stringify({ event: 'delivered', email: 'nobody@example.test' }) };
  expect((await publicRequest('POST', emailWebhookPath('brevo', t1), event)).status).toBe(200);

  dataOf(await call('POST', `/api/email/settings/${p.project.id}/rotate-webhook-token`, p.owner));
  const t2 = (await emailSettingsRow(p.project.id))!.webhook_token as string;
  expect(t2).not.toBe(t1);

  await saveSender(p.owner, p.project.id, { fromName: 'A New Name' });
  const after = (await emailSettingsRow(p.project.id))!;
  expect(after.from_name).toBe('A New Name');
  expect(after.webhook_token).toBe(t2);
  expect(after.ses_topic_arn).toBe(topic);
  expect((await publicRequest('POST', emailWebhookPath('brevo', t1), event)).status).toBe(404);
  expect((await publicRequest('POST', emailWebhookPath('brevo', t2), event)).status).toBe(200);
});

test('EMAIL-050 header injection in the from name is neutralised', async () => {
  const p = await emailProject('email-050', { provider: 'resend' });
  const typed = 'Acme\r\nBcc: victim@example.test';
  await saveSender(p.owner, p.project.id, { fromName: typed });
  expect((await emailSettingsRow(p.project.id))!.from_name).toBe(typed);

  const to = `header-check-${Date.now().toString(36)}@example.test`;
  const sent = dataOf(
    await call('POST', '/api/email/test-send', p.owner, { projectId: p.project.id, to, subject: 'Header check', html: '<p>Hi</p>' }),
  );
  expect(sent).toEqual({ delivered: true });
  const calls = (await stubCalls('resend')).filter(
    (entry) => entry.method === 'POST' && ((entry.body as { to?: string[] } | null)?.to ?? []).includes(to),
  );
  expect(calls).toHaveLength(1);
  const body = calls[0].body as { from: string; headers?: Record<string, string>; bcc?: unknown };
  expect(body.from).toBe(`"Acme Bcc: victim@example.test" <${DEFAULT_EMAIL_SENDER.fromEmail}>`);
  expect(body.bcc).toBeUndefined();
  expect(Object.keys(body.headers ?? {}).map((name) => name.toLowerCase())).not.toContain('bcc');
});

// ------------------------------------------------------------ E. Provider card ---

test('EMAIL-056 Resend key format refused before any request', async ({ page }) => {
  const p = await emailProject('email-056', { sender: true });
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Resend')).toHaveAttribute('aria-selected', 'true');

  await page.getByLabel('API key').fill('sk_live_123');
  await page.getByRole('button', { name: 'Connect Resend' }).click();
  await expect(toastWith(page, 'Could not connect', 'A Resend API key starts with "re_".')).toBeVisible();

  await page.getByLabel('API key').fill('re_abc');
  await page.getByLabel('Webhook signing secret').fill('secret123');
  await page.getByRole('button', { name: 'Connect Resend' }).click();
  await expect(toastWith(page, 'Could not connect', 'A Resend webhook signing secret starts with "whsec_".')).toBeVisible();

  expect(await credentialProviders(p.project.id)).toEqual([]);
  expect((await emailSettingsRow(p.project.id))!.provider).toBeNull();
  expect(await activityRows(p.project.id, 'channel.provider_changed')).toEqual([]);
});

test('EMAIL-059 Resend stored without a webhook secret warns', async ({ page }) => {
  const p = await emailProject('email-059', { sender: true });
  const apiKey = `re_e2e_nosecret${Date.now().toString(36)}`;
  await seedEmailCredentials(p.project.id, 'resend', { credentials: { apiKey } });
  const status = dataOf(await call('GET', `/api/email/settings/${p.project.id}`, p.owner));
  expect(status.providers).toEqual([{ provider: 'resend', keyHint: apiKey.slice(-4), hasWebhookSecret: false }]);

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Resend')).toHaveAttribute('aria-selected', 'true');
  await expect(providerTab(page, 'Resend')).toContainText('Active');
  const stored = page.locator('p').filter({ hasText: `Key ending ${apiKey.slice(-4)} is stored.` });
  await expect(stored).toContainText('No webhook secret: bounces and opens will not be recorded.');
  await expect(
    page.getByText(
      'In Resend, add a webhook for email.delivered, opened, clicked, bounced and complained pointing at this URL, then paste its signing secret above.',
      { exact: true },
    ),
  ).toBeVisible();
});

test('EMAIL-060 Brevo form, SMTP key and wrong key refused', async ({ page }) => {
  const p = await emailProject('email-060', { sender: true });
  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await providerTab(page, 'Brevo').click();
  const key = page.getByLabel('API key');
  await expect(key).toHaveAttribute('placeholder', 'xkeysib-...');
  await expect(
    page.getByText(
      "From SMTP & API → API Keys in Brevo. Not the SMTP key. If your Brevo account restricts API access to authorised IPs, add this server's IP there or sends will be refused.",
      { exact: true },
    ),
  ).toBeVisible();

  await key.fill('xsmtpsib-abc');
  await page.getByRole('button', { name: 'Connect Brevo' }).click();
  await expect(
    toastWith(
      page,
      'Could not connect',
      'That is a Brevo SMTP key. Create an API key (it starts with "xkeysib-") under SMTP & API → API Keys.',
    ),
  ).toBeVisible();

  await key.fill('abc123');
  await page.getByRole('button', { name: 'Connect Brevo' }).click();
  await expect(toastWith(page, 'Could not connect', 'A Brevo API key starts with "xkeysib-".')).toBeVisible();
  expect(await credentialProviders(p.project.id)).toEqual([]);
});

test('EMAIL-068 switching active provider keeps the other\'s credentials', async ({ page }) => {
  const p = await emailProject('email-068', { sender: true });
  const resend = await seedEmailCredentials(p.project.id, 'resend', { activate: false });
  const brevo = await seedEmailCredentials(p.project.id, 'brevo');

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Brevo')).toContainText('Active');
  await providerTab(page, 'Resend').click();
  await expect(page.getByText(`Key ending ${resend.credentials.apiKey.slice(-4)} is stored.`)).toBeVisible();
  // The same key and secret as stored: only the active provider changes (the stub's Resend accepts the key).
  await page.getByLabel('API key').fill(resend.credentials.apiKey);
  await page.getByLabel('Webhook signing secret').fill(resend.credentials.webhookSecret!);
  await page.getByRole('button', { name: 'Replace and use Resend' }).click();
  await expect(page.getByText('Resend connected', { exact: true })).toBeVisible();
  await expect(providerTab(page, 'Resend')).toContainText('Active');

  await page.reload();
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Resend')).toContainText('Active');
  await expect(providerTab(page, 'Brevo')).not.toContainText('Active');
  await providerTab(page, 'Brevo').click();
  await expect(page.getByText(`Key ending ${brevo.credentials.apiKey.slice(-4)} is stored.`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace and use Brevo' })).toBeVisible();
  expect(await credentialProviders(p.project.id)).toEqual(['brevo', 'resend']);

  const changed = await activityRows(p.project.id, 'channel.provider_changed');
  expect(changed.map((row) => row.details)).toEqual([{ channel: 'email', fields: ['provider'] }]);

  // Reconnecting the active provider with what it already holds logs nothing; a new key logs an upload.
  const same = JSON.stringify({ apiKey: resend.credentials.apiKey, webhookSecret: resend.credentials.webhookSecret });
  dataOf(await call('POST', '/api/email/providers', p.owner, { projectId: p.project.id, provider: 'resend', credentials: same }));
  expect(await activityRows(p.project.id, 'channel.credentials_uploaded')).toEqual([]);
  const fresh = JSON.stringify({ apiKey: `${resend.credentials.apiKey}x`, webhookSecret: resend.credentials.webhookSecret });
  dataOf(await call('POST', '/api/email/providers', p.owner, { projectId: p.project.id, provider: 'resend', credentials: fresh }));
  const uploaded = await activityRows(p.project.id, 'channel.credentials_uploaded');
  expect(uploaded.map((row) => row.details)).toEqual([{ channel: 'email', fields: ['credentials'] }]);
  expect(await activityRows(p.project.id, 'channel.provider_changed')).toHaveLength(1);
});

test('EMAIL-070 webhook URL box per tab, and Copy', async ({ page }) => {
  const p = await emailProject('email-070', { provider: 'brevo' });
  const token = (await emailSettingsRow(p.project.id))!.webhook_token as string;

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await allowClipboard(page);
  for (const [label, provider] of [['Resend', 'resend'], ['Amazon SES', 'ses'], ['Brevo', 'brevo']] as const) {
    await providerTab(page, label).click();
    await expect(webhookCode(page)).toHaveText(publicApiUrl(`/api/email/webhooks/${provider}/${token}`));
  }
  const box = page.locator('div.rounded-md.border').filter({ has: page.getByText('Delivery events', { exact: true }) });
  await expect(box).toContainText(
    'Brevo does not sign webhooks, so keep this URL private: it is the only thing that authenticates them.',
  );
  await box.getByRole('button').filter({ has: page.locator('svg.lucide-copy') }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await readClipboard(page)).toBe(publicApiUrl(`/api/email/webhooks/brevo/${token}`));
});

test('EMAIL-075 pinned SES topic shown with Switch topic', async ({ page }) => {
  const p = await emailProject('email-075', { provider: 'ses' });
  const topic = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events';
  await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, topic]);
  const pinned = page.getByText(`Accepting events from ${topic}`, { exact: true });

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Amazon SES')).toHaveAttribute('aria-selected', 'true');
  await expect(pinned).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch topic' })).toBeVisible();

  for (const label of ['Resend', 'Brevo'] as const) {
    await providerTab(page, label).click();
    await expect(webhookCode(page)).toBeVisible();
    await expect(pinned).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Switch topic' })).toHaveCount(0);
  }

  // With nothing pinned, the SES tab shows no topic line either.
  await sql(`UPDATE email_settings SET ses_topic_arn = NULL WHERE project_id = $1`, [p.project.id]);
  await page.reload();
  await openEmail(page, p.project.id, 'Settings');
  await expect(providerTab(page, 'Amazon SES')).toHaveAttribute('aria-selected', 'true');
  await expect(webhookCode(page)).toBeVisible();
  await expect(page.getByText(/^Accepting events from/)).toHaveCount(0);
});

test('EMAIL-076 Switch topic clears the pinned topic', async ({ page }) => {
  const p = await emailProject('email-076', { provider: 'ses' });
  const topic = 'arn:aws:sns:ap-south-1:123456789012:chumbaq-events';
  await sql(`UPDATE email_settings SET ses_topic_arn = $2 WHERE project_id = $1`, [p.project.id, topic]);
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await signIn(page, p.owner);
  await openEmail(page, p.project.id, 'Settings');
  const pinned = page.getByText(`Accepting events from ${topic}`, { exact: true });
  await expect(pinned).toBeVisible();
  await page.getByRole('button', { name: 'Switch topic' }).click();
  await expect(pinned).toHaveCount(0);
  expect(dialogs).toEqual([]);

  expect((await emailSettingsRow(p.project.id))!.ses_topic_arn).toBeNull();
  expect(await activityRows(p.project.id, 'email.ses_topic_reset')).toHaveLength(1);
});
