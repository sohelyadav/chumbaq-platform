import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSmsChannel1793550709508 implements MigrationInterface {
    name = 'AddSmsChannel1793550709508'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sms_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "provider" character varying(20), "sender" character varying(40) NOT NULL, "require_opt_in" boolean NOT NULL DEFAULT true, "opt_out_text" character varying(80), "webhook_token" character varying(64) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e5605e84770b6192b0c4b69d186" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f3582cb7044c616aff2787a39f" ON "sms_settings" ("webhook_token") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8d7c89e493d690951d85033338" ON "sms_settings" ("project_id") `);
        await queryRunner.query(`ALTER TABLE "device_identities" ADD "phone_e164" character varying(16)`);
        // Backfill from what apps already report, with the rule
        // normalisePhone applies: drop formatting, read a leading 00 as +, and
        // keep only numbers that carry a country code. The first candidate
        // that qualifies wins, in the same order identify uses.
        await queryRunner.query(`
            WITH candidates AS (
                SELECT id, regexp_replace(
                         regexp_replace(c.value, '[[:space:]().-]', '', 'g'),
                         '^00', '+'
                       ) AS number, c.ord
                FROM "device_identities",
                     LATERAL (VALUES (phone, 1), (traits->>'$phone', 2), (traits->>'phone', 3))
                       AS c(value, ord)
                WHERE c.value IS NOT NULL
            ), best AS (
                SELECT DISTINCT ON (id) id, number
                FROM candidates
                WHERE number ~ '^\\+[1-9][0-9]{7,14}$'
                ORDER BY id, ord
            )
            UPDATE "device_identities" d
            SET "phone_e164" = best.number
            FROM best
            WHERE d.id = best.id
        `);
        await queryRunner.query(`CREATE INDEX "IDX_cf6e72d7d713df572e32590464" ON "device_identities" ("project_id", "phone_e164") WHERE "phone_e164" IS NOT NULL`);
        await queryRunner.query(`ALTER TABLE "sms_settings" ADD CONSTRAINT "FK_8d7c89e493d690951d850333388" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sms_settings" DROP CONSTRAINT "FK_8d7c89e493d690951d850333388"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cf6e72d7d713df572e32590464"`);
        await queryRunner.query(`ALTER TABLE "device_identities" DROP COLUMN "phone_e164"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d7c89e493d690951d85033338"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f3582cb7044c616aff2787a39f"`);
        await queryRunner.query(`DROP TABLE "sms_settings"`);
    }

}
