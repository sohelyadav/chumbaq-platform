import { readFileSync } from 'fs';
import path from 'path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import providerEndpointsConfig, {
  PROVIDER_ENDPOINTS,
  ProviderEndpoint,
  providerBaseUrl,
  readProviderEndpoints,
} from './provider-endpoints.config';

const NAMES = Object.keys(PROVIDER_ENDPOINTS) as ProviderEndpoint[];
const STUB = 'http://127.0.0.1:4091/stub';

describe('provider base URL overrides (local stubs for end-to-end tests)', () => {
  it('names one variable per provider host, each ending in _API_BASE_URL, none shared', () => {
    const variables = NAMES.map((name) => PROVIDER_ENDPOINTS[name].variable);
    expect(new Set(variables).size).toBe(variables.length);
    for (const variable of variables) expect(variable).toMatch(/^[A-Z0-9_]+_API_BASE_URL$/);
    expect(variables).toEqual(
      expect.arrayContaining([
        'PLATFORM_BREVO_API_BASE_URL',
        'BREVO_API_BASE_URL',
        'RESEND_API_BASE_URL',
        'TWILIO_API_BASE_URL',
        'TWILIO_CONTENT_API_BASE_URL',
        'META_GRAPH_API_BASE_URL',
        'GUPSHUP_API_BASE_URL',
        'INTERAKT_API_BASE_URL',
        'MIXPANEL_API_BASE_URL',
        'FCM_API_BASE_URL',
        'GOOGLE_OAUTH2_API_BASE_URL',
      ]),
    );
  });

  it('is each provider itself when unset, in production too', () => {
    const endpoints = readProviderEndpoints({ NODE_ENV: 'production' });
    expect(endpoints).toEqual({
      platformBrevo: 'https://api.brevo.com/v3',
      brevo: 'https://api.brevo.com/v3',
      resend: 'https://api.resend.com',
      twilio: 'https://api.twilio.com/2010-04-01',
      twilioContent: 'https://content.twilio.com/v1',
      metaGraph: 'https://graph.facebook.com',
      gupshup: 'https://api.gupshup.io',
      interakt: 'https://api.interakt.ai/v1/public',
      mixpanel: 'https://mixpanel.com/api/2.0',
      fcm: 'https://fcm.googleapis.com',
      googleOauth: 'https://oauth2.googleapis.com',
    });
    // An empty value is unset, as for every other setting.
    expect(readProviderEndpoints({ NODE_ENV: 'production', RESEND_API_BASE_URL: '  ' }).resend).toBe(
      'https://api.resend.com',
    );
  });

  describe.each(NAMES)('%s', (name) => {
    const { variable } = PROVIDER_ENDPOINTS[name];

    it('is used in development and test, without a trailing slash', () => {
      expect(readProviderEndpoints({ NODE_ENV: 'test', [variable]: STUB })[name]).toBe(STUB);
      expect(readProviderEndpoints({ NODE_ENV: 'development', [variable]: `${STUB}/` })[name]).toBe(STUB);
      expect(providerBaseUrl(name, { NODE_ENV: 'test', [variable]: STUB })).toBe(STUB);
      // Only its own provider moves.
      const others = readProviderEndpoints({ NODE_ENV: 'test', [variable]: STUB });
      for (const other of NAMES.filter((n) => n !== name)) {
        expect(others[other]).toBe(PROVIDER_ENDPOINTS[other].defaultUrl);
      }
    });

    it('is refused in production, and wherever NODE_ENV is anything else or unset', () => {
      const refused = new RegExp(`^${variable} is only allowed when NODE_ENV is development or test$`);
      for (const NODE_ENV of ['production', 'staging', 'integration', 'Test', undefined]) {
        expect(() => readProviderEndpoints({ NODE_ENV, [variable]: STUB })).toThrow(refused);
        // The call-time read refuses it too, so nothing can be sent there.
        expect(() => providerBaseUrl(name, { NODE_ENV, [variable]: STUB })).toThrow(refused);
      }
    });

    it('is refused unless it is a plain http or https URL', () => {
      for (const value of ['not a url', 'ftp://127.0.0.1/v1', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1?x=1', 'http://127.0.0.1/v1#x']) {
        expect(() => readProviderEndpoints({ NODE_ENV: 'test', [variable]: value })).toThrow(
          `${variable} must be an http or https URL`,
        );
      }
    });

    it('never names the value in its error', () => {
      for (const NODE_ENV of ['production', 'test']) {
        const value = NODE_ENV === 'test' ? 'ftp://secret-host.example/v1' : 'https://secret-host.example/v1';
        expect(() => readProviderEndpoints({ NODE_ENV, [variable]: value })).toThrow(
          expect.objectContaining({ message: expect.not.stringContaining('secret-host') }),
        );
      }
    });
  });

  describe('at boot', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, FCM_API_BASE_URL: process.env.FCM_API_BASE_URL };
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const boot = () =>
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [providerEndpointsConfig] })],
      }).compile();

    it('stops an app that loads the config, when an override is set in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.FCM_API_BASE_URL = STUB;
      await expect(boot()).rejects.toThrow('FCM_API_BASE_URL is only allowed when NODE_ENV is development or test');
    });

    it('boots in test with the override', async () => {
      process.env.NODE_ENV = 'test';
      process.env.FCM_API_BASE_URL = STUB;
      const app = await boot();
      expect(app.get(ConfigService).get('providerEndpoints.fcm')).toBe(STUB);
      await app.close();
    });

    it.each(['app.module.ts', 'admin-app.module.ts', 'worker.module.ts'])('is loaded by %s', (file) => {
      const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(source).toMatch(/load: \[[^\]]*\bproviderEndpointsConfig\b[^\]]*\]/);
    });
  });
});
