import {
  factorResetCancelledEmail,
  factorResetRequestedEmail,
  factorsResetEmail,
} from './account-emails';

const user = { email: 'owner@example.com', name: '<img src=x onerror=alert(1)>' };
const SETTINGS = 'https://app.example.com/settings';

describe('factor reset emails', () => {
  const at = new Date('2026-11-09T14:30:00Z');
  const requested = factorResetRequestedEmail(user, at, SETTINGS);

  it('says when the reset happens, in UTC, and both ways to stop it', () => {
    for (const part of [requested.text, requested.html]) {
      expect(part).toContain('Mon, 09 Nov 2026 14:30:00 UTC');
      expect(part).toContain('signing in with it cancels this');
      expect(part).toContain('cancel it from your account settings');
      expect(part).toContain(SETTINGS);
    }
    expect(requested.to).toBe(user.email);
  });

  it.each([
    ['requested', requested],
    ['cancelled', factorResetCancelledEmail(user, SETTINGS)],
    ['completed', factorsResetEmail(user, SETTINGS)],
  ])('escapes the name in the %s email', (_, email) => {
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
