import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CredentialsCryptoService } from './credentials-crypto.service';

const KEY = 'a1'.repeat(32);

describe('CredentialsCryptoService', () => {
  const buildService = async (
    configGet: (key: string) => string | undefined,
  ): Promise<CredentialsCryptoService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialsCryptoService,
        { provide: ConfigService, useValue: { get: jest.fn(configGet) } },
      ],
    }).compile();
    return module.get<CredentialsCryptoService>(CredentialsCryptoService);
  };
  const withKey = (keyHex: string | undefined, extra: Record<string, string> = {}) =>
    buildService((key) => (key === 'CREDENTIALS_ENCRYPTION_KEY' ? keyHex : extra[key]));

  describe('the key', () => {
    it.each([
      ['missing', undefined],
      ['too short', 'too-short'],
      ['not hex', 'z'.repeat(64)],
      ['one byte short', 'a'.repeat(62)],
    ])('refuses to start when it is %s, even with a JWT secret to fall back on', async (_case, keyHex) => {
      await expect(withKey(keyHex, { 'jwt.secret': 'x'.repeat(40) })).rejects.toThrow(
        /CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters/,
      );
    });

    it('does not depend on the JWT secret', async () => {
      const a = await withKey(KEY, { 'jwt.secret': 'one-secret-'.repeat(4) });
      const b = await withKey(KEY, { 'jwt.secret': 'another-secret-'.repeat(4) });
      const sealed = a.encrypt('credential');
      expect(b.decrypt(sealed.ciphertext, sealed.iv, sealed.tag)).toBe('credential');
    });

    it('accepts upper-case hex', async () => {
      const service = await withKey(KEY.toUpperCase());
      const { ciphertext, iv, tag } = service.encrypt('abc');
      expect(service.decrypt(ciphertext, iv, tag)).toBe('abc');
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips a plaintext string', async () => {
      const service = await withKey(KEY);
      const { ciphertext, iv, tag } = service.encrypt('hello world');
      expect(ciphertext).not.toBe('hello world');
      expect(service.decrypt(ciphertext, iv, tag)).toBe('hello world');
    });

    it('cannot be read under another key', async () => {
      const sealed = (await withKey(KEY)).encrypt('secret');
      const other = await withKey('b2'.repeat(32));
      expect(() => other.decrypt(sealed.ciphertext, sealed.iv, sealed.tag)).toThrow();
    });

    it('produces different ciphertexts for the same plaintext (IV is random)', async () => {
      const service = await withKey(KEY);
      const a = service.encrypt('same');
      const b = service.encrypt('same');
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it('throws when the tag is tampered with', async () => {
      const service = await withKey(KEY);
      const { ciphertext, iv, tag } = service.encrypt('abc');
      const badTag = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
      expect(() => service.decrypt(ciphertext, iv, badTag)).toThrow();
    });

    it('throws when the ciphertext is tampered with', async () => {
      const service = await withKey(KEY);
      const { ciphertext, iv, tag } = service.encrypt('abc');
      const bad = (ciphertext[0] === '0' ? '1' : '0') + ciphertext.slice(1);
      expect(() => service.decrypt(bad, iv, tag)).toThrow();
    });
  });
});
