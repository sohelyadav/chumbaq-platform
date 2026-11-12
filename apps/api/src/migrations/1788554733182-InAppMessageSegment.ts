import { MigrationInterface, QueryRunner } from "typeorm";

export class InAppMessageSegment1788554733182 implements MigrationInterface {
    name = 'InAppMessageSegment1788554733182'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "in_app_messages" ADD "segment_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "in_app_messages" DROP COLUMN "segment_id"`);
    }

}
