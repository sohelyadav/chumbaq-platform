import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFactorResets1793910000000 implements MigrationInterface {
    name = 'AddFactorResets1793910000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "factor_resets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'pending', "requested_by_id" uuid, "requested_by_email" character varying(255) NOT NULL, "reason" text NOT NULL, "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "execute_after" TIMESTAMP WITH TIME ZONE NOT NULL, "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by" character varying(16), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_e936d61568ca127a02cfe103a74" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_factor_resets_pending_user" ON "factor_resets" ("user_id") WHERE "status" = 'pending'`);
        await queryRunner.query(`CREATE INDEX "IDX_factor_resets_pending_due" ON "factor_resets" ("execute_after") WHERE "status" = 'pending'`);
        await queryRunner.query(`ALTER TABLE "factor_resets" ADD CONSTRAINT "FK_adb767f3acb15239cb1e6c45db6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "factor_resets" DROP CONSTRAINT "FK_adb767f3acb15239cb1e6c45db6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_factor_resets_pending_due"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_factor_resets_pending_user"`);
        await queryRunner.query(`DROP TABLE "factor_resets"`);
    }
}
