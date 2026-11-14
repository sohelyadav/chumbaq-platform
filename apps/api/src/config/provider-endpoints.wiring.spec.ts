import { generateKeyPairSync } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PROVIDER_ENDPOINTS, ProviderEndpoint } from './provider-endpoints.config';
import { PlatformEmailService } from '../modules/platform-email/platform-email.service';
import { BrevoProvider } from '../modules/email/providers/brevo.provider';
import { ResendProvider } from '../modules/email/providers/resend.provider';
import { TwilioProvider } from '../modules/sms/providers/twilio.provider';
import { TwilioWhatsAppProvider } from '../modules/whatsapp/providers/twilio-whatsapp.provider';
import { MetaWhatsAppProvider, GRAPH_VERSION } from '../modules/whatsapp/providers/meta.provider';
import { GupshupProvider } from '../modules/whatsapp/providers/gupshup.provider';
import { InteraktProvider } from '../modules/whatsapp/providers/interakt.provider';
import { MixpanelApiService } from '../modules/mixpanel-cohorts/mixpanel-api.service';
import { FcmProvider } from '../modules/push-notifications/services/fcm.provider';

/**
 * Every provider sends to its override when one is set, over a real local socket: the
 * base URL of each is `<server>/<endpoint name>`, and the server records the paths.
 */
describe('provider base URL overrides reach every provider', () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ method: string; path: string }> = [];
  const saved: Record<string, string | undefined> = {};

  const ANSWERS: Array<[RegExp, unknown]> = [
    [/^\/googleOauth\/token$/, { access_token: 'ya29.local', expires_in: 3600, token_type: 'Bearer' }],
    [/^\/fcm\/v1\/projects\/[^/]+\/messages:send$/, { name: 'projects/p/messages/1' }],
    [/^\/twilio\/Accounts\/[^/]+\.json$/, { sid: 'AC', status: 'active' }],
    [/^\/twilioContent\/ContentAndApprovals/, { contents: [], meta: { next_page_url: null } }],
    [/^\/metaGraph\//, { id: '1', data: [] }],
    [/^\/mixpanel\/cohorts\/list/, []],
  ];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const path = req.url ?? '';
        seen.push({ method: req.method ?? '', path });
        const answer = ANSWERS.find(([pattern]) => pattern.test(path))?.[1] ?? {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const name of Object.keys(PROVIDER_ENDPOINTS) as ProviderEndpoint[]) {
      const { variable } = PROVIDER_ENDPOINTS[name];
      saved[variable] = process.env[variable];
      process.env[variable] = `${base}/${name}`;
    }
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    for (const [variable, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
    jest.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const SID = `AC${'a'.repeat(32)}`;
  const TOKEN = 'b'.repeat(32);

  it('account email (platform Brevo)', async () => {
    const config = { get: (key: string) => ({ PLATFORM_BREVO_API_KEY: 'xkeysib-local', PLATFORM_EMAIL_FROM: 'a@example.test' })[key] };
    const result = await new PlatformEmailService(config as unknown as ConfigService).send({
      to: 'person@example.test',
      subject: 's',
      html: 'h',
      text: 't',
    });
    expect(result).toEqual({ sent: true });
    expect(seen).toEqual([{ method: 'POST', path: '/platformBrevo/smtp/email' }]);
  });

  it('Brevo and Resend email campaigns', async () => {
    await new BrevoProvider().validateCredentials({ apiKey: 'xkeysib-local' });
    await new ResendProvider().validateCredentials({ apiKey: 're_local' });
    expect(seen).toEqual([
      { method: 'GET', path: '/brevo/account' },
      { method: 'GET', path: '/resend/domains' },
    ]);
  });

  it('Twilio SMS, and Twilio WhatsApp with its Content API', async () => {
    await new TwilioProvider().validateCredentials({ accountSid: SID, authToken: TOKEN });
    await new TwilioWhatsAppProvider().validateCredentials({ accountSid: SID, authToken: TOKEN, sender: '+14155550123' });
    await new TwilioWhatsAppProvider().listTemplates({ accountSid: SID, authToken: TOKEN, sender: '+14155550123' });
    expect(seen.map((call) => call.path)).toEqual([
      `/twilio/Accounts/${SID}.json`,
      `/twilio/Accounts/${SID}.json`,
      '/twilioContent/ContentAndApprovals?PageSize=500',
    ]);
  });

  it('Meta (with the pinned Graph version), Gupshup and Interakt', async () => {
    await new MetaWhatsAppProvider().validateCredentials({
      phoneNumberId: '1234567',
      businessAccountId: '7654321',
      accessToken: 'EAAlocal',
    });
    await new GupshupProvider().validateCredentials({
      apiKey: 'local',
      appName: 'LocalApp1',
      appId: 'abcdef12-0000',
      sourceNumber: '+919876543210',
    });
    await new InteraktProvider().validateCredentials({ apiKey: 'local' });
    expect(seen.map((call) => call.path.split('?')[0])).toEqual([
      `/metaGraph/${GRAPH_VERSION}/1234567`,
      `/metaGraph/${GRAPH_VERSION}/7654321/message_templates`,
      '/gupshup/wa/app/abcdef12-0000/template',
      '/interakt/apis/users/',
    ]);
  });

  it('Mixpanel', async () => {
    await expect(new MixpanelApiService().testConnection('user', 'secret', '42')).resolves.toBe(true);
    expect(seen).toEqual([{ method: 'GET', path: '/mixpanel/cohorts/list?project_id=42' }]);
  });

  it("FCM: the token exchange and the send, over plain http, without Google's agent", async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const result = await new FcmProvider().send(
      {
        project_id: 'local-project',
        client_email: 'sender@local-project.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      ['device-token'],
      { title: 'Hello' },
    );
    expect(result.successCount).toBe(1);
    expect(seen).toEqual([
      { method: 'POST', path: '/googleOauth/token' },
      { method: 'POST', path: '/fcm/v1/projects/local-project/messages:send' },
    ]);
  });
});
