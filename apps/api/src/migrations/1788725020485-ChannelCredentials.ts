import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Moves channel credentials out of push_configs into a row per provider.
 *
 * A column trio per vendor does not scale — five vendors is fifteen columns,
 * and every channel added rewrites the entity. push_configs keeps the sending
 * policy that applies across all channels.
 *
 * Reverting loses credentials for any provider other than FCM: the old schema
 * has nowhere to put them. Stated here rather than discovered.
 */
export class ChannelCredentials1788725020485 implements MigrationInterface {
    name = 'ChannelCredentials1788725020485'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "push_channel_credentials" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "provider" character varying(20) NOT NULL, "credentials_encrypted" text NOT NULL, "credentials_iv" character varying(32) NOT NULL, "credentials_tag" character varying(32) NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0ffb83ac6e3cb986a56dc0ac194" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5f5033e25e64b2333197b3b97d" ON "push_channel_credentials" ("project_id", "provider") `);
        // Carry existing FCM credentials over before the columns holding them
        // go away. A project whose credentials vanish stops sending entirely,
        // so this runs in the same transaction as the drop: either both happen
        // or neither does.
        await queryRunner.query(`
            INSERT INTO "push_channel_credentials"
                ("project_id", "provider", "credentials_encrypted",
                 "credentials_iv", "credentials_tag", "is_active")
            SELECT "project_id", 'fcm', "fcm_credentials_encrypted",
                   "fcm_credentials_iv", "fcm_credentials_tag", "is_active"
            FROM "push_configs"
        `);

        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "fcm_credentials_encrypted"`);
        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "fcm_credentials_iv"`);
        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "fcm_credentials_tag"`);
        await queryRunner.query(`ALTER TABLE "push_channel_credentials" ADD CONSTRAINT "FK_5bfd05f2983a20170e4c29cb62e" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_channel_credentials" DROP CONSTRAINT "FK_5bfd05f2983a20170e4c29cb62e"`);
        // The original columns were NOT NULL, so every push_configs row needs an
        // FCM credential to go back to. A project configured only for a vendor
        // channel has none — there is nothing truthful to put there, and both
        // alternatives are worse than stopping: inventing a value would store a
        // credential that cannot decrypt, and deleting the row would throw away
        // the project's sending policy. So this refuses instead.
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM "push_configs" c
                    WHERE NOT EXISTS (
                        SELECT 1 FROM "push_channel_credentials" cc
                        WHERE cc."project_id" = c."project_id"
                          AND cc."provider" = 'fcm'
                    )
                ) THEN
                    RAISE EXCEPTION
                        'Cannot revert: push_configs rows exist with no FCM credential to restore. Configure FCM for those projects, or drop them, before reverting.';
                END IF;
            END $$;
        `);

        // Added nullable, filled, then constrained — adding NOT NULL outright
        // fails the moment the table has any rows.
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "fcm_credentials_encrypted" text`);
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "fcm_credentials_iv" character varying(32)`);
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "fcm_credentials_tag" character varying(32)`);

        await queryRunner.query(`
            UPDATE "push_configs" c
            SET "fcm_credentials_encrypted" = cc."credentials_encrypted",
                "fcm_credentials_iv"        = cc."credentials_iv",
                "fcm_credentials_tag"       = cc."credentials_tag"
            FROM "push_channel_credentials" cc
            WHERE cc."project_id" = c."project_id" AND cc."provider" = 'fcm'
        `);

        await queryRunner.query(`ALTER TABLE "push_configs" ALTER COLUMN "fcm_credentials_encrypted" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "push_configs" ALTER COLUMN "fcm_credentials_iv" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "push_configs" ALTER COLUMN "fcm_credentials_tag" SET NOT NULL`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5f5033e25e64b2333197b3b97d"`);
        await queryRunner.query(`DROP TABLE "push_channel_credentials"`);
    }

}
