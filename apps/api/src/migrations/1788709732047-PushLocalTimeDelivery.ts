import { MigrationInterface, QueryRunner } from "typeorm";

export class PushLocalTimeDelivery1788709732047 implements MigrationInterface {
    name = 'PushLocalTimeDelivery1788709732047'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "deliver_in_recipient_timezone" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "local_send_time" character varying(5)`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "parent_campaign_id" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_b241d0fdb7244aa4134a93a4dd" ON "push_notification_logs" ("parent_campaign_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b241d0fdb7244aa4134a93a4dd"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "parent_campaign_id"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "local_send_time"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "deliver_in_recipient_timezone"`);
    }

}
