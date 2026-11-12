import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `account_tokens.staff_issued`: a password reset link staff issued through the CLI
 * (`admin:password-reset-link`) after checking who is asking, never emailed. Only such
 * a link resets a password within 14 days of a staff factor reset, which is how a super
 * admin who lost both their keys and their password gets back in. False for every
 * existing token, which were all emailed.
 */
export class AddAccountTokenStaffIssued1794100000000 implements MigrationInterface {
    name = 'AddAccountTokenStaffIssued1794100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "account_tokens" ADD "staff_issued" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "account_tokens" DROP COLUMN "staff_issued"`);
    }
}
