import { describeChannelProviderConformance } from '../../push-notifications/services/channel-provider.conformance';
import { ChannelRecipient } from '../../push-notifications/services/channel-provider';
import { SmsMessage } from '../sms-rendering';
import { TwilioProvider } from './twilio.provider';
import { PROVIDER_REQUEST_TIMEOUT_MS } from '../../push-notifications/services/per-recipient-provider';

const SID = `AC${'a'.repeat(32)}`;
const TOKEN = 'b'.repeat(32);
const creds = { accountSid: SID, authToken: TOKEN };

const message = (over: Partial<SmsMessage> = {}): SmsMessage => ({
  from: '+14155550100',
  body: 'Sale today',
  statusCallback: 'https://api.example.com/api/sms/webhooks/twilio/t/status?c=c1&i=i1',
  ...over,
});

const recipients = (count: number): ChannelRecipient<SmsMessage>[] =>
  Array.from({ length: count }, (_, i) => ({
    token: `+1415555${String(i).padStart(4, '0')}`,
    message: message(),
  }));

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

class FastTwilio extends TwilioProvider {
  protected retryDelayMs(): number {
    return 0;
  }
}

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  fetchMock.mockRestore();
});

describeChannelProviderConformance<SmsMessage>('TwilioProvider', () => new FastTwilio(), {
  credentials: creds,
  makeRecipients: recipients,
  stubAllDelivered: () => {
    fetchMock.mockImplementation(async () => json(201, { sid: 'SM1', status: 'queued' }));
  },
});

describe('TwilioProvider', () => {
  const provider = new FastTwilio();

  it('posts a form with basic auth, From and the status callback', async () => {
    fetchMock.mockImplementation(async () => json(201, { sid: 'SM1' }));

    const result = await provider.sendToRecipients(creds, recipients(1));

    expect(result.successCount).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
    );
    const form = new URLSearchParams(init.body);
    expect(form.get('To')).toBe('+14155550000');
    expect(form.get('From')).toBe('+14155550100');
    expect(form.get('MessagingServiceSid')).toBeNull();
    expect(form.get('Body')).toBe('Sale today');
    expect(form.get('StatusCallback')).toContain('/status?c=c1&i=i1');
  });

  it('sends through a Messaging Service when the sender is an MG SID', async () => {
    fetchMock.mockImplementation(async () => json(201, { sid: 'SM1' }));
    const mg = `MG${'c'.repeat(32)}`;

    await provider.sendToRecipients(creds, [{ token: '+14155550000', message: message({ from: mg }) }]);

    const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(form.get('MessagingServiceSid')).toBe(mg);
    expect(form.get('From')).toBeNull();
  });

  it('reports a number that replied STOP as a permanent failure carrying its code', async () => {
    fetchMock.mockImplementation(async () =>
      json(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 }),
    );

    const result = await provider.sendToRecipients(creds, recipients(1));

    expect(result.resolvedCount).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ token: '+14155550000', errorCode: '21610', retryable: false }),
    ]);
    // Permanent: asked once, not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops the page on a sender the account cannot use, without failing anyone', async () => {
    fetchMock.mockImplementation(async () =>
      json(400, { code: 21606, message: "The 'From' phone number provided is not a valid message-capable Twilio phone number" }),
    );

    const result = await provider.sendToRecipients(creds, recipients(3));

    expect(result.resolvedCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.retryReason).toMatch(/21606/);
  });

  it('stops the page on revoked credentials', async () => {
    fetchMock.mockImplementation(async () => json(401, { code: 20003, message: 'Authenticate' }));

    const result = await provider.sendToRecipients(creds, recipients(2));

    expect(result.resolvedCount).toBe(0);
    expect(result.retryReason).toMatch(/refused/);
  });

  it('retries a rate limit and succeeds', async () => {
    fetchMock
      .mockImplementationOnce(async () => json(429, { code: 20429, message: 'Too Many Requests' }))
      .mockImplementation(async () => json(201, { sid: 'SM1' }));

    const result = await provider.sendToRecipients(creds, recipients(1));

    expect(result.successCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('credentials', () => {
    it('refuses an Account SID that is not one', async () => {
      await expect(
        provider.validateCredentials({ accountSid: 'SK123', authToken: TOKEN }),
      ).rejects.toThrow(/Account SID/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an auth token of the wrong shape before calling Twilio', async () => {
      await expect(
        provider.validateCredentials({ accountSid: SID, authToken: 'short' }),
      ).rejects.toThrow(/Auth Token/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts credentials Twilio accepts for an active account', async () => {
      fetchMock.mockImplementation(async () => json(200, { sid: SID, status: 'active' }));
      await expect(provider.validateCredentials(creds)).resolves.toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
    });

    it('refuses a suspended account', async () => {
      fetchMock.mockImplementation(async () => json(200, { sid: SID, status: 'suspended' }));
      await expect(provider.validateCredentials(creds)).rejects.toThrow(/suspended/);
    });

    it("passes on Twilio's reason for refusing", async () => {
      fetchMock.mockImplementation(async () => json(401, { code: 20003, message: 'Authenticate' }));
      await expect(provider.validateCredentials(creds)).rejects.toThrow(/401 20003 Authenticate/);
    });
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

describe('Twilio requests are time-limited', () => {
  class QuickTwilio extends FastTwilio {
    protected readonly requestTimeoutMs = 50;
  }

  it('has a default no longer than half a minute', () => {
    expect(PROVIDER_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('a send that never answers ends as a retryable failure', async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const result = await within(new QuickTwilio().sendToRecipients(creds, recipients(1)));
    expect(result).not.toBe('hung');
    expect(result).toMatchObject({ value: { resolvedCount: 0 } });
    // Each of the three attempts was given up on in turn.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a credentials check that never answers fails', async () => {
    fetchMock.mockImplementation(hangUntilAborted);
    const result = await within(new QuickTwilio().validateCredentials(creds));
    expect(result).not.toBe('hung');
    expect(result).toHaveProperty('error');
  });
});
