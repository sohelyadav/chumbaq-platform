import { MigrationInterface, QueryRunner } from "typeorm";

export class PushSendTimeOptimisation1788716920450 implements MigrationInterface {
    name = 'PushSendTimeOptimisation1788716920450'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "send_time_optimised" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "send_time_optimised"`);
    }

}
