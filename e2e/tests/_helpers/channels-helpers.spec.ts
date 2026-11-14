import { randomBytes } from 'crypto';
import { api, apiUrl, createAccount, createProject, type Account, type Project } from '../../support/api';
import {
  connectFakeSmsProvider,
  connectFakeWhatsAppProvider,
  deleteFcmCredentialRow,
  emailWebhookPath,
  seedEmailCredentials,
  seedFcmConfig,
  seedUnreadableFcmConfig,
  smsWebhookPath,
  whatsappWebhookPath,
} from '../../support/channels';
import { expect, signIn, test } from '../../support/fixtures';
import {
  hubSignature,
  interaktSignature,
  pathAndQuery,
  publicApiUrl,
  razorpaySignature,
  signConfirmLink,
  signSvix,
  signUnsubscribeLink,
  twilioSignature,
} from '../../support/signing';

/**
 * Proves the channel seeding (support/channels.ts) and webhook signing
 * (support/signing.ts) helpers: seeded connections read back as a real connect's do,
 * and each signature is accepted by the API while a missing or forged one is refused.
 */

async function ownerWithProject(ip: string, label: string): Promise<{ owner: Account; project: Project }> {
  const owner = await createAccount(ip, label, 'Helper Owner');
  return { owner, project: await createProject(owner, ip) };
}

function post(path: string, body: string, headers: Record<string, string>, ip: string): Promise<Response> {
  return fetch(apiUrl(path), { method: 'POST', headers: { 'X-Forwarded-For': ip, ...headers }, body });
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_TYPE = { 'Content-Type': 'application/json' };

test('a seeded Twilio connection shows as connected on the SMS settings page', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp, 'sms-seed');
  const sms = await connectFakeSmsProvider(project.id);

  const status = await api<{ readyToSend: boolean; providers: Array<{ accountSid: string; keyHint: string }> }>(
    'GET',
    `/api/sms/settings/${project.id}`,
    undefined,
    { token: owner.accessToken, ip: clientIp },
  );
  expect(status.readyToSend).toBe(true);
  expect(status.providers).toEqual([{ provider: 'twilio', accountSid: sms.credentials.accountSid, keyHint: sms.credentials.authToken.slice(-4) }]);

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/sms`);
  await expect(page.getByRole('heading', { name: 'SMS', exact: true })).toBeVisible();
  await expect(page.getByText('SMS is not set up yet. Add a sender and connect Twilio under Settings.')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(
    page.getByText(`Account ${sms.credentials.accountSid}, auth token ending ${sms.credentials.authToken.slice(-4)}.`),
  ).toBeVisible();
});

test('a signed Twilio status report is accepted and suppresses a dead number; unsigned or forged ones are refused', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp, 'sms-hook');
  const sms = await connectFakeSmsProvider(project.id);
  const path = smsWebhookPath(sms.webhookToken, 'status');
  const dead = `+1555${String(Date.now()).slice(-7)}`;
  const params = {
    AccountSid: sms.credentials.accountSid,
    MessageSid: `SM${randomBytes(16).toString('hex')}`,
    MessageStatus: 'undelivered',
    ErrorCode: '30005',
    To: dead,
  };
  const body = new URLSearchParams(params).toString();

  const unsigned = await post(path, body, FORM, clientIp);
  expect(unsigned.status).toBe(401);
  const forged = await post(path, body, { ...FORM, 'X-Twilio-Signature': twilioSignature('0'.repeat(32), publicApiUrl(path), params) }, clientIp);
  expect(forged.status).toBe(401);
  const suppressionsBefore = await api('GET', `/api/sms/suppressions/${project.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(JSON.stringify(suppressionsBefore)).not.toContain(dead);

  const signed = await post(path, body, { ...FORM, 'X-Twilio-Signature': twilioSignature(sms.credentials.authToken, publicApiUrl(path), params) }, clientIp);
  expect(signed.status).toBe(204);
  const suppressions = await api('GET', `/api/sms/suppressions/${project.id}`, undefined, { token: owner.accessToken, ip: clientIp });
  expect(JSON.stringify(suppressions)).toContain(dead);
});

