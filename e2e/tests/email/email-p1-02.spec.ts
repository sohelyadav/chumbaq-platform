import { randomBytes } from 'crypto';
import { apiUrl, uniqueEmail } from '../../support/api';
import { seedEmailCredentials } from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import { pathAndQuery, signConfirmLink, signUnsubscribeLink } from '../../support/signing';
import {
  armBox,
  brevoCallsTo,
  call,
  campaignJob,
  campaignRows,
  card,
  confirmEmail,
  CONNECT_FIRST,
  createLiveSegment,
  dataOf,
  emailPreview,
  emailProject,
  emailSettingsRow,
  holdPosts,
  identifyDevice,
  identifyEmail,
  identityRows,
  markConfirmSent,
  messageOf,
  NOT_SET_UP,
  PEOPLE,
  planIs,
  projectActivity,
  publicRequest,
  reachLine,
  recordPosts,
  seedCampaign,
  seedCampaignEvent,
  seedPeople,
  sql,
  statTile,
  STOPPED_BY_SUSPENSION,
  suppress,
  SUPPRESSED,
  suppressionRows,
  suspendAccount,
  toastWith,
  type EmailProject,
} from '../../support/areas/email';

/**
 * Email, P1: the test send (an erased suppression, the API's refusals), the composer
 * (layout, preview, button states, reach, segments, timezone sends, A/B arms, the test
 * button, a project not ready), the send and preview APIs (validation, explicit people,
 * other tenants' segments), the shared campaign page for an email campaign (content,
 * engagement, delivery failures, stop reasons), a queued campaign whose provider went
 * away, and the unsubscribe and confirmation pages (escaping, old links, suspension, an
 * older send, a suppressed address). Providers are seeded or reach the provider stub;
 * campaign rows and events are written as the worker and the webhook ingest leave them.
 */

test.describe.configure({ mode: 'parallel' });

const FORM = { contentType: 'application/x-www-form-urlencoded', text: '' };

const testSend = (as: EmailProject['owner'], projectId: string, body: Record<string, unknown> = {}) =>
  call('POST', '/api/email/test-send', as, { projectId, to: 'qa@example.test', subject: 'Test', html: '<p>Test</p>', ...body });

const sendEmail = (as: EmailProject['owner'], projectId: string, body: Record<string, unknown> = {}) =>
  call('POST', '/api/email/send', as, { projectId, subject: 'Hello', html: '<p>Hello</p>', ...body });

const monthAhead = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

/** The composer's back link (the sidebar also has an `Email` link). */
const backLink = (page: import('@playwright/test').Page, projectId: string) =>
  page.locator(`a[href="/projects/${projectId}/email"]`).filter({ has: page.locator('svg.lucide-arrow-left') });

const sendButton = (page: import('@playwright/test').Page, name = 'Send email') =>
  card(page, 'Preview').getByRole('button', { name, exact: true });

// ------------------------------------------------------------ F. Send a test ---

test('EMAIL-083 test send to an address whose suppression was erased', async () => {
  const p = await emailProject('email-083', { provider: 'brevo', requireOptIn: false });
  const gone = uniqueEmail('email-083-gone');
  const person = await identifyEmail(p, p.owner.ip, { email: gone, emailOptIn: true });
  await suppress(p.owner, p.project.id, gone);

  const erased = await call('DELETE', `/api/projects/${p.project.id}/users/${person}`, p.owner);
  expect(erased.status).toBe(200);
  // The suppression now lives only as a keyed hash.
  expect(await suppressionRows(p.project.id)).toEqual([]);
  expect(await sql(`SELECT 1 FROM erased_suppressions WHERE project_id = $1 AND channel = 'email'`, [p.project.id])).toHaveLength(1);
  expect(await identityRows(p.project.id, gone)).toEqual([]);

  const answered = await testSend(p.owner, p.project.id, { to: gone });
  expect(answered.status).toBe(201);
  expect(dataOf(answered)).toEqual({ delivered: false, error: SUPPRESSED });
  expect(await brevoCallsTo(gone)).toHaveLength(0);

  // An address with no hash behind it goes out, so the refusal above is the hash.
  const other = uniqueEmail('email-083-other');
  expect(dataOf(await testSend(p.owner, p.project.id, { to: other }))).toEqual({ delivered: true });
  expect(await brevoCallsTo(other)).toHaveLength(1);
});

