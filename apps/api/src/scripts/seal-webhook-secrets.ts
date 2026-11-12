import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import dataSource from '../data-source';
import { CredentialsCryptoService } from '../common/credentials-crypto.service';
import {
  isSealedWebhookSecret,
  sealWebhookSecret,
  webhookSecretHint,
} from '../modules/webhooks/webhook-secret';

/**
 * Encrypts webhook secrets still stored in plaintext, keeping their values.
 *
 *   npm run webhooks:seal-secrets
 *
 * For dev databases: they are built by synchronize and never run
 * EncryptWebhookSecrets1793950000000, so webhooks created before it stay in
 * plaintext and are refused at send time. Safe to run again: sealed rows are
 * left alone. Anywhere migrations run, the migration has already done this.
 */
export async function sealPlaintextWebhookSecrets(
  ds: DataSource,
  credentialsCrypto: CredentialsCryptoService,
): Promise<number> {
  return ds.transaction(async (manager) => {
    const rows: { id: string; secret: string }[] = await manager.query(
      `SELECT id, secret FROM webhooks FOR UPDATE`,
    );
    const plaintext = rows.filter((row) => !isSealedWebhookSecret(row.secret));
    for (const row of plaintext) {
      await manager.query(`UPDATE webhooks SET secret = $1, secret_hint = $2 WHERE id = $3`, [
        sealWebhookSecret(credentialsCrypto, row.secret),
        webhookSecretHint(row.secret),
        row.id,
      ]);
    }
    return plaintext.length;
  });
}

async function main(): Promise<void> {
  const credentialsCrypto = new CredentialsCryptoService({
    get: (key: string) => process.env[key],
  } as unknown as ConfigService);
  await dataSource.initialize();
  try {
    const sealed = await sealPlaintextWebhookSecrets(dataSource, credentialsCrypto);
    console.log(`Encrypted ${sealed} webhook secret(s).`);
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  });
}
