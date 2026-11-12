import { MigrationInterface, QueryRunner } from "typeorm";

export class PushThrottle1788717541686 implements MigrationInterface {
    name = 'PushThrottle1788717541686'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_configs" ADD "max_sends_per_minute" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_configs" DROP COLUMN "max_sends_per_minute"`);
    }

}
