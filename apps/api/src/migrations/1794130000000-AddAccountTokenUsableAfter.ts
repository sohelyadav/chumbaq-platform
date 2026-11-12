import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `account_tokens.usable_after`: a staff-issued reset link (`admin:password-reset-link`)
 * does nothing before this time, `STAFF_LINK_DELAY_HOURS` after it was issued, so the
 * owner, emailed at once, can sign in and void it. Null for emailed links, which work
 * at once.
 *
 * Any staff link still unused is spent here: it was issued with no wait and no notice
 * to the owner, which is what this change exists to stop. Support issues a new one.
 */
export class AddAccountTokenUsableAfter1794130000000 implements MigrationInterface {
    name = 'AddAccountTokenUsableAfter1794130000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "account_tokens" ADD "usable_after" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`UPDATE "account_tokens" SET "used_at" = now() WHERE "staff_issued" AND "used_at" IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "account_tokens" DROP COLUMN "usable_after"`);
    }
}
