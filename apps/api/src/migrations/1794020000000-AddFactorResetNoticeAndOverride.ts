import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `notice_sent_at`: when the owner's warning was confirmed sent. The wait runs from
 * there, so a reset whose warning never went out never runs. Rows already pending when
 * this lands get null and wait for the scheduler to send their warning, because none of
 * them can be shown to have been warned.
 *
 * `password_reset_override`: the justification staff gave for starting a reset soon
 * after a password reset, shown with the pending reset.
 */
export class AddFactorResetNoticeAndOverride1794020000000 implements MigrationInterface {
    name = 'AddFactorResetNoticeAndOverride1794020000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "factor_resets" ADD "notice_sent_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "factor_resets" ADD "password_reset_override" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "factor_resets" DROP COLUMN "password_reset_override"`);
        await queryRunner.query(`ALTER TABLE "factor_resets" DROP COLUMN "notice_sent_at"`);
    }
}
