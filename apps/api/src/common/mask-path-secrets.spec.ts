import { maskPathSecrets } from './mask-path-secrets';

describe('maskPathSecrets', () => {
  it('masks a webhook token in the path', () => {
    const token = 'a'.repeat(48);
    expect(maskPathSecrets(`/api/email/webhooks/brevo/${token}`)).toBe('/api/email/webhooks/brevo/[masked]');
    expect(maskPathSecrets(`/api/sms/webhooks/twilio/${token}/status`)).toBe('/api/sms/webhooks/twilio/[masked]/status');
  });

  it('leaves uuids and ordinary segments alone', () => {
    const path = '/api/projects/0b6f2b1e-3c1a-4b8e-9d2f-1a2b3c4d5e6f/links';
    expect(maskPathSecrets(path)).toBe(path);
    expect(maskPathSecrets('/abc123')).toBe('/abc123');
  });
});
