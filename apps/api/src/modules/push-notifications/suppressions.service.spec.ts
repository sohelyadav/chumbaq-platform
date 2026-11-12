import { consentSourceOfSuppression } from './suppressions.service';

/**
 * Which suppressions are someone saying no. The writes themselves are proved
 * against Postgres in `consent/consent.int-spec.ts`.
 */
describe('consentSourceOfSuppression', () => {
  it.each([
    ['email', 'unsubscribed', 'link', 'unsubscribe_link'],
    ['email', 'unsubscribed', 'resend', 'provider_unsubscribe'],
    ['email', 'complained', 'ses', 'complaint'],
    ['sms', 'unsubscribed', 'twilio', 'stop_reply'],
    ['whatsapp', 'unsubscribed', 'meta', 'stop_reply'],
    ['email', 'manual', 'dashboard', 'dashboard'],
    ['sms', 'unsubscribed', 'dashboard', 'dashboard'],
  ] as const)('%s %s from %s is %s', (channel, reason, source, expected) => {
    expect(consentSourceOfSuppression(channel, reason, source)).toBe(expected);
  });

  it('records an unsigned (Brevo) email unsubscribe or complaint as unconfirmed', () => {
    expect(consentSourceOfSuppression('email', 'unsubscribed', 'brevo', false)).toBe('provider_unsubscribe_unsigned');
    expect(consentSourceOfSuppression('email', 'complained', 'brevo', false)).toBe('complaint_unsigned');
    expect(consentSourceOfSuppression('email', 'complained', 'ses', true)).toBe('complaint');
  });

  it('records a STOP from an unsigned webhook as unverified', () => {
    expect(consentSourceOfSuppression('whatsapp', 'unsubscribed', 'gupshup', false)).toBe('stop_reply_unsigned');
    expect(consentSourceOfSuppression('whatsapp', 'unsubscribed', 'gupshup', true)).toBe('stop_reply');
  });

  it.each([
    ['email', 'bounced', 'ses'],
    ['sms', 'bounced', 'twilio'],
    ['whatsapp', 'bounced', 'gupshup'],
    // A bounce entered by hand in the dashboard is still a bounce.
    ['sms', 'bounced', 'dashboard'],
  ] as const)('a %s %s from %s is not consent: the address does not work', (channel, reason, source) => {
    expect(consentSourceOfSuppression(channel, reason, source)).toBeNull();
  });

  it('never applies to push, whose consent is push_opt_in', () => {
    expect(consentSourceOfSuppression('push', 'unsubscribed', 'dashboard')).toBeNull();
  });
});
