import { countSegments, DEFAULT_OPT_OUT_TEXT, MAX_SMS_LENGTH, renderSms } from './sms-rendering';

describe('countSegments', () => {
  it('fits 160 GSM characters in one segment', () => {
    expect(countSegments('a'.repeat(160))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
  });

  it('splits at 153 per segment once a message needs more than one', () => {
    expect(countSegments('a'.repeat(161)).segments).toBe(2);
    expect(countSegments('a'.repeat(306)).segments).toBe(2);
    expect(countSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('counts extended GSM characters as two', () => {
    expect(countSegments('€'.repeat(80))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
    expect(countSegments('€'.repeat(81)).segments).toBe(2);
  });

  it('switches the whole message to UCS-2 for one character outside GSM', () => {
    expect(countSegments('a'.repeat(70)).encoding).toBe('GSM-7');
    const curly = `${'a'.repeat(69)}’`;
    expect(countSegments(curly)).toEqual({ encoding: 'UCS-2', units: 70, segments: 1 });
    expect(countSegments(`${curly}b`).segments).toBe(2);
  });

  it('counts an emoji as two UCS-2 units', () => {
    expect(countSegments('🎉').units).toBe(2);
  });

  it('counts Hindi as UCS-2', () => {
    expect(countSegments('नमस्ते').encoding).toBe('UCS-2');
  });
});

describe('renderSms', () => {
  const base = { from: '+14155550100', optOutText: DEFAULT_OPT_OUT_TEXT };

  it('personalises and appends the opt-out line', () => {
    const message = renderSms({ ...base, body: 'Hi {{firstName|there}}, 20% off', identity: { firstName: 'Priya' } });
    expect(message.body).toBe(`Hi Priya, 20% off\n${DEFAULT_OPT_OUT_TEXT}`);
  });

  it('tidies a vanished token without joining the lines', () => {
    const message = renderSms({ ...base, optOutText: null, body: 'Hi {{firstName}}, sale\nToday only', identity: {} });
    expect(message.body).toBe('Hi, sale\nToday only');
  });

  it('does not repeat an opt-out line the body already has', () => {
    const message = renderSms({ ...base, body: 'Sale. reply stop to opt out.', identity: null });
    expect(message.body).toBe('Sale. reply stop to opt out.');
  });

  it('strips control characters a trait smuggles in', () => {
    const message = renderSms({ ...base, optOutText: null, body: 'Hi {{firstName}}', identity: { firstName: 'A\u0000\u001bB' } });
    expect(message.body).toBe('Hi A B');
  });

  it('never hands the provider more than it accepts', () => {
    const message = renderSms({ ...base, body: 'x'.repeat(MAX_SMS_LENGTH), identity: null });
    expect(message.body.length).toBe(MAX_SMS_LENGTH);
  });

  it('carries the status callback through', () => {
    const message = renderSms({ ...base, body: 'Hi', identity: null, statusCallback: 'https://x/s' });
    expect(message.statusCallback).toBe('https://x/s');
  });
});
