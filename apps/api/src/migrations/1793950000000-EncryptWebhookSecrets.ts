import { MigrationInterface, QueryRunner } from "typeorm";
import * as crypto from "crypto";

/**
 * Encrypts webhook signing secrets in place and records a hint and a rotation date.
 *
 * The secret stays in the same column so existing webhooks keep signing with the
 * secret their receivers already hold. The key is only required when there are rows
 * to convert, so an empty database migrates without one.
 *
 * The `v1.` envelope and AES-256-GCM are written out here rather than imported
 * from webhook-secret.ts and CredentialsCryptoService: a migration must do
 * tomorrow what it did the day it shipped, whatever those files become. The
 * integration test opens what this writes with the app's own code.
 */
const PREFIX = 'v1.';

function key(): Buffer {
    const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 64 hex characters to encrypt existing webhook secrets');
    }
    return Buffer.from(hex, 'hex');
}

function seal(secret: string, k: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ciphertext = cipher.update(secret, 'utf8', 'hex') + cipher.final('hex');
    return `${PREFIX}${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext}`;
}

function open(stored: string, k: Buffer): string {
    const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split('.');
    if (!iv || !tag || !ciphertext) throw new Error('Webhook secret is malformed');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return decipher.update(ciphertext, 'hex', 'utf8') + decipher.final('utf8');
}

export class EncryptWebhookSecrets1793950000000 implements MigrationInterface {
    name = 'EncryptWebhookSecrets1793950000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "webhooks" ADD "secret_hint" character varying(4)`);
        await queryRunner.query(`ALTER TABLE "webhooks" ADD "secret_rotated_at" TIMESTAMP WITH TIME ZONE`);

        const rows: { id: string; secret: string }[] = await queryRunner.query(`SELECT "id", "secret" FROM "webhooks"`);
        const plaintext = rows.filter((row) => !row.secret.startsWith(PREFIX));
        if (plaintext.length === 0) return;

        const k = key();
        for (const row of plaintext) {
            await queryRunner.query(
                `UPDATE "webhooks" SET "secret" = $1, "secret_hint" = $2 WHERE "id" = $3`,
                [seal(row.secret, k), row.secret.slice(-4), row.id],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: { id: string; secret: string }[] = await queryRunner.query(`SELECT "id", "secret" FROM "webhooks"`);
        const sealed = rows.filter((row) => row.secret.startsWith(PREFIX));
        if (sealed.length > 0) {
            const k = key();
            for (const row of sealed) {
                await queryRunner.query(
                    `UPDATE "webhooks" SET "secret" = $1 WHERE "id" = $2`,
                    [open(row.secret, k), row.id],
                );
            }
        }
        await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "secret_rotated_at"`);
        await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "secret_hint"`);
    }
}
