import { MigrationInterface, QueryRunner } from "typeorm";

export class PushAbTesting1788714921869 implements MigrationInterface {
    name = 'PushAbTesting1788714921869'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "variants" jsonb`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "control_percentage" integer`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "variant_key" character varying(16)`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "control_device_ids" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "control_device_ids"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "variant_key"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "control_percentage"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "variants"`);
    }

}
