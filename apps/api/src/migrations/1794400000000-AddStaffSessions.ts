import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `staff_sessions`: one row per staff sign-in on the admin app, apart from
 * `auth_sessions` so a customer session can never pass for a staff one. The refresh
 * token is kept only as a sha256 hash (null for an enrolment-only session, which has
 * none). Rows go with their user.
 */
export class AddStaffSessions1794400000000 implements MigrationInterface {
    name = 'AddStaffSessions1794400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "staff_sessions" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "current_token_hash" character varying(64), "previous_token_hash" character varying(64), "rotated_at" TIMESTAMP WITH TIME ZONE, "amr" jsonb NOT NULL DEFAULT '[]', "authenticated_at" TIMESTAMP WITH TIME ZONE, "session_version" integer NOT NULL DEFAULT '0', "enrolment_only" boolean NOT NULL DEFAULT false, "ip_address" character varying(64), "user_agent" character varying(512), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_active_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "revoked_at" TIMESTAMP WITH TIME ZONE, "revoked_reason" character varying(32), CONSTRAINT "PK_b9be2467392ab95efaa3661cce2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2d3e82105bee50ac45fe3ed597" ON "staff_sessions" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c4cca8763e3e557a921e66a331" ON "staff_sessions" ("current_token_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_f17640f64874d1865680f70aec" ON "staff_sessions" ("revoked_at") `);
        await queryRunner.query(`ALTER TABLE "staff_sessions" ADD CONSTRAINT "FK_2d3e82105bee50ac45fe3ed5975" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "staff_sessions" DROP CONSTRAINT "FK_2d3e82105bee50ac45fe3ed5975"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f17640f64874d1865680f70aec"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c4cca8763e3e557a921e66a331"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2d3e82105bee50ac45fe3ed597"`);
        await queryRunner.query(`DROP TABLE "staff_sessions"`);
    }

}
