import { MigrationInterface, QueryRunner } from "typeorm";

export class PushActions1788717186962 implements MigrationInterface {
    name = 'PushActions1788717186962'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "actions" jsonb`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "ios_category" character varying(64)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "ios_category"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "actions"`);
    }

}
