import { describeChannelProviderConformance } from '../../push-notifications/services/channel-provider.conformance';
import { ChannelRecipient } from '../../push-notifications/services/channel-provider';
import { EmailMessage } from '../email-rendering';
import { ResendProvider } from './resend.provider';
import { SES_ACCOUNT_ID_CACHE_ENTRIES, SES_STS_TIMEOUT_MS, SesProvider } from './ses.provider';
import { EMAIL_PROVIDER_TIMEOUT_MS } from './email-provider';
import { BrevoProvider, parseFrom } from './brevo.provider';

const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  from: '"Shop" <hi@shop.example>',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  headers: { 'List-Unsubscribe': '<https://x/u>' },
  tags: { chumbaq_campaign_id: 'c1', chumbaq_identity_id: 'i1' },
  ...over,
});

const recipients = (count: number): ChannelRecipient<EmailMessage>[] =>
  Array.from({ length: count }, (_, i) => ({
    token: `person${i}@example.com`,
    message: message(),
  }));

const resendCreds = { apiKey: 're_test_123' };
const sesCreds = {
  region: 'ap-south-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  configurationSetName: 'chumbaq',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let fetchMock: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
});

/** Providers with retry pacing removed, so a test is not slowed by backoff. */
class FastResend extends ResendProvider {
  protected retryDelayMs(): number {
    return 0;
  }
}
class FastBrevo extends BrevoProvider {
  protected retryDelayMs(): number {
    return 0;
  }
}
class FastSes extends SesProvider {
  protected retryDelayMs(): number {
    return 0;
  }
}

describeChannelProviderConformance<EmailMessage>('ResendProvider', () => new FastResend(), {
  credentials: resendCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => {
    fetchMock.mockImplementation(async () => json(200, { id: 'msg' }));
  },
});

describeChannelProviderConformance<EmailMessage>('SesProvider', () => new FastSes(), {
  credentials: sesCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => {
    fetchMock.mockImplementation(async () => json(200, { MessageId: 'msg' }));
  },
});

const brevoCreds = { apiKey: 'xkeysib-abc123' };

describeChannelProviderConformance<EmailMessage>('BrevoProvider', () => new FastBrevo(), {
  credentials: brevoCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => {
    fetchMock.mockImplementation(async () => json(201, { messageId: '<m@smtp-relay.mailin.fr>' }));
  },
});

