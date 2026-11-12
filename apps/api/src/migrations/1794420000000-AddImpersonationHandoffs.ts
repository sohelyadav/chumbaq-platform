import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `impersonation_handoffs`: a view-as code made by the admin API and spent once, by a
 * conditional UPDATE, by the customer API. Only the code's sha256 is stored. Rows go
 * with the staff member, their staff session or the tenant.
 */
export class AddImpersonationHandoffs1794420000000 implements MigrationInterface {
    name = 'AddImpersonationHandoffs1794420000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "impersonation_handoffs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code_hash" character varying(64) NOT NULL, "actor_id" uuid NOT NULL, "actor_session_version" integer NOT NULL, "staff_session_id" uuid NOT NULL, "target_id" uuid NOT NULL, "reason" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "used_ip" character varying(64), CONSTRAINT "PK_b54def3b3794f60760db8f9678d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_da897468f39c1766829044b072" ON "impersonation_handoffs" ("code_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_143671510700becdb97750e147" ON "impersonation_handoffs" ("expires_at") `);
        await queryRunner.query(`ALTER TABLE "impersonation_handoffs" ADD CONSTRAINT "FK_9b099dccbe83c75d2dd02ac4075" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "impersonation_handoffs" ADD CONSTRAINT "FK_547c04572954bb7521ce36c9923" FOREIGN KEY ("staff_session_id") REFERENCES "staff_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "impersonation_handoffs" ADD CONSTRAINT "FK_aa062782a0f155bbed048b40605" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "impersonation_handoffs" DROP CONSTRAINT "FK_aa062782a0f155bbed048b40605"`);
        await queryRunner.query(`ALTER TABLE "impersonation_handoffs" DROP CONSTRAINT "FK_547c04572954bb7521ce36c9923"`);
        await queryRunner.query(`ALTER TABLE "impersonation_handoffs" DROP CONSTRAINT "FK_9b099dccbe83c75d2dd02ac4075"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_143671510700becdb97750e147"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_da897468f39c1766829044b072"`);
        await queryRunner.query(`DROP TABLE "impersonation_handoffs"`);
    }

}
