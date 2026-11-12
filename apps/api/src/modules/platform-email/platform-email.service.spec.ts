import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformEmailService } from './platform-email.service';

const KEY = 'xkeysib-secret-value';
const EMAIL = {
  to: 'person@example.com',
  subject: 'Reset your password',
  html: '<a href="https://app/reset?token=reset-token-value">Reset</a>',
  text: 'https://app/reset?token=reset-token-value',
};

describe('PlatformEmailService', () => {
  const build = (env: Record<string, string | undefined>) =>
    new PlatformEmailService({ get: (key: string) => env[key] } as unknown as ConfigService);
  const configured = () =>
    build({ PLATFORM_BREVO_API_KEY: KEY, PLATFORM_EMAIL_FROM: 'Chumbaq <no-reply@example.com>' });

  let fetchMock: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    fetchMock = jest.spyOn(global, 'fetch');
    const capture = (message: unknown) => void logged.push(String(message));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['no key', { PLATFORM_EMAIL_FROM: 'a@example.com' }],
    ['no sender', { PLATFORM_BREVO_API_KEY: KEY }],
    ['an unusable sender', { PLATFORM_BREVO_API_KEY: KEY, PLATFORM_EMAIL_FROM: 'not an address' }],
  ])('reports not configured and calls nobody with %s', async (_label, env) => {
    const service = build(env);

    expect(service.isConfigured).toBe(false);
    await expect(service.send(EMAIL)).resolves.toEqual({ sent: false, reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends to Brevo with the key in a header and the sender parsed', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));

    await expect(configured().send(EMAIL)).resolves.toEqual({ sent: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({
      sender: { name: 'Chumbaq', email: 'no-reply@example.com' },
      to: [{ email: 'person@example.com' }],
      subject: EMAIL.subject,
      htmlContent: EMAIL.html,
      textContent: EMAIL.text,
    });
  });

  it('accepts a bare address as the sender', () => {
    const service = build({ PLATFORM_BREVO_API_KEY: KEY, PLATFORM_EMAIL_FROM: 'a@example.com' });

    expect(service.sender).toEqual({ email: 'a@example.com' });
  });

  it('reports a refusal, logging why but not the key or the link', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), {
        status: 401,
      }),
    );

    await expect(configured().send(EMAIL)).resolves.toEqual({ sent: false, reason: 'refused' });

    expect(logged.join()).toContain('Key not found');
    expect(logged.join()).not.toContain(KEY);
    expect(logged.join()).not.toContain('reset-token-value');
  });

  it('reports a network failure rather than throwing, and logs no detail from it', async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${KEY}`));

    await expect(configured().send(EMAIL)).resolves.toEqual({ sent: false, reason: 'unreachable' });
    expect(logged.join()).not.toContain(KEY);
  });
});