test('EMAIL-084 test send API refusals', async () => {
  const blank = await emailProject('email-084-blank');
  const sender = await emailProject('email-084-sender', { sender: true });
  const ready = await emailProject('email-084', { provider: 'brevo' });
  const before = await projectActivity(ready.project.id);
  const blankBefore = await projectActivity(blank.project.id);

  const notSetUp = await testSend(blank.owner, blank.project.id);
  expect(notSetUp.status).toBe(404);
  expect(messageOf(notSetUp)).toBe(NOT_SET_UP);

  const noProvider = await testSend(sender.owner, sender.project.id);
  expect(noProvider.status).toBe(400);
  expect(messageOf(noProvider)).toBe(CONNECT_FIRST);

  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ to: 'x' }, 'to must be an email'],
    [{ subject: '' }, 'subject must be longer than or equal to 1 characters'],
    [{ html: '' }, 'html must be longer than or equal to 1 characters'],
    [{ subject: 's'.repeat(256) }, 'subject must be shorter than or equal to 255 characters'],
  ];
  for (const [body, message] of invalid) {
    const refused = await testSend(ready.owner, ready.project.id, body);
    expect(refused.status, message).toBe(400);
    expect(messageOf(refused)).toBe(message);
  }

  // The same request with valid fields is accepted, and a test send logs nothing.
  const to = uniqueEmail('email-084');
  expect(dataOf(await testSend(ready.owner, ready.project.id, { to, subject: 's'.repeat(255) }))).toEqual({ delivered: true });
  expect(await projectActivity(ready.project.id)).toEqual(before);
  expect(await projectActivity(blank.project.id)).toEqual(blankBefore);
  expect(await campaignRows(ready.project.id)).toHaveLength(0);
});

// ------------------------------------------------------------ G. Composer ---

test('EMAIL-085 composer layout and defaults', async ({ page }) => {
  const p = await emailProject('email-085', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);

  await signIn(page, p.owner);
  const release = await holdPosts(page, '/api/email/audience-preview');
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(page.getByRole('heading', { name: 'New email', exact: true })).toBeVisible();
  await expect(reachLine(page)).toHaveText('Counting…');
  release();
  await expect(reachLine(page)).toHaveText('2 recipient(s)');

  await expect(backLink(page, p.project.id)).toHaveText('Email');
  await expect(card(page, 'Message').locator('[data-slot="card-description"]')).toHaveText(
    'Personalise with {{firstName}} or {{trait.plan|free}}. Place the unsubscribe link with {{unsubscribe_url}}, or one is added to the footer.',
  );
  await expect(page.getByLabel('Subject')).toHaveValue('');
  await expect(page.getByLabel('Preview text (optional)')).toHaveAttribute('placeholder', 'Shown next to the subject in the inbox');
  const html = await page.getByLabel('HTML', { exact: true }).inputValue();
  expect(html).toContain('<h1>Hi {{firstName|there}},</h1>');
  expect(html).toContain('<p>Write your message here.</p>');
  expect(html).toContain('<a href="https://yourapp.com">');
  await expect(page.getByLabel('Plain text (optional)')).toHaveAttribute('placeholder', 'Generated from the HTML when left empty');

  const audience = card(page, 'Audience').getByRole('combobox');
  await expect(audience).toHaveCount(1);
  await expect(audience).toHaveText('Everyone');
  const when = card(page, 'When');
  await expect(when.getByText('Schedule for later', { exact: true })).toBeVisible();
  await expect(when.getByText("Deliver in each recipient's timezone", { exact: true })).toBeVisible();
  await expect(when.getByRole('switch')).toHaveCount(2);
  for (const toggle of await when.getByRole('switch').all()) await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card(page, 'A/B test').getByRole('switch')).toHaveAttribute('aria-checked', 'false');

  await expect(card(page, 'Preview').locator('[data-slot="card-description"]')).toHaveText('(no subject)');
  await expect(sendButton(page)).toBeDisabled();
  // A subject is all it was missing.
  await page.getByLabel('Subject').fill('Hello');
  await expect(sendButton(page)).toBeEnabled();
});