test('seeded FCM reads back as configured, and unreadable or deleted credentials as unreadable', async ({ page, clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp, 'fcm-seed');
  type ConfigStatus = { configured: boolean; isActive: boolean; firebaseProjectId: string | null; clientEmail: string | null };
  const configStatus = () =>
    api<ConfigStatus>('GET', `/api/push-notifications/config-status/${project.id}`, undefined, { token: owner.accessToken, ip: clientIp });

  const account = await seedFcmConfig(project.id);
  expect(await configStatus()).toMatchObject({ configured: true, isActive: true, firebaseProjectId: account.project_id, clientEmail: account.client_email });

  await signIn(page, owner);
  await page.goto(`/projects/${project.id}/push-notifications`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByText('FCM is configured and active')).toBeVisible();
  await expect(page.getByText(account.project_id, { exact: true })).toBeVisible();

  for (const kind of ['bad-ciphertext', 'not-json'] as const) {
    await seedUnreadableFcmConfig(project.id, kind);
    expect(await configStatus(), kind).toMatchObject({ configured: true, firebaseProjectId: null, clientEmail: null });
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByText('Stored credentials could not be decrypted')).toBeVisible();

  await seedFcmConfig(project.id, account);
  expect((await configStatus()).firebaseProjectId).toBe(account.project_id);
  await deleteFcmCredentialRow(project.id);
  expect(await configStatus()).toMatchObject({ configured: true, firebaseProjectId: null });
});

test('seeded email credentials read back per provider, and a Svix-signed Resend event is accepted', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp, 'email-seed');
  const ses = await seedEmailCredentials(project.id, 'ses');
  const brevo = await seedEmailCredentials(project.id, 'brevo', { activate: false });
  const resend = await seedEmailCredentials(project.id, 'resend');
  expect(new Set([ses.webhookToken, brevo.webhookToken])).toEqual(new Set([resend.webhookToken]));

  const status = await api<{ readyToSend: boolean; settings: { provider: string }; providers: unknown[] }>(
    'GET',
    `/api/email/settings/${project.id}`,
    undefined,
    { token: owner.accessToken, ip: clientIp },
  );
  expect(status.readyToSend).toBe(true);
  expect(status.settings.provider).toBe('resend');
  expect(status.providers).toEqual([
    { provider: 'ses', keyHint: ses.credentials.accessKeyId.slice(-4), region: 'ap-south-1', configurationSetName: 'e2e-events' },
    { provider: 'resend', keyHint: resend.credentials.apiKey.slice(-4), hasWebhookSecret: true },
    { provider: 'brevo', keyHint: brevo.credentials.apiKey.slice(-4) },
  ]);

  const path = emailWebhookPath('resend', resend.webhookToken);
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: new Date().toISOString(),
    data: { to: ['someone@e2e.example.test'], tags: {} },
  });
  expect((await post(path, body, JSON_TYPE, clientIp)).status).toBe(401);
  const stale = signSvix(resend.credentials.webhookSecret!, body, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  expect((await post(path, body, { ...JSON_TYPE, ...stale }, clientIp)).status).toBe(401);
  const otherSecret = signSvix(`whsec_${randomBytes(24).toString('base64')}`, body);
  expect((await post(path, body, { ...JSON_TYPE, ...otherSecret }, clientIp)).status).toBe(401);
  const signed = await post(path, body, { ...JSON_TYPE, ...signSvix(resend.credentials.webhookSecret!, body) }, clientIp);
  expect(signed.status).toBe(200);
  expect(await signed.json()).toEqual({ data: { recorded: 0 } });
});

