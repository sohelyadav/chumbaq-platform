import { createHmac } from 'crypto';
import { describeChannelProviderConformance } from '../../push-notifications/services/channel-provider.conformance';
import { ChannelRecipient } from '../../push-notifications/services/channel-provider';
import { WhatsAppMessage } from '../whatsapp-rendering';
import { MetaWhatsAppProvider } from './meta.provider';
import { TwilioWhatsAppProvider } from './twilio-whatsapp.provider';
import { GupshupProvider } from './gupshup.provider';
import { InteraktProvider, parseCallbackData, splitNumber } from './interakt.provider';
import { WebhookRequest } from './whatsapp-provider';

const C = '11111111-1111-4111-8111-111111111111';
const I = '22222222-2222-4222-8222-222222222222';

const message = (over: Partial<WhatsAppMessage> = {}): WhatsAppMessage => ({
  template: { id: 'promo', name: 'promo', language: 'en' },
  bodyParams: ['Priya', '20%'],
  headerText: null,
  headerMediaUrl: null,
  headerMediaType: null,
  buttonParams: [],
  campaignId: C,
  identityId: I,
  ...over,
});

const recipients = (count: number): ChannelRecipient<WhatsAppMessage>[] =>
  Array.from({ length: count }, (_, i) => ({
    token: `+9198765${String(i).padStart(5, '0')}`,
    message: message(),
  }));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function webhook(body: unknown, headers: Record<string, string> = {}, rawBody?: string): WebhookRequest {
  const raw = rawBody ?? JSON.stringify(body);
  return {
    url: 'https://api.example/api/whatsapp/webhooks/x/t',
    rawBody: raw,
    body,
    query: {},
    header: (name) => headers[name.toLowerCase()],
  };
}

class FastMeta extends MetaWhatsAppProvider { protected retryDelayMs() { return 0; } }
class FastTwilio extends TwilioWhatsAppProvider { protected retryDelayMs() { return 0; } }
class FastGupshup extends GupshupProvider { protected retryDelayMs() { return 0; } }
class FastInterakt extends InteraktProvider { protected retryDelayMs() { return 0; } }

const metaCreds = { phoneNumberId: '1059545589544', businessAccountId: '2059545589544', accessToken: 'EAAG-token', appSecret: 'shh' };
const twilioCreds = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), sender: '+14155550100' };
const gupshupCreds = { apiKey: 'gs-key', appName: 'myshopapp', appId: 'a1b2c3d4-0000', sourceNumber: '+919000000000' };
const interaktCreds = { apiKey: 'aW50ZXJha3Q6a2V5', webhookSecret: 'examplekey' };

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => fetchMock.mockRestore());

describeChannelProviderConformance<WhatsAppMessage>('MetaWhatsAppProvider', () => new FastMeta(), {
  credentials: metaCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => fetchMock.mockImplementation(async () => json(200, { messages: [{ id: 'wamid.1' }] })),
});
describeChannelProviderConformance<WhatsAppMessage>('TwilioWhatsAppProvider', () => new FastTwilio(), {
  credentials: twilioCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => fetchMock.mockImplementation(async () => json(201, { sid: 'SM1' })),
});
describeChannelProviderConformance<WhatsAppMessage>('GupshupProvider', () => new FastGupshup(), {
  credentials: gupshupCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => fetchMock.mockImplementation(async () => json(202, { status: 'submitted', messageId: 'm1' })),
});
describeChannelProviderConformance<WhatsAppMessage>('InteraktProvider', () => new FastInterakt(), {
  credentials: interaktCreds,
  makeRecipients: recipients,
  stubAllDelivered: () => fetchMock.mockImplementation(async () => json(201, { result: true, id: 'x' })),
});

