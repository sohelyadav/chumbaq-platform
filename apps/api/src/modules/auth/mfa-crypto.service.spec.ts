import { randomBytes } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MfaCryptoService } from './mfa-crypto.service';

const serviceWith = (key: string | null) =>
  new MfaCryptoService({ get: () => key } as unknown as ConfigService);
const KEY = randomBytes(32).toString('base64');
const SECRET = Buffer.from('12345678901234567890');

describe('MfaCryptoService', () => {
  const service = serviceWith(KEY);

  it('opens what it sealed, and the secret is not in what is stored', () => {
    const stored = service.encrypt('user-1', SECRET);
    expect(service.decrypt('user-1', stored).equals(SECRET)).toBe(true);
    expect(stored).not.toContain(SECRET.toString('base64url'));
    expect(stored.startsWith('v1.')).toBe(true);
  });

  it('uses a new IV each time', () => {
    expect(service.encrypt('user-1', SECRET)).not.toBe(service.encrypt('user-1', SECRET));
  });

  it('will not open a row copied onto another account', () => {
    const stored = service.encrypt('user-1', SECRET);
    expect(() => service.decrypt('user-2', stored)).toThrow(ServiceUnavailableException);
  });

  it('will not open under another key', () => {
    const stored = service.encrypt('user-1', SECRET);
    const other = serviceWith(randomBytes(32).toString('base64'));
    expect(() => other.decrypt('user-1', stored)).toThrow(ServiceUnavailableException);
  });

  it('will not open a tampered row or an unknown key version', () => {
    const [version, iv, tag, body] = service.encrypt('user-1', SECRET).split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 1;
    const tampered = [version, iv, tag, flipped.toString('base64url')].join('.');
    expect(() => service.decrypt('user-1', tampered)).toThrow(ServiceUnavailableException);
    expect(() => service.decrypt('user-1', ['v9', iv, tag, body].join('.'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('hashes a code differently per account and per key', () => {
    const hash = service.hashRecoveryCode('user-1', 'abcd');
    expect(service.hashRecoveryCode('user-1', 'abcd')).toBe(hash);
    expect(service.hashRecoveryCode('user-2', 'abcd')).not.toBe(hash);
    expect(serviceWith(randomBytes(32).toString('base64')).hashRecoveryCode('user-1', 'abcd')).not.toBe(hash);
  });

  it('refuses everything with no key, and says it has none', () => {
    const none = serviceWith(null);
    expect(none.isConfigured).toBe(false);
    expect(() => none.encrypt('user-1', SECRET)).toThrow(ServiceUnavailableException);
    expect(() => none.hashRecoveryCode('user-1', 'abcd')).toThrow(ServiceUnavailableException);
  });
});
