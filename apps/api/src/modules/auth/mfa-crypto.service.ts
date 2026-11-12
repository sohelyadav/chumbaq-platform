import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** In every ciphertext, so a later key can sit beside this one during a rotation. */
const KEY_VERSION = 'v1';
const IV_BYTES = 12;
const NOT_AVAILABLE = 'Two-factor sign-in is not available right now.';

/**
 * What protects TOTP secrets and recovery codes at rest. A database copy alone yields no
 * secret, and no recovery code can be tested against a stolen hash without this key.
 */
@Injectable()
export class MfaCryptoService {
  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.config.get<string>('mfa.encryptionKey'));
  }

  /** One key for each purpose, so neither use can be turned against the other. */
  private subkey(purpose: string): Buffer {
    const raw = this.config.get<string>('mfa.encryptionKey');
    if (!raw) throw new ServiceUnavailableException(NOT_AVAILABLE);
    return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'base64'), '', `chumbaq-mfa:${purpose}`, 32));
  }

  /** The account is authenticated data, so a row copied onto another account will not open. */
  encrypt(userId: string, plaintext: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.subkey('totp-secret'), iv);
    cipher.setAAD(Buffer.from(userId));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [KEY_VERSION, iv, cipher.getAuthTag(), body]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  /**
   * Throws, rather than answering as a wrong code would: a changed key is an outage,
   * and must not count against the person or look like their mistake.
   */
  decrypt(userId: string, stored: string): Buffer {
    const [version, iv, tag, body] = stored.split('.');
    if (version !== KEY_VERSION) throw new ServiceUnavailableException(NOT_AVAILABLE);
    const key = this.subkey('totp-secret');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(userId));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
    } catch {
      throw new ServiceUnavailableException(NOT_AVAILABLE);
    }
  }

  /** Includes the account, so one user's hash says nothing about another's. */
  hashRecoveryCode(userId: string, normalisedCode: string): string {
    return createHmac('sha256', this.subkey('recovery-code'))
      .update(`${userId}:${normalisedCode}`)
      .digest('hex');
  }
}