test('EMAIL-087 preview follows subject, preheader and HTML', async ({ page }) => {
  const p = await emailProject('email-087', { provider: 'brevo' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  const description = card(page, 'Preview').locator('[data-slot="card-description"]');
  const preview = page.frameLocator('iframe[title="Email preview"]');
  await expect(preview.getByText('Write your message here.', { exact: true })).toBeVisible();

  await page.getByLabel('Subject').fill('Big news');
  await expect(description).toHaveText('Big news');
  await page.getByLabel('Preview text (optional)').fill('Read inside');
  await expect(description).toHaveText('Big news — Read inside');
  await page.getByLabel('HTML', { exact: true }).fill('<p>Hello there</p>');
  await expect(preview.getByText('Hello there', { exact: true })).toBeVisible();
  await expect(preview.getByText('Write your message here.', { exact: true })).toHaveCount(0);
});

test('EMAIL-090 send stays disabled until subject and HTML have content', async ({ page }) => {
  const p = await emailProject('email-090', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('1 recipient(s)');

  await page.getByLabel('Subject').fill('   ');
  await expect(sendButton(page)).toBeDisabled();
  await page.getByLabel('Subject').fill('Hi');
  await page.getByLabel('HTML', { exact: true }).fill('');
  await expect(sendButton(page)).toBeDisabled();
  await page.getByLabel('HTML', { exact: true }).fill('<p>x</p>');
  await expect(sendButton(page)).toBeEnabled();
});

test('EMAIL-091 reach states: none opted in', async ({ page }) => {
  const p = await emailProject('email-091', { provider: 'brevo', requireOptIn: true });
  const { E1 } = await seedPeople(p, p.owner.ip, ['E1']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);

  await expect(card(page, 'Audience').locator('[data-slot="card-description"]')).toHaveText(
    'People with an email address who have not unsubscribed or bounced, and who opted in.',
  );
  const nobody = reachLine(page).locator('span.text-destructive');
  await expect(nobody).toHaveText('Nobody here can be emailed (no one has opted in yet).');
  await page.getByLabel('Subject').fill('Hello');
  await expect(page.getByLabel('HTML', { exact: true })).not.toHaveValue('');
  await expect(sendButton(page)).toBeDisabled();

  // Once someone is confirmed the same form can send.
  await confirmEmail(E1);
  await page.reload();
  await expect(reachLine(page)).toHaveText('1 recipient(s)');
  await page.getByLabel('Subject').fill('Hello');
  await expect(sendButton(page)).toBeEnabled();
});

test('EMAIL-093 choose a segment', async ({ page }) => {
  const p = await emailProject('email-093', { provider: 'brevo', requireOptIn: false });
  await identifyEmail(p, p.owner.ip, { ...PEOPLE.E1, traits: { plan: 'pro' } });
  await identifyEmail(p, p.owner.ip, { ...PEOPLE.E2, traits: { plan: 'pro' } });
  await identifyEmail(p, p.owner.ip, { ...PEOPLE.E5, traits: { plan: 'free' } });
  const tag = randomBytes(2).toString('hex');
  const two = { name: `S-two ${tag}`, id: await createLiveSegment(p.owner, p.project.id, `S-two ${tag}`, planIs('pro')) };
  const none = { name: `S-none ${tag}`, id: await createLiveSegment(p.owner, p.project.id, `S-none ${tag}`, planIs('nobody')) };

  await signIn(page, p.owner);
  const previews = recordPosts(page, '/api/email/audience-preview');
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('3 recipient(s)');
  await page.getByLabel('Subject').fill('For pro users');

  const selects = card(page, 'Audience').getByRole('combobox');
  await selects.first().click();
  await page.getByRole('option', { name: 'A segment', exact: true }).click();
  await expect(selects).toHaveCount(2);
  await expect(selects.nth(1)).toHaveText('Choose a segment');
  await selects.nth(1).click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  expect((await options.allInnerTexts()).map((t) => t.trim()).sort()).toEqual([none.name, two.name].sort());
  await page.getByRole('option', { name: two.name, exact: true }).click();
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await expect(sendButton(page)).toBeEnabled();

  await selects.nth(1).click();
  await page.getByRole('option', { name: none.name, exact: true }).click();
  await expect(reachLine(page).locator('span.text-destructive')).toHaveText('Nobody here can be emailed.');
  await expect(sendButton(page)).toBeDisabled();

  expect(previews).toContainEqual({ projectId: p.project.id, segmentId: two.id });
  expect(previews).toContainEqual({ projectId: p.project.id, segmentId: none.id });
});

test('EMAIL-098 preview with explicit device ids and foreign ids', async () => {
  const p = await emailProject('email-098', { provider: 'brevo', requireOptIn: false });
  const other = await emailProject('email-098-other', { provider: 'brevo', requireOptIn: false });
  const { E1, E3 } = await seedPeople(p, p.owner.ip, ['E1', 'E2', 'E3']);
  const { E1: foreign } = await seedPeople(other, other.owner.ip, ['E1']);
  const preview = (body: Record<string, unknown>) => call('POST', '/api/email/audience-preview', p.owner, { projectId: p.project.id, ...body });

  expect(dataOf(await preview({ deviceIdentityIds: [E1, E3] }))).toEqual({ targetType: 'devices', recipients: 1, requireOptIn: false });
  expect(dataOf(await preview({ deviceIdentityIds: [foreign] }))).toEqual({ targetType: 'devices', recipients: 0, requireOptIn: false });
  // The other tenant's person counts in their own project.
  expect(dataOf(await call('POST', '/api/email/audience-preview', other.owner, { projectId: other.project.id, deviceIdentityIds: [foreign] }))).toMatchObject({
    recipients: 1,
  });

  const malformed = await preview({ deviceIdentityIds: ['x'] });
  expect(malformed.status).toBe(400);
  expect(messageOf(malformed)).toBe('each value in deviceIdentityIds must be a UUID');

  expect(dataOf(await preview({ deviceIdentityIds: [] }))).toEqual({ targetType: 'project', recipients: 2, requireOptIn: false });
});

test("EMAIL-099 preview with another tenant's segment", async () => {
  const p = await emailProject('email-099', { provider: 'brevo', requireOptIn: false });
  const other = await emailProject('email-099-other', { provider: 'brevo', requireOptIn: false });
  await identifyEmail(p, p.owner.ip, { ...PEOPLE.E1, traits: { plan: 'pro' } });
  await identifyEmail(other, other.owner.ip, { ...PEOPLE.E1, traits: { plan: 'pro' } });
  const theirs = await createLiveSegment(other.owner, other.project.id, 'Their pro users', planIs('pro'));
  const mine = await createLiveSegment(p.owner, p.project.id, 'My pro users', planIs('pro'));
  // Control: each segment works in its own project.
  expect(dataOf(await call('POST', '/api/email/audience-preview', p.owner, { projectId: p.project.id, segmentId: mine }))).toMatchObject({
    targetType: 'segment',
    recipients: 1,
  });
  expect(dataOf(await call('POST', '/api/email/audience-preview', other.owner, { projectId: other.project.id, segmentId: theirs }))).toMatchObject({
    recipients: 1,
  });

  const preview = await call('POST', '/api/email/audience-preview', p.owner, { projectId: p.project.id, segmentId: theirs });
  expect(preview.status).toBe(404);
  expect(messageOf(preview)).toBe(`Segment ${theirs} not found`);
  const sent = await sendEmail(p.owner, p.project.id, { segmentId: theirs });
  expect(sent.status).toBe(404);
  expect(messageOf(sent)).toBe(`Segment ${theirs} not found`);
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  expect(await campaignRows(other.project.id)).toHaveLength(0);
});

test("EMAIL-103 deliver in each recipient's timezone", async ({ page }) => {
  const p = await emailProject('email-103', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('2 recipient(s)');
  await page.getByLabel('Subject').fill('Good evening');

  const label = page.getByText("Deliver in each recipient's timezone", { exact: true });
  await expect(page.getByText('At this local time, one wave per timezone.', { exact: true })).toBeVisible();
  const time = card(page, 'When').locator('input[type="time"]');
  await expect(time).toHaveCount(0);
  await label.locator('../..').getByRole('switch').click();
  await expect(time).toHaveValue('09:00');
  await time.fill('18:45');
  const schedule = sendButton(page, 'Schedule email');
  await expect(schedule).toBeEnabled();

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    schedule.click(),
  ]);
  expect(response.status()).toBe(201);
  const created = ((await response.json()) as { data: Record<string, any> }).data;
  expect(created).toMatchObject({ status: 'scheduled', deliverInRecipientTimezone: true, localSendTime: '18:45' });
  expect(Math.abs(new Date(created.scheduledAt).getTime() - Date.now())).toBeLessThan(60_000);
  expect(response.request().postDataJSON()).toMatchObject({ deliverInRecipientTimezone: true, localSendTime: '18:45' });
  await expect(toastWith(page, 'Email scheduled', '2 recipient(s).')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));

  const [row] = (await campaignRows(p.project.id)).filter((r) => r.id === created.id);
  expect(row).toMatchObject({ channel: 'email', deliver_in_recipient_timezone: true });
  expect(String(row.local_send_time)).toMatch(/^18:45/);
  // The worker's sweep may already have split it.
  expect(['scheduled', 'expanded']).toContain(row.status);

  await page.goto(`/projects/${p.project.id}/push-notifications/${created.id}`);
  await expect(page.getByText("Delivered at 18:45 on each recipient's own clock, not one fixed instant.", { exact: true })).toBeVisible();
});

test('EMAIL-105 A/B test: start with two arms', async ({ page }) => {
  const p = await emailProject('email-105', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('1 recipient(s)');
  await page.getByLabel('Subject').fill('Original');

  const ab = card(page, 'A/B test');
  await expect(ab.locator('[data-slot="card-description"]')).toHaveText(
    'Compare subjects or HTML. Results are scored on clicks and on conversions attributed to each arm.',
  );
  await ab.getByRole('switch').click();
  const a = armBox(page, 'A');
  const b = armBox(page, 'B');
  await expect(a.getByPlaceholder('Subject for this arm')).toHaveValue('Original');
  await expect(a.getByRole('spinbutton')).toHaveValue('50');
  await expect(b.getByPlaceholder('Subject for this arm')).toHaveValue('');
  await expect(b.getByRole('spinbutton')).toHaveValue('50');
  await expect(page.getByPlaceholder('HTML for this arm (optional, defaults to the message HTML)')).toHaveCount(2);
  await expect(ab.getByRole('button', { name: 'Add arm' })).toBeVisible();
  await expect(armBox(page, 'C')).toHaveCount(0);
  const control = page.getByText('Hold back as control', { exact: true }).locator('..');
  await expect(control.getByRole('spinbutton')).toHaveValue('0');
  await expect(control.getByText('% sent nothing, to measure lift', { exact: true })).toBeVisible();

  const start = sendButton(page, 'Start experiment');
  await expect(start).toBeDisabled();
  await b.getByPlaceholder('Subject for this arm').fill('Challenger');
  await expect(start).toBeEnabled();
});

test('EMAIL-108 A/B test: server refusals', async ({ page }) => {
  const p = await emailProject('email-108', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  await expect(reachLine(page)).toHaveText('1 recipient(s)');
  await page.getByLabel('Subject').fill('Subject A');
  await card(page, 'A/B test').getByRole('switch').click();
  await armBox(page, 'B').getByPlaceholder('Subject for this arm').fill('Subject B');
  await armBox(page, 'A').getByRole('spinbutton').fill('100');
  await armBox(page, 'B').getByRole('spinbutton').fill('0');
  await expect(page.getByText(/^Weights add up to/)).toHaveCount(0);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/email/send') && r.request().method() === 'POST'),
    sendButton(page, 'Start experiment').click(),
  ]);
  expect(response.status()).toBe(400);
  await expect(toastWith(page, 'Could not create email', 'Every variant needs a weight above zero.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email/new$`));

  const arm = (key: string, weight: number, title = `Subject ${key}`) => ({ key, title, weight });
  const cases: Array<[unknown[], string]> = [
    [[arm('A', 100)], 'An experiment needs at least two variants.'],
    [['A', 'B', 'C', 'D', 'E', 'F'].map((key) => arm(key, key === 'A' ? 20 : 16)), 'An experiment supports at most five variants.'],
    [[arm('A', 50), arm('A', 50)], 'Variant keys must be unique.'],
    [[arm('A', 60), arm('B', 50)], 'Variant weights must total 100, got 110.'],
    [[arm('A', 50), arm('B', 50, '')], 'Every variant needs a title.'],
  ];
  for (const [variants, message] of cases) {
    const refused = await sendEmail(p.owner, p.project.id, { variants });
    expect(refused.status, message).toBe(400);
    expect(messageOf(refused)).toBe(message);
  }
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  // Control: two valid arms are accepted.
  expect((await sendEmail(p.owner, p.project.id, { variants: [arm('A', 50), arm('B', 50)] })).status).toBe(201);
  expect(await campaignRows(p.project.id)).toHaveLength(1);
});

test('EMAIL-112 test from the composer', async ({ page }) => {
  const p = await emailProject('email-112', { provider: 'brevo' });
  const blocked = uniqueEmail('email-112-blocked');
  await suppress(p.owner, p.project.id, blocked);
  const inbox = uniqueEmail('email-112-qa');

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);
  const to = page.getByPlaceholder('Send a test to…');
  const testButton = card(page, 'Preview').getByRole('button', { name: 'Test', exact: true });
  await expect(testButton).toBeDisabled();
  await to.fill('qa');
  await expect(testButton).toBeDisabled();
  await to.fill(inbox);
  await expect(testButton).toBeEnabled();
  const htmlField = page.getByLabel('HTML', { exact: true });
  const starter = await htmlField.inputValue();
  await htmlField.fill('   ');
  await expect(testButton).toBeDisabled();
  await htmlField.fill(starter);
  await expect(testButton).toBeEnabled();

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/email/test-send') && r.method() === 'POST'),
    testButton.click(),
  ]);
  expect(request.postDataJSON()).toMatchObject({ projectId: p.project.id, to: inbox, subject: '(no subject)' });
  await expect(toastWith(page, 'Test sent', `Check ${inbox}.`)).toBeVisible();
  const calls = await brevoCallsTo(inbox);
  expect(calls).toHaveLength(1);
  expect((calls[0].body as { subject: string }).subject).toBe('(no subject)');

  await to.fill(blocked);
  await testButton.click();
  await expect(toastWith(page, 'Test failed', SUPPRESSED)).toBeVisible();
  expect(await brevoCallsTo(blocked)).toHaveLength(0);
});

