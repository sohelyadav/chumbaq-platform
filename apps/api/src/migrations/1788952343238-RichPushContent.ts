import { MigrationInterface, QueryRunner } from "typeorm";

export class RichPushContent1788952343238 implements MigrationInterface {
    name = 'RichPushContent1788952343238'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "carousel" jsonb`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "timer" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "timer"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "carousel"`);
    }

}
