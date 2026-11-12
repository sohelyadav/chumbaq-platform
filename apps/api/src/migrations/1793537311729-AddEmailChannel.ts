import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailChannel1793537311729 implements MigrationInterface {
    name = 'AddEmailChannel1793537311729'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "email_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "provider" character varying(20), "from_email" character varying(320) NOT NULL, "from_name" character varying(100), "reply_to" character varying(320), "postal_address" text NOT NULL, "require_opt_in" boolean NOT NULL DEFAULT true, "webhook_token" character varying(64) NOT NULL, "ses_topic_arn" character varying(256), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d363efbb6aa1c747440c0ec24f4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e0ad656a8634dd1789f9949659" ON "email_settings" ("webhook_token") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b3da77292216cd4308188d6b0c" ON "email_settings" ("project_id") `);
        await queryRunner.query(`CREATE TABLE "channel_suppressions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "channel" character varying(10) NOT NULL, "address" character varying(320) NOT NULL, "reason" character varying(20) NOT NULL, "source" character varying(20) NOT NULL, "detail" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0e3715e476abeb600122012658f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_556cf71c65aa71f7e902a4cddb" ON "channel_suppressions" ("project_id", "channel", "address") `);
        await queryRunner.query(`ALTER TABLE "device_identities" ADD "email" character varying(320)`);
        // Backfill from the traits apps were already sending, with the same
        // normalisation and the same looseness as normaliseEmail(), so people
        // identified before this release are reachable without a new identify.
        await queryRunner.query(`
            UPDATE "device_identities"
            SET "email" = candidate.address
            FROM (
                SELECT id, lower(btrim(COALESCE(traits->>'$email', traits->>'email'))) AS address
                FROM "device_identities"
                WHERE traits ? '$email' OR traits ? 'email'
            ) AS candidate
            WHERE "device_identities".id = candidate.id
              AND length(candidate.address) BETWEEN 3 AND 320
              AND candidate.address ~ '^[^[:space:]@<>()",;]+@[^[:space:]@<>()",;]+\\.[^[:space:]@<>()",;]+$'
        `);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "channel" character varying(10) NOT NULL DEFAULT 'push'`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "email_content" jsonb`);
        await queryRunner.query(`CREATE INDEX "IDX_fea131c4451b26feba9c83f16c" ON "device_identities" ("project_id", "email") WHERE "email" IS NOT NULL`);
        await queryRunner.query(`ALTER TABLE "email_settings" ADD CONSTRAINT "FK_b3da77292216cd4308188d6b0c8" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "channel_suppressions" ADD CONSTRAINT "FK_3bbe1ea88cc1f1f0612dc232c57" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channel_suppressions" DROP CONSTRAINT "FK_3bbe1ea88cc1f1f0612dc232c57"`);
        await queryRunner.query(`ALTER TABLE "email_settings" DROP CONSTRAINT "FK_b3da77292216cd4308188d6b0c8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fea131c4451b26feba9c83f16c"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "email_content"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "channel"`);
        await queryRunner.query(`ALTER TABLE "device_identities" DROP COLUMN "email"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_556cf71c65aa71f7e902a4cddb"`);
        await queryRunner.query(`DROP TABLE "channel_suppressions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b3da77292216cd4308188d6b0c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e0ad656a8634dd1789f9949659"`);
        await queryRunner.query(`DROP TABLE "email_settings"`);
    }

}
