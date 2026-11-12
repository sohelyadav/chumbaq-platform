import { alertEmail, istAndUtc } from './alert-email';

describe('alert email', () => {
  it('shows a time in IST and UTC, across midnight UTC', () => {
    expect(istAndUtc(new Date('2026-11-11T20:00:00Z'))).toBe('12 Nov 2026, 01:30 IST (20:00 UTC)');
  });

  it('escapes details in the HTML part and names the incidents page', () => {
    const mail = alertEmail({
      kind: 'tripwire.api_key',
      details: { route: '/api/<script>' },
      ip: '203.0.113.9',
      at: new Date('2026-11-11T08:35:00Z'),
      adminAppUrl: 'https://admin.example.com/',
    });
    expect(mail.subject).toBe('Chumbaq security alarm: the trap API key was used');
    expect(mail.html).toContain('/api/&lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain('https://admin.example.com/incidents');
    expect(mail.text).toContain('11 Nov 2026, 14:05 IST (08:35 UTC)');
  });
});
