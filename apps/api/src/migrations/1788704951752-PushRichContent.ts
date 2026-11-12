import { MigrationInterface, QueryRunner } from "typeorm";

export class PushRichContent1788704951752 implements MigrationInterface {
    name = 'PushRichContent1788704951752'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "deep_link_url" character varying(2048)`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "silent" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "delivery_options" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "delivery_options"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "silent"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "deep_link_url"`);
    }

}
