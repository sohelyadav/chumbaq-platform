import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `staff_enrolment_allowances`: `admin:staff-enrolment` now makes a one-time code, kept
 * only as its sha256, that the staff member must type with their password to start an
 * enrolment session. It replaces `users.staff_enrolment_allowed_until`, a time window a
 * password alone could use.
 *
 * Every open window is closed here (operators issue a code instead). The column itself
 * stays for now: the admin API is deployed after the customer API runs this, and the
 * admin API still running reads it until then, so dropping it would break staff sign-in
 * in between. Nothing reads it after this release; a later migration drops it.
 */
export class AddStaffEnrolmentAllowances1794450000000 implements MigrationInterface {
    name = 'AddStaffEnrolmentAllowances1794450000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "staff_enrolment_allowances" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "code_hash" character varying(64) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "used_ip" character varying(64), "voided_at" TIMESTAMP WITH TIME ZONE, "voided_reason" character varying(32), CONSTRAINT "PK_4a7d25d4e0b845ca80668c67df9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4217be2a289d1dbfbdf31a9e2c" ON "staff_enrolment_allowances" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d55080ef86f4aedce67c47fec8" ON "staff_enrolment_allowances" ("code_hash") `);
        await queryRunner.query(`ALTER TABLE "staff_enrolment_allowances" ADD CONSTRAINT "FK_4217be2a289d1dbfbdf31a9e2c0" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`UPDATE "users" SET "staff_enrolment_allowed_until" = NULL WHERE "staff_enrolment_allowed_until" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "staff_enrolment_allowances" DROP CONSTRAINT "FK_4217be2a289d1dbfbdf31a9e2c0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d55080ef86f4aedce67c47fec8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4217be2a289d1dbfbdf31a9e2c"`);
        await queryRunner.query(`DROP TABLE "staff_enrolment_allowances"`);
    }

}