test('EMAIL-113 composer on a project that is not ready', async ({ page }) => {
  const p = await emailProject('email-113', { sender: true, requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/email/new`);

  const notReady = page.locator('[data-slot="card"]').filter({ hasText: 'Email is not set up yet.' });
  await expect(notReady).toHaveText('Email is not set up yet. Finish setup first.');
  await expect(notReady.getByRole('link', { name: 'Finish setup' })).toHaveAttribute('href', `/projects/${p.project.id}/email`);
  // The reach is known and not zero, so only setup holds the buttons back.
  await expect(reachLine(page)).toHaveText('1 recipient(s)');
  await page.getByLabel('Subject').fill('Everything filled in');
  await page.getByPlaceholder('Send a test to…').fill('qa@example.test');
  await expect(sendButton(page)).toBeDisabled();
  await expect(card(page, 'Preview').getByRole('button', { name: 'Test', exact: true })).toBeDisabled();

  await notReady.getByRole('link', { name: 'Finish setup' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));
});

test('EMAIL-115 send API: body validation', async () => {
  const p = await emailProject('email-115', { provider: 'brevo', requireOptIn: false });
  await seedPeople(p, p.owner.ip, ['E1']);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ scheduledAt: 'tomorrow' }, 'scheduledAt must be a valid ISO 8601 date string'],
    [{ segmentId: 'x' }, 'segmentId must be a UUID'],
    [{ channel: 'push' }, 'property channel should not exist'],
    [{ localSendTime: '24:00' }, 'localSendTime must be HH:MM in 24-hour form'],
  ];
  for (const [body, message] of cases) {
    const refused = await sendEmail(p.owner, p.project.id, { scheduledAt: monthAhead(), ...body });
    expect(refused.status, message).toBe(400);
    expect(messageOf(refused)).toBe(message);
  }
  expect(await campaignRows(p.project.id)).toHaveLength(0);
  // Control: the same request without the bad field is accepted.
  expect((await sendEmail(p.owner, p.project.id, { scheduledAt: monthAhead(), localSendTime: '23:59' })).status).toBe(201);
});

test(
  'EMAIL-115 send API: a deliverInRecipientTimezone that is not a boolean is refused',
  { annotation: { type: 'issue', description: 'EMAIL-115' } },
  async () => {
    test.fail();
    const p = await emailProject('email-115-bool', { provider: 'brevo', requireOptIn: false });
    await seedPeople(p, p.owner.ip, ['E1']);
    for (const value of ['yes', 'false']) {
      const refused = await sendEmail(p.owner, p.project.id, { scheduledAt: monthAhead(), deliverInRecipientTimezone: value });
      expect(refused.status, value).toBe(400);
      expect(messageOf(refused)).toBe('deliverInRecipientTimezone must be a boolean value');
    }
    expect(await campaignRows(p.project.id)).toHaveLength(0);
  },
);

test(
  'EMAIL-115 send API: html over 500,000 characters is refused by its length rule',
  { annotation: { type: 'issue', description: 'EMAIL-115' } },
  async () => {
    test.fail();
    const p = await emailProject('email-115-html', { provider: 'brevo', requireOptIn: false });
    await seedPeople(p, p.owner.ip, ['E1']);
    const refused = await sendEmail(p.owner, p.project.id, { scheduledAt: monthAhead(), html: 'x'.repeat(500_001) });
    expect(refused.status).toBe(400);
    expect(messageOf(refused)).toBe('html must be shorter than or equal to 500000 characters');
    // Just inside the bound is accepted.
    expect((await sendEmail(p.owner, p.project.id, { scheduledAt: monthAhead(), html: 'x'.repeat(500_000) })).status).toBe(201);
  },
);

test('EMAIL-116 send to explicit people', async () => {
  const p = await emailProject('email-116', { provider: 'brevo', requireOptIn: false });
  const { E1 } = await seedPeople(p, p.owner.ip, ['E1', 'E2']);
  const created = dataOf(await sendEmail(p.owner, p.project.id, { deviceIdentityIds: [E1], scheduledAt: monthAhead() }));
  const [row] = await campaignRows(p.project.id);
  expect(row.id).toBe(created.id);
  expect(row).toMatchObject({ target_type: 'devices', target_device_ids: [E1], total_tokens: 1, status: 'scheduled' });
});

// ------------------------------------------------------------ H. Campaign page ---

test('EMAIL-121 email campaign header, content card and back arrow', async ({ page }) => {
  const p = await emailProject('email-121', { provider: 'brevo' });
  const id = await seedCampaign(p.project.id, { subject: 'Spring sale', preheader: 'Up to 40% off', html: '<h2>Sale</h2>' });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);

  const heading = page.getByRole('heading', { level: 1, name: 'Spring sale' });
  await expect(heading).toBeVisible();
  await expect(heading.locator('..').locator('[data-slot="badge"][data-variant="outline"]', { hasText: 'Email' })).toHaveText('Email');
  const content = card(page, 'Email');
  await expect(content.locator('[data-slot="card-description"]')).toHaveText('Spring sale — Up to 40% off');
  const frame = content.locator('iframe[title="Email content"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title="Email content"]').getByRole('heading', { name: 'Sale' })).toBeVisible();

  const back = page.locator('a').filter({ has: page.locator('svg.lucide-arrow-left') });
  await expect(back).toHaveAttribute('href', `/projects/${p.project.id}/email`);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.project.id}/email$`));
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
});

