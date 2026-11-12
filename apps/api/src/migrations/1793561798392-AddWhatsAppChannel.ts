import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhatsAppChannel1793561798392 implements MigrationInterface {
    name = 'AddWhatsAppChannel1793561798392'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "whatsapp_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "provider" character varying(20), "require_opt_in" boolean NOT NULL DEFAULT true, "webhook_token" character varying(64) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_00e5f8bfb4a76d885d2bc3cd526" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_00e47ae9a1be924723d155ca0a" ON "whatsapp_settings" ("webhook_token") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e28dbc14f6ee1c6c7a767123c2" ON "whatsapp_settings" ("project_id") `);
        await queryRunner.query(`ALTER TABLE "device_identities" ADD "whatsapp_opt_in" boolean`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "whatsapp_content" jsonb`);
        await queryRunner.query(`ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "FK_e28dbc14f6ee1c6c7a767123c22" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "whatsapp_settings" DROP CONSTRAINT "FK_e28dbc14f6ee1c6c7a767123c22"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "whatsapp_content"`);
        await queryRunner.query(`ALTER TABLE "device_identities" DROP COLUMN "whatsapp_opt_in"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e28dbc14f6ee1c6c7a767123c2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_00e47ae9a1be924723d155ca0a"`);
        await queryRunner.query(`DROP TABLE "whatsapp_settings"`);
    }

}
