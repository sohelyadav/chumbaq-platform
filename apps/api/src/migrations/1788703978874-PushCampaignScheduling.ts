import { MigrationInterface, QueryRunner } from "typeorm";

export class PushCampaignScheduling1788703978874 implements MigrationInterface {
    name = 'PushCampaignScheduling1788703978874'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "scheduled_at" TIMESTAMP`);
        await queryRunner.query(`CREATE INDEX "IDX_904032e85449e2622ce15ea566" ON "push_notification_logs" ("scheduled_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_904032e85449e2622ce15ea566"`);
        await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "scheduled_at"`);
    }

}