describe('MetaWhatsAppProvider', () => {
  const provider = new FastMeta();

  it('sends the template with components, our ids in biz_opaque_callback_data, and the + kept', async () => {
    fetchMock.mockImplementation(async () => json(200, { messages: [{ id: 'wamid.1' }] }));
    await provider.sendToRecipients(metaCreds, [{
      token: '+919876543210',
      message: message({
        headerMediaUrl: 'https://cdn.example/banner.png',
        headerMediaType: 'image',
        buttonParams: ['SALE20'],
      }),
    }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/graph\.facebook\.com\/v\d+\.0\/1059545589544\/messages$/);
    expect(init.headers.authorization).toBe('Bearer EAAG-token');
    const body = JSON.parse(init.body);
    expect(body.to).toBe('+919876543210');
    expect(JSON.parse(body.biz_opaque_callback_data)).toEqual({ c: C, i: I });
    expect(body.template).toEqual({
      name: 'promo',
      language: { code: 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example/banner.png' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Priya' }, { type: 'text', text: '20%' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'SALE20' }] },
      ],
    });
  });

  it('names parameters for a template written with named placeholders', async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    await provider.sendToRecipients(metaCreds, [{
      token: '+919876543210',
      message: message({ template: { id: 'promo', name: 'promo', language: 'en', paramNames: ['first_name', 'offer'] } }),
    }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', parameter_name: 'first_name', text: 'Priya' },
      { type: 'text', parameter_name: 'offer', text: '20%' },
    ]);
  });

  it('stops the page on a template Meta does not have, failing nobody', async () => {
    fetchMock.mockImplementation(async () => json(400, { error: { code: 132001, message: 'Template name does not exist in the translation' } }));
    const result = await provider.sendToRecipients(metaCreds, recipients(3));
    expect(result.resolvedCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.retryReason).toMatch(/132001/);
  });

  it('retries a throughput limit', async () => {
    fetchMock
      .mockImplementationOnce(async () => json(400, { error: { code: 130429, message: 'Rate limit hit' } }))
      .mockImplementation(async () => json(200, {}));
    const result = await provider.sendToRecipients(metaCreds, recipients(1));
    expect(result.successCount).toBe(1);
  });

  it('reports an opted-out person as a permanent failure with its code', async () => {
    fetchMock.mockImplementation(async () => json(400, { error: { code: 131050, message: 'User stopped marketing' } }));
    const result = await provider.sendToRecipients(metaCreds, recipients(1));
    expect(result.failures[0]).toMatchObject({ errorCode: '131050', retryable: false });
    expect(provider.suppressingErrors.get('131050')).toBe('unsubscribed');
  });

  it('reads named and numbered templates, buttons and headers', async () => {
    fetchMock.mockImplementation(async () =>
      json(200, {
        data: [
          {
            name: 'welcome', language: 'en_US', status: 'APPROVED', category: 'MARKETING', parameter_format: 'NAMED',
            components: [
              { type: 'HEADER', format: 'IMAGE' },
              { type: 'BODY', text: 'Hi {{first_name}}, use {{code}}. Bye {{first_name}}' },
              { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop', url: 'https://x.com/{{1}}' }, { type: 'QUICK_REPLY', text: 'Stop' }] },
            ],
          },
          { name: 'otp', language: 'en', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Code {{1}} {{2}}' }] },
        ],
        paging: {},
      }),
    );
    const [welcome, otp] = await provider.listTemplates(metaCreds);
    expect(welcome).toMatchObject({
      id: 'welcome', language: 'en_US', status: 'APPROVED', paramNames: ['first_name', 'code'], bodyParamCount: 2,
      header: { format: 'IMAGE' },
      buttons: [{ type: 'URL', dynamic: true }, { type: 'QUICK_REPLY', dynamic: false }],
    });
    expect(otp).toMatchObject({ status: 'PENDING', paramNames: null, bodyParamCount: 2, header: null });
  });

  it('verifies X-Hub-Signature-256 over the raw body with the app secret', () => {
    const raw = '{"entry":[]}';
    const signature = `sha256=${createHmac('sha256', 'shh').update(raw).digest('hex')}`;
    expect(provider.authenticateWebhook(metaCreds, webhook({}, { 'x-hub-signature-256': signature }, raw))).toBe(true);
    expect(provider.authenticateWebhook(metaCreds, webhook({}, { 'x-hub-signature-256': signature }, `${raw} `))).toBe(false);
    expect(provider.authenticateWebhook({ ...metaCreds, appSecret: undefined }, webhook({}))).toBe('unsigned');
  });

  it('parses statuses, replies and marketing stop preferences', () => {
    const events = provider.parseWebhook(webhook({
      entry: [{ changes: [{ value: {
        statuses: [
          { status: 'read', recipient_id: '919876543210', timestamp: '1793530800', biz_opaque_callback_data: JSON.stringify({ c: C, i: I }) },
          { status: 'failed', recipient_id: '919876543211', timestamp: '1793530800', errors: [{ code: 131026, title: 'Undeliverable' }] },
          { status: 'sent', recipient_id: '919876543212', timestamp: '1793530800' },
        ],
        messages: [{ from: '919876543213', timestamp: '1793530800', text: { body: 'STOP' } }],
        user_preferences: [{ wa_id: '919876543214', category: 'marketing_messages', value: 'stop', timestamp: '1793530800' }],
      } }] }],
    }));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'status', status: 'read', address: '+919876543210', campaignId: C, identityId: I }),
      expect.objectContaining({ kind: 'status', status: 'failed', address: '+919876543211', errorCode: '131026', campaignId: null }),
      expect.objectContaining({ kind: 'inbound', address: '+919876543213', text: 'STOP' }),
      expect.objectContaining({ kind: 'inbound', address: '+919876543214', text: 'STOP' }),
    ]);
  });
});

