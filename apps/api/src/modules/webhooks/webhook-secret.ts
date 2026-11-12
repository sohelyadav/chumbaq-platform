import * as crypto from 'crypto';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';

/**
 * How a webhook signing secret is kept at rest.
 *
 * One string in the existing `secret` column rather than three columns, so the
 * dev schema (built by synchronize) changes without dropping the column that
 * holds today's secrets. The prefix names the format, so a plaintext value left
 * behind by a database that skipped the migration is recognised and refused
 * rather than used as if it were ciphertext, or as a key.
 */
const SEALED_PREFIX = 'v1.';

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function isSealedWebhookSecret(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

export function sealWebhookSecret(cryptoService: CredentialsCryptoService, secret: string): string {
  const { ciphertext, iv, tag } = cryptoService.encrypt(secret);
  return `${SEALED_PREFIX}${iv}.${tag}.${ciphertext}`;
}

export function openWebhookSecret(cryptoService: CredentialsCryptoService, stored: string): string {
  if (!isSealedWebhookSecret(stored)) {
    throw new Error('Webhook secret is stored unencrypted; run the migrations or rotate it');
  }
  const [iv, tag, ciphertext] = stored.slice(SEALED_PREFIX.length).split('.');
  if (!iv || !tag || !ciphertext) throw new Error('Webhook secret is malformed');
  return cryptoService.decrypt(ciphertext, iv, tag);
}

/** Enough to tell two secrets apart in the dashboard, and far too little to sign with. */
export function webhookSecretHint(secret: string): string {
  return secret.slice(-4);
}