describe('BrevoProvider', () => {
  it('sends sender, tags and headers the way Brevo expects them', async () => {
    fetchMock.mockImplementation(async () => json(201, { messageId: 'm' }));

    await new FastBrevo().sendToRecipients(brevoCreds, [
      { token: 'a@example.com', message: message({ replyTo: 'help@shop.example' }) },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('xkeysib-abc123');
    const body = JSON.parse(init.body);
    expect(body.sender).toEqual({ email: 'hi@shop.example', name: 'Shop' });
    expect(body.to).toEqual([{ email: 'a@example.com' }]);
    expect(body.replyTo).toEqual({ email: 'help@shop.example' });
    expect(body.htmlContent).toBe('<p>Hi</p>');
    expect(body.textContent).toBe('Hi');
    expect(body.headers['List-Unsubscribe']).toBe('<https://x/u>');
    // Brevo tags are bare strings, so each carries its own name.
    expect(body.tags).toEqual(['chumbaq_campaign_id:c1', 'chumbaq_identity_id:i1']);
  });

  it('records an invalid recipient as permanent', async () => {
    fetchMock.mockImplementation(async () =>
      json(400, { code: 'invalid_parameter', message: 'email is not valid in to' }),
    );
    const result = await new FastBrevo().sendToRecipients(brevoCreds, recipients(1));
    expect(result).toMatchObject({ failureCount: 1, resolvedCount: 1 });
    expect(result.failures[0].errorCode).toBe('invalid_parameter');
  });

  it('stops the page when the account is locked to other IPs', async () => {
    fetchMock.mockImplementation(async () =>
      json(401, { code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address' }),
    );
    const provider = new FastBrevo();
    (provider as unknown as { concurrency: number }).concurrency = 1;
    const result = await provider.sendToRecipients(brevoCreds, recipients(3));
    expect(result.resolvedCount).toBe(0);
    expect(result.retryReason).toContain('unrecognised IP');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops the page when the account is out of credits', async () => {
    fetchMock.mockImplementation(async () =>
      json(402, { code: 'not_enough_credits', message: 'Not enough credits' }),
    );
    const result = await new FastBrevo().sendToRecipients(brevoCreds, recipients(2));
    expect(result.resolvedCount).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('retries while rate limited without dropping anyone', async () => {
    fetchMock.mockImplementation(async () => json(429, { code: 'too_many_requests', message: 'slow' }));
    const result = await new FastBrevo().sendToRecipients(brevoCreds, recipients(2));
    expect(result.resolvedCount).toBe(0);
    expect(result.retryReason).toContain('429');
  });

  it('explains an SMTP key pasted in place of an API key', async () => {
    await expect(
      new FastBrevo().validateCredentials({ apiKey: 'xsmtpsib-abc' }),
    ).rejects.toThrow(/SMTP key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the key against the account endpoint', async () => {
    fetchMock.mockImplementation(async () => json(200, { email: 'owner@shop.example' }));
    await expect(new FastBrevo().validateCredentials(brevoCreds)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.brevo.com/v3/account');

    fetchMock.mockImplementation(async () => json(401, { code: 'unauthorized', message: 'Key not found' }));
    await expect(new FastBrevo().validateCredentials(brevoCreds)).rejects.toThrow(/Key not found/);
  });

  it('splits a formatted From into Brevo sender parts', () => {
    expect(parseFrom('"Shop \\"Best\\"" <hi@shop.example>')).toEqual({
      email: 'hi@shop.example',
      name: 'Shop "Best"',
    });
    expect(parseFrom('hi@shop.example')).toEqual({ email: 'hi@shop.example' });
  });
});

describe('ResendProvider', () => {
  it('sends headers, tags and reply-to the way Resend expects them', async () => {
    fetchMock.mockImplementation(async () => json(200, { id: 'msg' }));

    await new FastResend().sendToRecipients(resendCreds, [
      { token: 'a@example.com', message: message({ replyTo: 'help@shop.example' }) },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['a@example.com']);
    expect(body.reply_to).toBe('help@shop.example');
    expect(body.headers['List-Unsubscribe']).toBe('<https://x/u>');
    expect(body.tags).toEqual([
      { name: 'chumbaq_campaign_id', value: 'c1' },
      { name: 'chumbaq_identity_id', value: 'i1' },
    ]);
    expect(init.headers.Authorization).toBe('Bearer re_test_123');
  });

  it('records a rejected address as permanent and carries on', async () => {
    fetchMock
      .mockResolvedValueOnce(json(422, { name: 'validation_error', message: 'Invalid `to`' }))
      .mockImplementation(async () => json(200, { id: 'msg' }));

    const provider = new FastResend();
    // One lane, so the order of responses maps to the order of recipients.
    (provider as unknown as { concurrency: number }).concurrency = 1;
    const result = await provider.sendToRecipients(resendCreds, recipients(2));

    expect(result).toMatchObject({ successCount: 1, failureCount: 1, resolvedCount: 2 });
    expect(result.failures[0]).toMatchObject({
      token: 'person0@example.com',
      errorCode: 'validation_error',
    });
  });

  it('stops the page short, without dropping anyone, while rate limited', async () => {
    fetchMock.mockImplementation(async () => json(429, { name: 'rate_limit_exceeded', message: 'slow down' }));

    const result = await new FastResend().sendToRecipients(resendCreds, recipients(3));

    expect(result.resolvedCount).toBe(0);
    expect(result.retryReason).toContain('429');
  });

  it('stops the whole page on a revoked key instead of failing each address', async () => {
    fetchMock.mockImplementation(async () => json(401, { name: 'invalid_api_key', message: 'API key is invalid' }));

    const provider = new FastResend();
    (provider as unknown as { concurrency: number }).concurrency = 1;
    const result = await provider.sendToRecipients(resendCreds, recipients(3));

    expect(result.resolvedCount).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.retryReason).toContain('refused the API key');
    // Nobody after the first is even attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a sending-only key, which cannot list domains', async () => {
    fetchMock.mockImplementation(async () =>
      json(401, { name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }),
    );
    await expect(new FastResend().validateCredentials(resendCreds)).resolves.toBeUndefined();
  });

  it('refuses an unknown key when pasted', async () => {
    fetchMock.mockImplementation(async () => json(400, { name: 'validation_error', message: 'API key is invalid' }));
    await expect(new FastResend().validateCredentials(resendCreds)).rejects.toThrow(
      /Resend rejected this API key/,
    );
  });
});

describe('SesProvider', () => {
  it('signs a SendEmail call with unsubscribe headers and tags', async () => {
    fetchMock.mockImplementation(async () => json(200, { MessageId: 'msg' }));

    await new FastSes().sendToRecipients(sesCreds, [
      { token: 'a@example.com', message: message() },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails');
    expect(init.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/ap-south-1\/ses\/aws4_request/,
    );
    expect(init.headers.host).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.Destination.ToAddresses).toEqual(['a@example.com']);
    expect(body.ConfigurationSetName).toBe('chumbaq');
    expect(body.Content.Simple.Headers).toContainEqual({
      Name: 'List-Unsubscribe',
      Value: '<https://x/u>',
    });
    expect(body.EmailTags).toContainEqual({ Name: 'chumbaq_campaign_id', Value: 'c1' });
  });

  it('treats MessageRejected as this address failing', async () => {
    fetchMock.mockImplementation(async () =>
      json(400, { message: 'Email address is not verified.' }, { 'x-amzn-ErrorType': 'MessageRejected:' }),
    );
    const result = await new FastSes().sendToRecipients(sesCreds, recipients(1));
    expect(result).toMatchObject({ failureCount: 1, resolvedCount: 1 });
    expect(result.failures[0].errorCode).toBe('MessageRejected');
  });

  it('stops the page when the account is paused', async () => {
    fetchMock.mockImplementation(async () =>
      json(400, { message: 'Sending paused' }, { 'x-amzn-ErrorType': 'SendingPausedException' }),
    );
    const result = await new FastSes().sendToRecipients(sesCreds, recipients(2));
    expect(result.resolvedCount).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('refuses a malformed region before contacting AWS', async () => {
    await expect(
      new FastSes().validateCredentials({ ...sesCreds, region: 'mumbai' }),
    ).rejects.toThrow(/region/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an account with sending disabled', async () => {
    fetchMock.mockImplementation(async () => json(200, { SendingEnabled: false }));
    await expect(new FastSes().validateCredentials(sesCreds)).rejects.toThrow(/sending disabled/);
  });
});

describe('SesProvider.accountId', () => {
  const sts = (account: string) =>
    new Response(
      `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${account}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
      { status: 200 },
    );

  it('asks STS in the credentials region, signed for sts, and caches the answer', async () => {
    const provider = new FastSes();
    fetchMock.mockImplementation(async () => sts('123456789012'));

    await expect(provider.accountId(sesCreds)).resolves.toBe('123456789012');
    await expect(provider.accountId(sesCreds)).resolves.toBe('123456789012');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sts.ap-south-1.amazonaws.com/');
    expect(init.body).toBe('Action=GetCallerIdentity&Version=2011-06-15');
    expect(init.headers.authorization ?? init.headers.Authorization).toMatch(
      /\/ap-south-1\/sts\/aws4_request/,
    );
  });

  it('fails rather than guessing when STS refuses', async () => {
    fetchMock.mockImplementation(async () => new Response('<Error/>', { status: 403 }));
    await expect(new FastSes().accountId(sesCreds)).rejects.toThrow(/403/);
  });
});

/** A request that never answers; only the caller's signal ends it. */
const hangUntilAborted = async (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });

/** How it settled, or 'hung' if it did not within a second. */
const within = <T>(promise: Promise<T>) =>
  Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1_000)),
  ]);

describe('SesProvider.accountId time limit and cache', () => {
  const sts = (account: string) =>
    new Response(`<GetCallerIdentityResult><Account>${account}</Account></GetCallerIdentityResult>`);
  class QuickSts extends FastSes {
    protected readonly stsTimeoutMs = 50;
  }

  it('gives up on an STS lookup that never answers', async () => {
    expect(SES_STS_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    fetchMock.mockImplementation(hangUntilAborted);
    const result = await within(new QuickSts().accountId(sesCreds));
    expect(result).not.toBe('hung');
    expect(result).toHaveProperty('error');
  });

  it('does not answer from the cache for the same access key with another secret', async () => {
    const provider = new FastSes();
    fetchMock.mockImplementationOnce(async () => sts('123456789012'));
    await provider.accountId(sesCreds);
    fetchMock.mockImplementationOnce(async () => new Response('<Error/>', { status: 403 }));
    await expect(
      provider.accountId({ ...sesCreds, secretAccessKey: 'guessed' }),
    ).rejects.toThrow(/403/);
  });

  it(`remembers at most ${SES_ACCOUNT_ID_CACHE_ENTRIES} accounts`, async () => {
    const provider = new FastSes();
    fetchMock.mockImplementation(async () => sts('123456789012'));
    for (let i = 0; i < SES_ACCOUNT_ID_CACHE_ENTRIES + 50; i++) {
      await provider.accountId({ ...sesCreds, accessKeyId: `AKIA${i}` });
    }
    const cache = (provider as never as { accountIds: { size: number } }).accountIds;
    expect(cache.size).toBe(SES_ACCOUNT_ID_CACHE_ENTRIES);
  });
});

describe('email provider requests are time-limited', () => {
  class QuickResend extends FastResend {
    protected readonly requestTimeoutMs = 50;
  }
  class QuickBrevo extends FastBrevo {
    protected readonly requestTimeoutMs = 50;
  }
  class QuickSes extends FastSes {
    protected readonly requestTimeoutMs = 50;
  }
  const cases: Array<[string, () => FastSes | FastResend | FastBrevo, unknown]> = [
    ['Resend', () => new QuickResend(), resendCreds],
    ['Brevo', () => new QuickBrevo(), brevoCreds],
    ['SES', () => new QuickSes(), sesCreds],
  ];

  it('has a default no longer than half a minute', () => {
    expect(EMAIL_PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it.each(cases)('%s: a send that never answers ends as a retryable failure', async (_name, make, credentials) => {
    fetchMock.mockImplementation(hangUntilAborted);
    const result = await within(make().sendToRecipients(credentials, recipients(1)));
    expect(result).not.toBe('hung');
    expect(result).toMatchObject({ value: { resolvedCount: 0 } });
    // Each of the three attempts was given up on in turn.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(cases)('%s: a credentials check that never answers fails', async (_name, make, credentials) => {
    fetchMock.mockImplementation(hangUntilAborted);
    const result = await within(make().validateCredentials(credentials));
    expect(result).not.toBe('hung');
    expect(result).toHaveProperty('error');
  });
});