describe('TwilioWhatsAppProvider', () => {
  const provider = new FastTwilio();

  it('sends a Content template to whatsapp: addresses with numbered variables', async () => {
    fetchMock.mockImplementation(async () => json(201, { sid: 'SM1' }));
    await provider.sendToRecipients(twilioCreds, [{
      token: '+919876543210',
      message: message({ template: { id: `HX${'c'.repeat(32)}`, name: 'promo', language: 'en' }, statusCallback: 'https://api/cb?c=1' }),
    }]);
    const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(form.get('To')).toBe('whatsapp:+919876543210');
    expect(form.get('From')).toBe('whatsapp:+14155550100');
    expect(form.get('ContentSid')).toBe(`HX${'c'.repeat(32)}`);
    expect(JSON.parse(form.get('ContentVariables')!)).toEqual({ 1: 'Priya', 2: '20%' });
    expect(form.get('StatusCallback')).toBe('https://api/cb?c=1');
    expect(form.get('Body')).toBeNull();
  });

  it('stops the page when Meta has disabled the business account', async () => {
    fetchMock.mockImplementation(async () => json(400, { code: 63112, message: 'WABA disabled' }));
    const result = await provider.sendToRecipients(twilioCreds, recipients(2));
    expect(result.resolvedCount).toBe(0);
    expect(result.retryReason).toMatch(/63112/);
  });

  it('reads Content templates with their WhatsApp approval', async () => {
    fetchMock.mockImplementation(async () => json(200, {
      contents: [{
        sid: 'HX1', friendly_name: 'promo', language: 'en', variables: { 1: 'name', 2: 'offer' },
        types: { 'twilio/text': { body: 'Hi {{1}}, {{2}} off' } },
        approval_requests: { name: 'promo', category: 'marketing', status: 'approved' },
      }],
      meta: { next_page_url: null },
    }));
    expect(await provider.listTemplates(twilioCreds)).toEqual([expect.objectContaining({
      id: 'HX1', name: 'promo', status: 'APPROVED', category: 'MARKETING', bodyText: 'Hi {{1}}, {{2}} off', bodyParamCount: 2,
    })]);
  });

  it('parses a status callback with our ids and a reply from whatsapp: numbers', () => {
    const status = provider.parseWebhook({
      ...webhook({ To: 'whatsapp:+919876543210', MessageStatus: 'undelivered', ErrorCode: '63024' }),
      query: { c: C, i: I },
    });
    expect(status).toEqual([expect.objectContaining({ status: 'failed', address: '+919876543210', campaignId: C, errorCode: '63024' })]);
    const reply = provider.parseWebhook(webhook({ From: 'whatsapp:+919876543210', Body: 'Stop', SmsStatus: 'received' }));
    expect(reply).toEqual([expect.objectContaining({ kind: 'inbound', text: 'Stop', address: '+919876543210' })]);
  });
});

