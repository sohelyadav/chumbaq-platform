import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `users.staff_enrolment_allowed_until`: set for 24 hours by `admin:staff-enrolment`,
 * so a super admin whose only passkeys are customer ones can start staff sign-in with
 * a password and enrol a staff factor. Null for everyone until then.
 */
export class AddStaffEnrolmentAllowance1794430000000 implements MigrationInterface {
    name = 'AddStaffEnrolmentAllowance1794430000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "staff_enrolment_allowed_until" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "staff_enrolment_allowed_until"`);
    }

}
