import { HIDDEN_DURING_IMPERSONATION, redactForImpersonator } from './impersonation-redaction';

describe('redactForImpersonator', () => {
  const body = {
    configured: true,
    verifyToken: 'tok-secret',
    webhookUrls: { meta: 'https://x/meta/tok-secret', twilio: 'https://x/twilio/tok-secret' },
    inboundWebhookUrl: null,
  };

  it('returns the same body for the tenant themselves', () => {
    expect(redactForImpersonator(body, undefined, ['verifyToken', 'webhookUrls'])).toBe(body);
  });

  it('hides strings and every value of an object, keeping the shape', () => {
    const result = redactForImpersonator(body, 'admin-1', ['verifyToken', 'webhookUrls']);
    expect(JSON.stringify(result)).not.toContain('tok-secret');
    expect(result.verifyToken).toBe(HIDDEN_DURING_IMPERSONATION);
    expect(Object.keys(result.webhookUrls)).toEqual(['meta', 'twilio']);
    expect(result.configured).toBe(true);
  });

  it('leaves an absent value absent rather than inventing one, and does not mutate', () => {
    const result = redactForImpersonator(body, 'admin-1', ['inboundWebhookUrl', 'missing']);
    expect(result.inboundWebhookUrl).toBeNull();
    expect('missing' in result).toBe(false);
    expect(body.verifyToken).toBe('tok-secret');
  });
});
