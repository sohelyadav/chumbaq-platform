import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { verifyRazorpaySignature } from './razorpay-signature';

const SECRET = 'test_webhook_secret';
const raw = readFileSync(join(__dirname, '__fixtures__/razorpay/subscription.charged.json'));
const sign = (body: Buffer, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

describe('verifyRazorpaySignature', () => {
  const signature = sign(raw);

  it('accepts the hex HMAC-SHA256 of the raw bytes under the webhook secret', () => {
    expect(verifyRazorpaySignature(raw, signature, SECRET)).toBe(true);
  });

  it('refuses a signature made with another secret', () => {
    expect(verifyRazorpaySignature(raw, sign(raw, 'another_secret'), SECRET)).toBe(false);
  });

  it('refuses a body with one byte changed', () => {
    const changed = Buffer.from(raw);
    changed[changed.length - 3] = changed[changed.length - 3] ^ 0x01;
    expect(verifyRazorpaySignature(changed, signature, SECRET)).toBe(false);
  });

  it('refuses the same JSON serialised again: only the bytes received are signed', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));
    expect(reserialised.equals(raw)).toBe(false);
    expect(verifyRazorpaySignature(reserialised, signature, SECRET)).toBe(false);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['63 hex characters', signature.slice(0, 63)],
    ['65 hex characters', signature + 'a'],
    ['text that is not hex', 'z'.repeat(64)],
    ['63 hex characters and one that is not', signature.slice(0, 63) + 'g'],
    // Buffer.from(…, 'hex') stops at the first non-hex character, so without the
    // format check these would decode to exactly the right digest.
    ['the right digest followed by text that is not hex', signature + 'zz'],
    ['the right digest followed by a space', signature + ' '],
    ['the digest in base64', Buffer.from(signature, 'hex').toString('base64')],
  ])('refuses %s without throwing', (_label, value) => {
    expect(() => verifyRazorpaySignature(raw, value, SECRET)).not.toThrow();
    expect(verifyRazorpaySignature(raw, value, SECRET)).toBe(false);
  });

  it('accepts the right digest in uppercase hex', () => {
    expect(verifyRazorpaySignature(raw, signature.toUpperCase(), SECRET)).toBe(true);
  });

  it('refuses everything when the secret is empty', () => {
    expect(verifyRazorpaySignature(raw, sign(raw, ''), '')).toBe(false);
  });
});
