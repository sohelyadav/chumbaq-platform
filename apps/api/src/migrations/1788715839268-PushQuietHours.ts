import { MigrationInterface, QueryRunner } from "typeorm";

export class PushQuietHours1788715839268 implements MigrationInterface {
    name = 'PushQuietHours1788715839268'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "quiet_hours_start" character varying(5)`);
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "quiet_hours_end" character varying(5)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "quiet_hours_end"`);
        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "quiet_hours_start"`);
    }

}
