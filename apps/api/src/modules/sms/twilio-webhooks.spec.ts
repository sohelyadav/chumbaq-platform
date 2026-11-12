import { createHmac } from 'crypto';
import {
  parseInboundKeyword,
  parseTwilioStatus,
  verifyTwilioSignature,
} from './twilio-webhooks';

describe('verifyTwilioSignature', () => {
  // Twilio's own worked example from its webhook security documentation.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+12349013030',
    Digits: '1234',
    From: '+12349013030',
    To: '+18005551212',
  };

  it("accepts Twilio's documented example", () => {
    expect(verifyTwilioSignature('12345', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(true);
  });

  it('refuses a changed parameter', () => {
    expect(
      verifyTwilioSignature('12345', url, { ...params, To: '+18005550000' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='),
    ).toBe(false);
  });

  it('refuses a changed query string, which carries the campaign and person', () => {
    expect(
      verifyTwilioSignature('12345', url.replace('foo=1', 'foo=2'), params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='),
    ).toBe(false);
  });

  it('refuses the wrong auth token, and a missing signature', () => {
    expect(verifyTwilioSignature('54321', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false);
    expect(verifyTwilioSignature('12345', url, params, undefined)).toBe(false);
  });

  it('signs repeated parameters value by value, sorted', () => {
    const signed = `${url}Ka${'Kb'}`;
    const signature = createHmac('sha1', 't').update(signed).digest('base64');
    expect(verifyTwilioSignature('t', url, { K: ['b', 'a'] }, signature)).toBe(true);
  });
});

describe('parseTwilioStatus', () => {
  const c = '11111111-1111-4111-8111-111111111111';
  const i = '22222222-2222-4222-8222-222222222222';
  const now = new Date('2026-11-01T00:00:00Z');

  it('reads a delivery with the campaign and person from the query', () => {
    expect(parseTwilioStatus({ To: '+14155550000', MessageStatus: 'delivered' }, { c, i }, now)).toEqual({
      type: 'delivered',
      address: '+14155550000',
      campaignId: c,
      identityId: i,
      occurredAt: now,
    });
  });

  it('ignores progress states', () => {
    for (const MessageStatus of ['queued', 'sending', 'sent', 'accepted']) {
      expect(parseTwilioStatus({ To: '+14155550000', MessageStatus }, { c, i })).toBeNull();
    }
  });

  it('treats an unknown or landline number as a permanent bounce', () => {
    for (const ErrorCode of ['30005', '30006', '21614']) {
      expect(
        parseTwilioStatus({ To: '+14155550000', MessageStatus: 'undelivered', ErrorCode }, {}),
      ).toMatchObject({ type: 'bounced', permanent: true });
    }
  });

  it('treats a phone that was off or a filtered message as temporary', () => {
    for (const ErrorCode of ['30003', '30007']) {
      expect(
        parseTwilioStatus({ To: '+14155550000', MessageStatus: 'undelivered', ErrorCode }, {}),
      ).toMatchObject({ type: 'bounced', permanent: false });
    }
  });

  it('reads 21610 as an unsubscribe', () => {
    expect(
      parseTwilioStatus({ To: '+14155550000', MessageStatus: 'failed', ErrorCode: '21610' }, {}),
    ).toMatchObject({ type: 'unsubscribed', address: '+14155550000' });
  });

  it('drops ids that are not UUIDs', () => {
    expect(
      parseTwilioStatus({ To: '+14155550000', MessageStatus: 'delivered' }, { c: "x' OR 1=1", i: ['a'] }),
    ).toMatchObject({ campaignId: null, identityId: null });
  });
});

describe('parseInboundKeyword', () => {
  it.each(['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'cancel', 'End', 'quit', 'STOPALL'])(
    'reads %p as an opt-out',
    (Body) => {
      expect(parseInboundKeyword({ From: '+14155550000', Body })).toEqual({
        action: 'opt_out',
        address: '+14155550000',
      });
    },
  );

  it.each(['START', 'yes', 'Unstop'])('reads %p as an opt-in', (Body) => {
    expect(parseInboundKeyword({ From: '+14155550000', Body })?.action).toBe('opt_in');
  });

  it('ignores a message that only mentions stopping', () => {
    expect(parseInboundKeyword({ From: '+14155550000', Body: 'please stop sending these' })).toBeNull();
  });

  it('ignores a sender that is not a phone number', () => {
    expect(parseInboundKeyword({ From: 'whatsapp:abc', Body: 'STOP' })).toBeNull();
  });
});
