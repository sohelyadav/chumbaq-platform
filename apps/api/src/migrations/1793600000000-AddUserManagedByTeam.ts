import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserManagedByTeam1793600000000 implements MigrationInterface {
    name = 'AddUserManagedByTeam1793600000000'

    // Existing rows stay null, meaning "not managed", because nothing recorded
    // which team created them and a guess could hand a stranger an account.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "managed_by_team_id" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "managed_by_team_id"`);
    }
}
