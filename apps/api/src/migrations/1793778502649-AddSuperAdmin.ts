import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSuperAdmin1793778502649 implements MigrationInterface {
    name = 'AddSuperAdmin1793778502649'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "admin_audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actor_id" uuid, "actor_email" character varying(255) NOT NULL, "action" character varying(64) NOT NULL, "target_type" character varying(32) NOT NULL, "target_id" uuid, "target_label" character varying(255), "reason" text, "metadata" jsonb, "ip_address" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_de7a8fc2fbb525484c71a86bb96" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ad2edce25dd3f4e2d7f9de06c4" ON "admin_audit_logs" ("target_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ee43923e8ce21dbe10bccaba85" ON "admin_audit_logs" ("created_at") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "is_super_admin" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "users" ADD "suspended_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD "suspended_reason" text`);
        await queryRunner.query(`ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "FK_472967f954204bfc00191c43e7c" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "FK_472967f954204bfc00191c43e7c"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "suspended_reason"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "suspended_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_super_admin"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ee43923e8ce21dbe10bccaba85"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ad2edce25dd3f4e2d7f9de06c4"`);
        await queryRunner.query(`DROP TABLE "admin_audit_logs"`);
    }

}
