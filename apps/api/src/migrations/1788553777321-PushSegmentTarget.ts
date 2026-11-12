import { MigrationInterface, QueryRunner } from "typeorm";

export class PushSegmentTarget1788553777321 implements MigrationInterface {
    name = 'PushSegmentTarget1788553777321'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "segment_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "segment_id"`);
    }

}
