import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAccountSessions1793793687109 implements MigrationInterface {
    name = 'AddAccountSessions1793793687109'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "auth_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid, "email" character varying(255), "type" character varying(64) NOT NULL, "reason" character varying(64), "session_id" uuid, "ip_address" character varying(64), "user_agent" character varying(512), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ab929cc6084ffb3fd795bd983c0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f98c708f75869695c546656aa1" ON "auth_events" ("user_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_0f805e81b14d940b23d59654fc" ON "auth_events" ("email", "created_at") `);
        await queryRunner.query(`CREATE TABLE "auth_sessions" ("id" uuid NOT NULL, "user_id" uuid NOT NULL, "current_jti" uuid NOT NULL, "previous_jti" uuid, "rotated_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "ip_address" character varying(64), "user_agent" character varying(512), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_641507381f32580e8479efc36cd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_50ccaa6440288a06f0ba693ccc" ON "auth_sessions" ("user_id") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "session_version" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "auth_events" ADD CONSTRAINT "FK_d27703f0a3d79ba424741807cb4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth_sessions" ADD CONSTRAINT "FK_50ccaa6440288a06f0ba693ccc6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "auth_sessions" DROP CONSTRAINT "FK_50ccaa6440288a06f0ba693ccc6"`);
        await queryRunner.query(`ALTER TABLE "auth_events" DROP CONSTRAINT "FK_d27703f0a3d79ba424741807cb4"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "session_version"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_50ccaa6440288a06f0ba693ccc"`);
        await queryRunner.query(`DROP TABLE "auth_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0f805e81b14d940b23d59654fc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f98c708f75869695c546656aa1"`);
        await queryRunner.query(`DROP TABLE "auth_events"`);
    }

}
