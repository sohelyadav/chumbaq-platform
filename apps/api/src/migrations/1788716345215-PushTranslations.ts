import { MigrationInterface, QueryRunner } from "typeorm";

export class PushTranslations1788716345215 implements MigrationInterface {
    name = 'PushTranslations1788716345215'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "translations" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "translations"`);
    }

}
