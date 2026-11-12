import { MigrationInterface, QueryRunner } from "typeorm";

export class PushNotificationEvents1788703281288 implements MigrationInterface {
    name = 'PushNotificationEvents1788703281288'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "push_notification_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "campaign_id" uuid NOT NULL, "device_identity_id" uuid NOT NULL, "type" character varying(20) NOT NULL, "platform" character varying(10), "occurred_at" TIMESTAMP NOT NULL, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d3fc6aa6fe861741320df4dc745" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_46fd454d9686e81faaeb45a03f" ON "push_notification_events" ("project_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4eed7b35768259a8bd0e7d1963" ON "push_notification_events" ("campaign_id", "type") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_66f460ea5fcbf8b466de5b0b5d" ON "push_notification_events" ("campaign_id", "device_identity_id", "type") `);
        await queryRunner.query(`ALTER TABLE "push_notification_events" ADD CONSTRAINT "FK_46fd454d9686e81faaeb45a03f4" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "push_notification_events" ADD CONSTRAINT "FK_c72586bf5446f73cdd1945e8755" FOREIGN KEY ("campaign_id") REFERENCES "push_notification_logs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_events" DROP CONSTRAINT "FK_c72586bf5446f73cdd1945e8755"`);
        await queryRunner.query(`ALTER TABLE "push_notification_events" DROP CONSTRAINT "FK_46fd454d9686e81faaeb45a03f4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_66f460ea5fcbf8b466de5b0b5d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4eed7b35768259a8bd0e7d1963"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_46fd454d9686e81faaeb45a03f"`);
        await queryRunner.query(`DROP TABLE "push_notification_events"`);
    }

}