describe('GupshupProvider', () => {
  const provider = new FastGupshup();

  it('sends the template id with params, numbers without +, and a media header', async () => {
    fetchMock.mockImplementation(async () => json(202, { status: 'submitted', messageId: 'm1' }));
    await provider.sendToRecipients(gupshupCreds, [{
      token: '+919876543210',
      message: message({ template: { id: 'uuid-1', name: 'promo', language: 'en' }, headerMediaUrl: 'https://cdn/x.png', headerMediaType: 'image' }),
    }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.gupshup.io/wa/api/v1/template/msg');
    expect(init.headers.apikey).toBe('gs-key');
    const form = new URLSearchParams(init.body);
    expect(form.get('source')).toBe('919000000000');
    expect(form.get('destination')).toBe('919876543210');
    expect(form.get('src.name')).toBe('myshopapp');
    expect(JSON.parse(form.get('template')!)).toEqual({ id: 'uuid-1', params: ['Priya', '20%'] });
    expect(JSON.parse(form.get('message')!)).toEqual({ type: 'image', image: { link: 'https://cdn/x.png' } });
  });

  it('stops the page on a rejected key', async () => {
    fetchMock.mockImplementation(async () => json(401, { message: 'Authentication Failed', status: 'error' }));
    const result = await provider.sendToRecipients(gupshupCreds, recipients(2));
    expect(result.resolvedCount).toBe(0);
    expect(result.retryReason).toMatch(/Authentication Failed/);
  });

  it('is unsigned, and reports carry no campaign of ours', () => {
    expect(provider.authenticateWebhook()).toBe('unsigned');
    expect(provider.reportsCarryCampaign).toBe(false);
  });

  it('parses failed events, replies and opt-out user events', () => {
    expect(provider.parseWebhook(webhook({
      type: 'message-event', timestamp: 1793530800000,
      payload: { type: 'failed', destination: '919876543210', payload: { code: 1002, reason: 'Number does not exist on WhatsApp' } },
    }))).toEqual([expect.objectContaining({ kind: 'status', status: 'failed', address: '+919876543210', errorCode: '1002' })]);
    expect(provider.parseWebhook(webhook({
      type: 'message', payload: { type: 'text', sender: { phone: '919876543210' }, payload: { text: 'stop' } },
    }))).toEqual([expect.objectContaining({ kind: 'inbound', text: 'stop' })]);
    expect(provider.parseWebhook(webhook({ type: 'user-event', payload: { phone: '919876543210', type: 'opted-out' } })))
      .toEqual([expect.objectContaining({ kind: 'inbound', text: 'STOP', address: '+919876543210' })]);
  });

  it('reads templates and counts body placeholders', async () => {
    fetchMock.mockImplementation(async () => json(200, {
      status: 'success',
      templates: [{ id: 'uuid-1', elementName: 'promo', languageCode: 'en', status: 'APPROVED', category: 'MARKETING', data: 'Hi {{1}}, {{2}} off', templateType: 'IMAGE' }],
    }));
    expect(await provider.listTemplates(gupshupCreds)).toEqual([expect.objectContaining({
      id: 'uuid-1', name: 'promo', bodyParamCount: 2, header: expect.objectContaining({ format: 'IMAGE' }),
    })]);
  });
});

describe('InteraktProvider', () => {
  const provider = new FastInterakt();

  it('splits the number, sends the key as-is, and carries our ids as callbackData', async () => {
    fetchMock.mockImplementation(async () => json(201, { result: true, id: 'x' }));
    await provider.sendToRecipients(interaktCreds, [{ token: '+919876543210', message: message({ buttonParams: ['abc'] }) }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.interakt.ai/v1/public/message/');
    expect(init.headers.authorization).toBe('Basic aW50ZXJha3Q6a2V5');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      countryCode: '+91',
      phoneNumber: '9876543210',
      type: 'Template',
      template: { name: 'promo', languageCode: 'en', bodyValues: ['Priya', '20%'], buttonValues: { 0: ['abc'] } },
    });
    expect(parseCallbackData(body.callbackData)).toEqual({ campaignId: C, identityId: I });
  });

  it('splits calling codes of every length', () => {
    expect(splitNumber('+14155550100')).toEqual({ countryCode: '+1', phoneNumber: '4155550100' });
    expect(splitNumber('+447700900123')).toEqual({ countryCode: '+44', phoneNumber: '7700900123' });
    expect(splitNumber('+971501234567')).toEqual({ countryCode: '+971', phoneNumber: '501234567' });
  });

  it("verifies Interakt-Signature with Interakt's documented vector", () => {
    const raw = '{"foo":1,"bar":2}';
    const signature = 'sha256=b84783d10ede5bd6ed771e8b16fbe5a7093340159d6e49ec4248350b6ec2c7b4';
    expect(provider.authenticateWebhook(interaktCreds, webhook({}, { 'interakt-signature': signature }, raw))).toBe(true);
    expect(provider.authenticateWebhook(interaktCreds, webhook({}, { 'interakt-signature': signature }, '{"foo":2,"bar":2}'))).toBe(false);
    expect(provider.authenticateWebhook({ apiKey: 'k' }, webhook({}))).toBe('unsigned');
  });

  it('parses delivery reports with our callbackData, and replies', () => {
    expect(provider.parseWebhook(webhook({
      type: 'message_api_failed', timestamp: '2026-11-01T10:00:00.000',
      data: {
        customer: { channel_phone_number: '919876543210' },
        message: { channel_error_code: '1013', channel_failure_reason: 'Recipient is not a valid WhatsApp user', meta_data: { source_data: { callback_data: JSON.stringify({ c: C, i: I }) } } },
      },
    }))).toEqual([expect.objectContaining({
      kind: 'status', status: 'failed', address: '+919876543210', campaignId: C, identityId: I, errorCode: '1013',
      occurredAt: new Date('2026-11-01T10:00:00.000Z'),
    })]);
    expect(provider.parseWebhook(webhook({
      type: 'message_received', data: { customer: { channel_phone_number: '919876543210' }, message: { message: 'STOP' } },
    }))).toEqual([expect.objectContaining({ kind: 'inbound', text: 'STOP' })]);
  });

  it('cannot list templates', async () => {
    expect(provider.canListTemplates).toBe(false);
    await expect(provider.listTemplates()).resolves.toEqual([]);
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

describe('WhatsApp provider requests are time-limited', () => {
  class QuickMeta extends FastMeta { protected readonly requestTimeoutMs = 50; }
  class QuickTwilio extends FastTwilio { protected readonly requestTimeoutMs = 50; }
  class QuickGupshup extends FastGupshup { protected readonly requestTimeoutMs = 50; }
  class QuickInterakt extends FastInterakt { protected readonly requestTimeoutMs = 50; }
  type Quick = QuickMeta | QuickTwilio | QuickGupshup | QuickInterakt;
  const cases: Array<[string, () => Quick, unknown]> = [
    ['Meta', () => new QuickMeta(), metaCreds],
    ['Twilio', () => new QuickTwilio(), twilioCreds],
    ['Gupshup', () => new QuickGupshup(), gupshupCreds],
    ['Interakt', () => new QuickInterakt(), interaktCreds],
  ];

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

  it.each(cases.filter(([name]) => name !== 'Interakt'))(
    '%s: a template list that never answers fails',
    async (_name, make, credentials) => {
      fetchMock.mockImplementation(hangUntilAborted);
      const result = await within(make().listTemplates(credentials));
      expect(result).not.toBe('hung');
      expect(result).toHaveProperty('error');
    },
  );

  /**
   * The checks above hang the first request, so they cannot tell whether a
   * later one in the same call is time-limited too. Here the first answers
   * and only the next one hangs.
   */
  const firstAnswersThenHangs = (first: () => Response) => {
    let calls = 0;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      calls += 1;
      return calls === 1 ? first() : hangUntilAborted(url, init);
    });
  };
  const expectTimedOutOnSecond = (result: Awaited<ReturnType<typeof within>>) => {
    expect(result).not.toBe('hung');
    expect((result as { error: { name?: string } }).error?.name).toBe('TimeoutError');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  };

  it('Meta: a credentials check whose second request (templates) never answers fails', async () => {
    firstAnswersThenHangs(() => json(200, { id: metaCreds.phoneNumberId, display_phone_number: '+91 90000 00000' }));
    expectTimedOutOnSecond(await within(new QuickMeta().validateCredentials(metaCreds)));
  });

  it('Meta: a template list whose next page never answers fails', async () => {
    firstAnswersThenHangs(() =>
      json(200, { data: [], paging: { next: 'https://graph.facebook.com/v21.0/2059545589544/message_templates?after=x' } }),
    );
    expectTimedOutOnSecond(await within(new QuickMeta().listTemplates(metaCreds)));
  });

  it('Twilio: a template list whose next page never answers fails', async () => {
    firstAnswersThenHangs(() =>
      json(200, { contents: [], meta: { next_page_url: 'https://content.twilio.com/v1/ContentAndApprovals?PageSize=500&Page=1' } }),
    );
    expectTimedOutOnSecond(await within(new QuickTwilio().listTemplates(twilioCreds)));
  });

  it('Gupshup: a template list whose next page never answers fails', async () => {
    // A full page (100) is what makes Gupshup ask for the next one.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `uuid-${i}`, elementName: `t${i}`, languageCode: 'en', status: 'APPROVED', category: 'MARKETING', data: 'Hi', templateType: 'TEXT',
    }));
    firstAnswersThenHangs(() => json(200, { status: 'success', templates: fullPage }));
    expectTimedOutOnSecond(await within(new QuickGupshup().listTemplates(gupshupCreds)));
  });
});