test('EMAIL-122 engagement cards for email', async ({ page }) => {
  const p = await emailProject('email-122', { provider: 'brevo', requireOptIn: false });
  // Accepted by the provider differs from the delivered events, so Delivered is the events'.
  const id = await seedCampaign(p.project.id, { subject: 'Engaging', totalTokens: 6, successCount: 6 });
  const people: string[] = [];
  for (let i = 0; i < 4; i += 1) people.push(await identifyEmail(p, p.owner.ip, { email: `e122-${i}@example.test` }));
  for (const person of people) await seedCampaignEvent(p.project.id, id, person, 'delivered');
  for (const person of people.slice(0, 3)) await seedCampaignEvent(p.project.id, id, person, 'impression');
  await seedCampaignEvent(p.project.id, id, people[0], 'click');
  await seedCampaignEvent(p.project.id, id, people[3], 'bounced');

  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);
  const engagement = card(page, 'Engagement');
  await expect(engagement.locator('[data-slot="card-description"]')).toHaveText('Reported by your email provider through its delivery webhook.');
  for (const [label, value] of [['Delivered', '4'], ['Opened', '3'], ['Clicks', '1'], ['Bounced', '1'], ['Click-through rate', '25%']]) {
    await expect(statTile(engagement, label), label).toHaveText(value);
  }
  await expect(engagement.locator('div.rounded-lg.border.p-4')).toHaveCount(5);
  await expect(engagement.getByText('Dismissed')).toHaveCount(0);
  await expect(engagement.getByText('Impressions')).toHaveCount(0);
});

