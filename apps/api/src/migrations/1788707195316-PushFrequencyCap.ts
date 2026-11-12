import { MigrationInterface, QueryRunner } from "typeorm";

export class PushFrequencyCap1788707195316 implements MigrationInterface {
    name = 'PushFrequencyCap1788707195316'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "frequency_cap_per_day" integer`);
        await queryRunner.query(`CREATE INDEX "IDX_255f349a96684c77615dddbe50" ON "push_notification_events" ("device_identity_id", "type", "occurred_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_255f349a96684c77615dddbe50"`);
        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "frequency_cap_per_day"`);
    }

}
