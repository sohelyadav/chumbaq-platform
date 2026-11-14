import { randomBytes } from 'crypto';
import { api, createAccount, createProject, PASSWORD, uniqueEmail } from '../../support/api';
import { expect, test } from '../../support/fixtures';
import { extractLink, mailsTo, tokenFromLink, waitForMail } from '../../support/mailbox';
import { failStub, stubCalls } from '../../support/provider-stub';

/**
 * Proves the provider stub (support/provider-stub.ts) and the mailbox
 * (support/mailbox.ts): account email reaches the stub's Brevo with a link that works in
 * the customer app, and a tenant's Twilio connect and test send reach the stub's Twilio,
 * which also fails on request.
 */
test.describe('provider stub and mailbox', () => {
  test('a sign-up mails a working /complete-signup link, and a second sign-up mails "already registered"', async ({ page, baseURL }) => {
    const email = uniqueEmail('stub-signup');
    const name = 'Mina Mailbox';

    await page.goto('/register');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(`We sent an email to ${email}`)).toBeVisible();

    const mail = await waitForMail(email, { subjectIncludes: 'Finish creating your Chumbaq account' });
    expect(mail.from).toBe('Chumbaq E2E <no-reply@e2e.example.test>');
    const link = extractLink(mail, '/complete-signup');
    // The link is the customer app's own (APP_URL), with the token in the fragment only.
    expect(new URL(link).origin).toBe(new URL(baseURL as string).origin);
    expect(new URL(link).search).toBe('');
    expect(tokenFromLink(link)).toMatch(/^[\w.-]{40,}$/);
    // The HTML part carries the same link as the text part.
    expect(mail.html).toContain(link.replace(/&/g, '&amp;'));

    await page.goto(link);
    await expect(page.getByText('Choose a password')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Your Projects' })).toBeVisible();

    // The address is now taken: signing up with it again mails a different message.
    await page.context().clearCookies();
    await page.goto('/register');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(`We sent an email to ${email}`)).toBeVisible();
    const again = await waitForMail(email, { subjectIncludes: 'You already have a Chumbaq account' });
    expect(() => extractLink(again, '/complete-signup')).toThrow();
    expect((await mailsTo(email, { subjectIncludes: 'Finish creating' })).length).toBe(1);
  });

  test('a Twilio connect and SMS test send reach the stub, and an injected failure is reported', async ({ clientIp }) => {
    const owner = await createAccount(clientIp, 'stub-sms');
    const project = await createProject(owner, clientIp);
    const session = { token: owner.accessToken, ip: clientIp };
    // An account of this test's own, so its calls and its injected failure are its own.
    const accountSid = `AC${randomBytes(16).toString('hex')}`;
    const authToken = randomBytes(16).toString('hex');
    const sender = '+14155550100';

    await api('POST', '/api/sms/settings', { projectId: project.id, sender }, session);
    await api(
      'POST',
      '/api/sms/providers',
      { projectId: project.id, provider: 'twilio', credentials: JSON.stringify({ accountSid, authToken }) },
      session,
    );
    const ours = async () => (await stubCalls('twilio')).filter((call) => call.path.includes(accountSid));
    // Connecting checked the credentials with "Twilio": one read of the account, Basic auth redacted.
    expect(await ours()).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: `/2010-04-01/Accounts/${accountSid}.json`,
        headers: expect.objectContaining({ authorization: '[redacted]' }),
      }),
    ]);

    const to = `+1415555${String(randomBytes(2).readUInt16BE() % 10_000).padStart(4, '0')}`;
    const sent = await api<{ delivered: boolean; error?: string }>(
      'POST',
      '/api/sms/test-send',
      { projectId: project.id, body: 'Hello from the e2e stub', to },
      session,
    );
    expect(sent).toEqual({ delivered: true });
    const message = (await ours()).find((call) => call.method === 'POST');
    expect(message?.path).toBe(`/2010-04-01/Accounts/${accountSid}/Messages.json`);
    expect(message?.body).toEqual(
      expect.objectContaining({ To: to, From: sender, Body: expect.stringContaining('Hello from the e2e stub') }),
    );

    // Twilio refusing the account (401) reaches the dashboard as a failed test send.
    await failStub('twilio', { status: 401, match: accountSid, times: 1 });
    const refused = await api<{ delivered: boolean; error?: string }>(
      'POST',
      '/api/sms/test-send',
      { projectId: project.id, body: 'Hello again', to },
      session,
    );
    expect(refused.delivered).toBe(false);
    expect(refused.error).toContain('Twilio refused to send from this account');
    // The failure was used once: the next send goes through.
    await expect(
      api('POST', '/api/sms/test-send', { projectId: project.id, body: 'And again', to }, session),
    ).resolves.toEqual({ delivered: true });
  });
});