test('EMAIL-125 delivery card and failures for email', async ({ page }) => {
  const p = await emailProject('email-125', { provider: 'brevo' });
  const error = 'invalid_parameter: email is not valid';
  const failures = [
    { token: 'bad.address@example.test', error },
    { token: 'second@bad-domain.test', error },
  ];
  const id = await seedCampaign(p.project.id, {
    subject: 'Partly delivered',
    status: 'partial',
    totalTokens: 10,
    successCount: 8,
    processedTokens: 10,
    failureCount: 2,
    failureDetails: failures,
  });
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}/push-notifications/${id}`);

  const delivery = card(page, 'Delivery');
  await expect(delivery.locator('[data-slot="card-description"]')).toHaveText(
    'Accepted is what your email provider took from us; Delivered above is what the receiving mail server confirmed.',
  );
  await expect(statTile(delivery, 'Accepted by provider')).toHaveText('8 / 10');
  await expect(statTile(delivery, 'Failed')).toHaveText('2');
  await expect(delivery.getByRole('columnheader')).toHaveText(['Address', 'Provider error']);
  for (const failure of failures) {
    const cell = delivery.getByRole('cell', { name: `…${failure.token.slice(-10)}`, exact: true });
    await expect(cell).toHaveAttribute('title', failure.token);
  }
  await expect(delivery.getByRole('cell', { name: error, exact: true })).toHaveCount(2);

  const badge = delivery.getByText(`${error} × 2`, { exact: true });
  await expect(badge).toBeVisible();
  await badge.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Reported by your email provider');
});

test('EMAIL-126 campaign stopped by setup or suspension shows the reason', async ({ page }) => {
  const p = await emailProject('email-126', { provider: 'brevo' });
  const stopped = [
    { subject: 'Stopped by setup', reason: NOT_SET_UP },
    { subject: 'Stopped by suspension', reason: STOPPED_BY_SUSPENSION },
  ];
  const ids = [];
  for (const s of stopped) {
    ids.push(await seedCampaign(p.project.id, { subject: s.subject, status: 'failed', successCount: 0, errorMessage: s.reason }));
  }
  const clean = await seedCampaign(p.project.id, { subject: 'Went fine' });
  await signIn(page, p.owner);
  const reasonCard = page.locator('[data-slot="card"].border-destructive\\/40');
  for (const [i, s] of stopped.entries()) {
    await page.goto(`/projects/${p.project.id}/push-notifications/${ids[i]}`);
    await expect(page.getByRole('heading', { level: 1, name: s.subject })).toBeVisible();
    await expect(reasonCard).toHaveText(s.reason);
    await expect(reasonCard.locator('svg.lucide-circle-x, svg.lucide-x-circle')).toHaveClass(/text-destructive/);
  }
  // A campaign with no error has no such card.
  await page.goto(`/projects/${p.project.id}/push-notifications/${clean}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Went fine' })).toBeVisible();
  await expect(card(page, 'Delivery')).toBeVisible();
  await expect(reasonCard).toHaveCount(0);
});

