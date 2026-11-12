import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionAuthentication1793850000000 implements MigrationInterface {
    name = 'AddSessionAuthentication1793850000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "auth_sessions" ADD "amr" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "auth_sessions" ADD "authenticated_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "auth_sessions" DROP COLUMN "authenticated_at"`);
        await queryRunner.query(`ALTER TABLE "auth_sessions" DROP COLUMN "amr"`);
    }
}
