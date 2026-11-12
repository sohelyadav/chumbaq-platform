import { createHash } from 'crypto';
import {
  INVITE_GONE,
  INVITE_TTL_MS,
  hashInviteToken,
  maskEmail,
  newInviteToken,
  wrongAccountMessage,
} from './invitations.service';

describe('maskEmail', () => {
  it.each([
    ['sam@x.com', 's***@x.com'],
    ['a@x.com', '*@x.com'],
    ['samantha.jones@mail.example.co.uk', 's***@mail.example.co.uk'],
    ['Sam@X.com', 's***@x.com'],
  ])('%s → %s', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it('keeps the domain whole and never the rest of the local part', () => {
    const masked = maskEmail('secret-name@example.com');
    expect(masked).toBe('s***@example.com');
    expect(masked).not.toContain('ecret');
  });
});

describe('wrongAccountMessage', () => {
  it('names the masked address the invite was sent to', () => {
    expect(wrongAccountMessage('sam@x.com')).toBe(
      'This invite was sent to s***@x.com. Sign in with that address to accept it.',
    );
  });
});

describe('invite tokens', () => {
  it('are 32 random bytes in base64url, stored as their sha256 in hex', () => {
    const token = newInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newInviteToken()).not.toBe(token);
    expect(hashInviteToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('last 7 days', () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('share one generic refusal', () => {
    expect(INVITE_GONE).toBe('This invite has expired or was already used.');
  });
});
