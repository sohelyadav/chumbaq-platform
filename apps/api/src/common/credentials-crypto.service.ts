import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

@Injectable()
export class CredentialsCryptoService {
  private readonly encryptionKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    // Required, with no fallback. It once fell back to a hash of JWT_SECRET, which tied
    // every stored provider credential to the token key: rotating that after a leak would
    // have made them all unreadable, and a leak of it would have exposed them.
    const keyHex = this.configService.get<string>('CREDENTIALS_ENCRYPTION_KEY');
    if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) {
      throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters: openssl rand -hex 32');
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');
  }

  /**
   * A key for some other purpose, derived from the encryption key.
   *
   * HKDF with the purpose as `info`, so a signature made for one use (an
   * unsubscribe link) can never be replayed as another, and none of them
   * reveal anything about the key that protects stored credentials.
   */
  deriveKey(purpose: string): Buffer {
    return Buffer.from(
      crypto.hkdfSync('sha256', this.encryptionKey, Buffer.alloc(0), purpose, KEY_LENGTH),
    );
  }

  encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  decrypt(ciphertext: string, ivHex: string, tagHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