// ------------------------------------------------------------ I. Delivery ---

test('EMAIL-132 provider removed before a queued campaign runs', async () => {
  test.setTimeout(180_000);
  const p = await emailProject('email-132', { provider: 'brevo', requireOptIn: false });
  const address = uniqueEmail('email-132');
  await identifyEmail(p, p.owner.ip, { email: address });
  const campaign = dataOf(await sendEmail(p.owner, p.project.id, { subject: 'No provider by then', scheduledAt: monthAhead() }));

  await sql(`UPDATE email_settings SET provider = NULL WHERE project_id = $1`, [p.project.id]);
  expect((await emailSettingsRow(p.project.id))!.provider).toBeNull();
  await sql(`UPDATE push_notification_logs SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [campaign.id]);

  const read = async () => dataOf(await call('GET', `/api/push-notifications/campaign/${p.project.id}/${campaign.id}`, p.owner));
  await expect.poll(async () => (await read()).status, { timeout: 120_000, intervals: [2_000] }).toBe('failed');
  const failed = await read();
  expect(failed).toMatchObject({ errorMessage: CONNECT_FIRST, successCount: 0, processedTokens: 0 });
  expect(await brevoCallsTo(address)).toHaveLength(0);
  // Not retried: the queue allows three tries, and its job ended failed after the first.
  await expect.poll(async () => (await campaignJob(campaign.id))?.state, { timeout: 15_000 }).toBe('failed');
  expect(await campaignJob(campaign.id)).toEqual({ state: 'failed', attemptsStarted: 1, attemptsMade: 1, attempts: 3 });
});

// ------------------------------------------------------------ J. Unsubscribe ---

test('EMAIL-142 address with markup is escaped on the unsubscribe page', async ({ page }) => {
  const p = await emailProject('email-142', { provider: 'brevo' });
  const address = '"<img src=x onerror=alert(1)>"@example.test';
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto(apiUrl(pathAndQuery(signUnsubscribeLink(p.project.id, address))));
  await expect(page).toHaveTitle('Unsubscribe');
  await expect(page.getByText(`Stop marketing email to ${address}.`, { exact: true })).toBeVisible();
  await expect(page.locator('strong')).toHaveText(address);
  await expect(page.locator('img')).toHaveCount(0);

  await page.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page).toHaveTitle('Unsubscribed');
  await expect(page.getByText(`${address} will not receive marketing email from this sender again.`, { exact: true })).toBeVisible();
  await expect(page.locator('strong')).toHaveText(address);
  await expect(page.locator('img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('EMAIL-143 old unsubscribe links keep working', async () => {
  const p = await emailProject('email-143', { provider: 'brevo' });
  await seedPeople(p, p.owner.ip, ['E1']);
  const link = signUnsubscribeLink(p.project.id, PEOPLE.E1.email!);
  const before = (await emailSettingsRow(p.project.id))!;

  dataOf(await call('POST', `/api/email/settings/${p.project.id}/rotate-webhook-token`, p.owner));
  await seedEmailCredentials(p.project.id, 'resend');
  const after = (await emailSettingsRow(p.project.id))!;
  expect(after.webhook_token).not.toBe(before.webhook_token);
  expect(after.provider).toBe('resend');

  const answered = await publicRequest('POST', pathAndQuery(link), FORM);
  expect(answered.status).toBe(200);
  expect(answered.text).toContain('<title>Unsubscribed</title>');
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: PEOPLE.E1.email, reason: 'unsubscribed', source: 'link' }),
  ]);
});

test('EMAIL-144 unsubscribe works while the account is suspended', async () => {
  const p = await emailProject('email-144', { provider: 'brevo' });
  await seedPeople(p, p.owner.ip, ['E1']);
  await suspendAccount(p.owner.userId);
  const path = pathAndQuery(signUnsubscribeLink(p.project.id, PEOPLE.E1.email!));

  const shown = await publicRequest('GET', path);
  expect(shown.status).toBe(200);
  expect(shown.text).toContain('<title>Unsubscribe</title>');
  expect(await suppressionRows(p.project.id)).toHaveLength(0);

  const posted = await publicRequest('POST', path, FORM);
  expect(posted.status).toBe(200);
  expect(posted.text).toContain('<title>Unsubscribed</title>');
  expect(await suppressionRows(p.project.id)).toEqual([
    expect.objectContaining({ address: PEOPLE.E1.email, reason: 'unsubscribed', source: 'link' }),
  ]);
});

// ------------------------------------------------------------ K. Confirmation ---

const E2 = PEOPLE.E2.email!;

/**
 * A project requiring opt-in with E2 opted in, unconfirmed, and a confirmation recorded
 * as mailed at `sentAt`. The provider is seeded only after the send time is set, so the
 * worker's confirmation mailer never takes the address.
 */
async function confirmProject(label: string, sentAt: Date) {
  const p = await emailProject(label, { sender: true });
  const fingerprint = `email-${randomBytes(8).toString('hex')}`;
  const e2 = await identifyDevice(p, p.owner.ip, fingerprint, PEOPLE.E2);
  await markConfirmSent(p.project.id, E2, sentAt);
  await seedEmailCredentials(p.project.id, 'brevo');
  return { ...p, e2 };
}

test('EMAIL-148 confirmation link for an older send is no longer current', async () => {
  const t1 = new Date(Date.now() - 120_000);
  const t2 = new Date(Date.now() - 60_000);
  const p = await confirmProject('email-148', t2);

  const old = await publicRequest('POST', pathAndQuery(signConfirmLink(p.project.id, E2, t1)), FORM);
  expect(old.status).toBe(200);
  expect(old.headers.get('content-type')).toMatch(/^text\/html/);
  expect(old.text).toContain('<title>Link not current</title>');
  expect(old.text).toContain('<h1>This link is no longer current</h1><p>Use the latest confirmation email you received.</p>');
  expect((await identityRows(p.project.id, E2)).map((row) => row.email_confirmed_at)).toEqual([null]);

  // The latest send's link confirms the same row.
  const latest = await publicRequest('POST', pathAndQuery(signConfirmLink(p.project.id, E2, t2)), FORM);
  expect(latest.text).toContain('<title>Confirmed</title>');
  expect((await identityRows(p.project.id, E2))[0].email_confirmed_at).not.toBeNull();
});

test('EMAIL-152 confirmation does not override a suppression', async () => {
  const sentAt = new Date(Date.now() - 60_000);
  const p = await confirmProject('email-152', sentAt);
  const e1 = await identifyEmail(p, p.owner.ip, PEOPLE.E1);
  await confirmEmail(e1);
  dataOf(await call('POST', '/api/email/suppressions', p.owner, { projectId: p.project.id, address: E2, reason: 'unsubscribed' }));
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 1, requireOptIn: true });

  const answered = await publicRequest('POST', pathAndQuery(signConfirmLink(p.project.id, E2, sentAt)), FORM);
  expect(answered.status).toBe(200);
  expect(answered.text).toContain('<title>Confirmed</title>');
  const [row] = await identityRows(p.project.id, E2);
  expect(row.email_confirmed_at).not.toBeNull();
  expect(row.email_opt_in).toBe(true);

  // Still suppressed and still out of the audience; only E1 counts.
  expect(await suppressionRows(p.project.id)).toEqual([expect.objectContaining({ address: E2, reason: 'unsubscribed' })]);
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 1, requireOptIn: true });
  // Lifting the suppression lets the confirmed address in, so it was the suppression keeping it out.
  dataOf(await call('DELETE', `/api/email/suppressions/${p.project.id}/${encodeURIComponent(E2)}`, p.owner));
  expect(await emailPreview(p.owner, p.project.id)).toMatchObject({ recipients: 2 });
});
