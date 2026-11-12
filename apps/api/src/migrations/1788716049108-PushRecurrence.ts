import { MigrationInterface, QueryRunner } from "typeorm";

export class PushRecurrence1788716049108 implements MigrationInterface {
    name = 'PushRecurrence1788716049108'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "recurrence" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "recurrence"`);
    }

}