test('seeded WhatsApp providers read back as connected, and their signed webhooks are accepted', async ({ clientIp }) => {
  const { owner, project } = await ownerWithProject(clientIp, 'wa-seed');
  const status = () =>
    api<{ readyToSend: boolean; settings: { provider: string }; providers: Array<{ provider: string; webhooksSigned: boolean }> }>(
      'GET',
      `/api/whatsapp/settings/${project.id}`,
      undefined,
      { token: owner.accessToken, ip: clientIp },
    );

  // Meta: X-Hub-Signature-256 with the app secret.
  const meta = await connectFakeWhatsAppProvider(project.id, 'meta');
  expect(await status()).toMatchObject({ readyToSend: true, settings: { provider: 'meta' }, providers: [{ provider: 'meta', webhooksSigned: true }] });
  const metaBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const metaPath = whatsappWebhookPath('meta', meta.webhookToken);
  expect((await post(metaPath, metaBody, { ...JSON_TYPE, 'X-Hub-Signature-256': hubSignature('wrong-secret', metaBody) }, clientIp)).status).toBe(401);
  const metaSigned = await post(metaPath, metaBody, { ...JSON_TYPE, 'X-Hub-Signature-256': hubSignature(meta.credentials.appSecret!, metaBody) }, clientIp);
  expect(metaSigned.status).toBe(200);

  // Interakt: Interakt-Signature with the webhook secret.
  const interakt = await connectFakeWhatsAppProvider(project.id, 'interakt');
  expect(interakt.webhookToken).toBe(meta.webhookToken);
  const interaktBody = JSON.stringify({ type: 'message_api_delivered', data: {} });
  const interaktPath = whatsappWebhookPath('interakt', interakt.webhookToken);
  expect((await post(interaktPath, interaktBody, JSON_TYPE, clientIp)).status).toBe(401);
  const interaktSigned = await post(
    interaktPath,
    interaktBody,
    { ...JSON_TYPE, 'Interakt-Signature': interaktSignature(interakt.credentials.webhookSecret!, interaktBody) },
    clientIp,
  );
  expect(interaktSigned.status).toBe(200);

  // Twilio: X-Twilio-Signature with the auth token, over the public URL and the form.
  const twilio = await connectFakeWhatsAppProvider(project.id, 'twilio');
  expect(twilio.provider).toBe('twilio_whatsapp');
  const twilioPath = whatsappWebhookPath('twilio_whatsapp', twilio.webhookToken);
  const params = { AccountSid: twilio.credentials.accountSid, MessageStatus: 'sent', To: 'whatsapp:+15550001111' };
  const form = new URLSearchParams(params).toString();
  expect((await post(twilioPath, form, FORM, clientIp)).status).toBe(401);
  const twilioSigned = await post(
    twilioPath,
    form,
    { ...FORM, 'X-Twilio-Signature': twilioSignature(twilio.credentials.authToken, publicApiUrl(twilioPath), params) },
    clientIp,
  );
  expect(twilioSigned.status).toBe(200);

  // Gupshup signs nothing: taken (unsigned) only while it is the current provider.
  const gupshup = await connectFakeWhatsAppProvider(project.id, 'gupshup');
  const current = await status();
  expect(current.settings.provider).toBe('gupshup');
  expect(current.providers.map((p) => p.provider).sort()).toEqual(['gupshup', 'interakt', 'meta', 'twilio_whatsapp']);
  const gupshupBody = JSON.stringify({ app: gupshup.credentials.appName, type: 'message-event', payload: {} });
  expect((await post(whatsappWebhookPath('gupshup', gupshup.webhookToken), gupshupBody, JSON_TYPE, clientIp)).status).toBe(200);
  // Interakt is no longer current, so its unsigned events are refused; signed ones still count.
  const unsignedInterakt = await connectFakeWhatsAppProvider(project.id, 'interakt', { signed: false });
  await connectFakeWhatsAppProvider(project.id, 'gupshup', { credentials: gupshup.credentials });
  expect(unsignedInterakt.credentials.webhookSecret).toBeUndefined();
  expect((await post(interaktPath, interaktBody, JSON_TYPE, clientIp)).status).toBe(403);
});

test('signed unsubscribe and confirmation links open, and edited or expired ones are refused', async ({ clientIp }) => {
  const { project } = await ownerWithProject(clientIp, 'email-links');
  const address = `reader-${randomBytes(3).toString('hex')}@e2e.example.test`;
  const get = (url: string) => fetch(apiUrl(pathAndQuery(url)), { headers: { 'X-Forwarded-For': clientIp } });
  const edited = (url: string) => {
    const parsed = new URL(url);
    parsed.searchParams.set('e', Buffer.from(`x${address}`, 'utf8').toString('base64url'));
    return parsed.toString();
  };

  const unsubscribe = signUnsubscribeLink(project.id, address);
  expect(unsubscribe.startsWith(publicApiUrl('/api/email/unsubscribe?'))).toBe(true);
  const shown = await get(unsubscribe);
  expect(shown.status).toBe(200);
  expect(await shown.text()).toContain(address);
  expect((await get(edited(unsubscribe))).status).toBe(400);

  const confirm = signConfirmLink(project.id, address, new Date());
  const confirmPage = await get(confirm);
  expect(confirmPage.status).toBe(200);
  expect(await confirmPage.text()).toContain('Confirm your email');
  expect((await get(edited(confirm))).status).toBe(400);
  const expired = signConfirmLink(project.id, address, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
  expect((await get(expired)).status).toBe(400);
});

test('a Razorpay webhook signed over its raw body is accepted, a forged one refused', async ({ clientIp }) => {
  const body = JSON.stringify({ entity: 'event', event: 'e2e.not_a_real_event', payload: {}, created_at: Math.floor(Date.now() / 1000) });
  const headers = (signature: string) => ({
    ...JSON_TYPE,
    'X-Razorpay-Signature': signature,
    'x-razorpay-event-id': `evt_e2e${randomBytes(6).toString('hex')}`,
  });
  const path = '/api/billing/webhooks/razorpay';
  expect((await post(path, body, headers(razorpaySignature(body, 'not-the-secret')), clientIp)).status).toBe(400);
  expect((await post(path, body, headers(razorpaySignature(`${body} `)), clientIp)).status).toBe(400);
  expect((await post(path, body, headers(razorpaySignature(body)), clientIp)).status).toBe(200);
});
