import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `project_limit`: a per-account override of `MAX_PROJECTS_PER_ACCOUNT`, set by staff.
 * Null for every existing account, which means the default. Accounts that already own
 * more projects than that keep them; only creating another is refused.
 */
export class AddUserProjectLimit1794250000000 implements MigrationInterface {
    name = 'AddUserProjectLimit1794250000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "project_limit" integer`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_project_limit_not_negative" CHECK ("project_limit" >= 0)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_project_limit_not_negative"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "project_limit"`);
    }
}
