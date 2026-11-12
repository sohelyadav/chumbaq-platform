import { MigrationInterface, QueryRunner } from "typeorm";

export class Segmentation1788550763140 implements MigrationInterface {
    name = 'Segmentation1788550763140'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "segments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "name" character varying(255) NOT NULL, "description" text, "definition" jsonb NOT NULL, "evaluation_mode" character varying(20) NOT NULL DEFAULT 'live', "refresh_interval_minutes" integer NOT NULL DEFAULT '60', "status" character varying(20) NOT NULL DEFAULT 'draft', "error_message" text, "last_member_count" integer, "last_materialized_at" TIMESTAMP, "materializing_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_beff1eec19679fe8ad4f291f04e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ca5d1f0049115a81dc6df7216b" ON "segments" ("project_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5fbea0c321c4f0f4cd40a97c30" ON "segments" ("evaluation_mode", "status", "last_materialized_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_78d07da35a4306fd7312922fae" ON "segments" ("project_id", "status") `);
        await queryRunner.query(`CREATE TABLE "segment_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "segment_id" uuid NOT NULL, "project_id" uuid NOT NULL, "person_key" character varying(255) NOT NULL, "materialized_at" TIMESTAMP NOT NULL DEFAULT NOW(), CONSTRAINT "PK_f3ec6efefc7892dbcebc1a42ac4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_017c61b1015accf182fcc60892" ON "segment_members" ("segment_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1f8c185bdb15f255c4c98b0713" ON "segment_members" ("segment_id", "person_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_7bd7eb236dc0534ed6d7f2f4b1" ON "user_events" ("device_identity_id", "event_name", "timestamp") `);
        await queryRunner.query(`ALTER TABLE "segments" ADD CONSTRAINT "FK_ca5d1f0049115a81dc6df7216b8" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "segment_members" ADD CONSTRAINT "FK_017c61b1015accf182fcc608928" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "segment_members" DROP CONSTRAINT "FK_017c61b1015accf182fcc608928"`);
        await queryRunner.query(`ALTER TABLE "segments" DROP CONSTRAINT "FK_ca5d1f0049115a81dc6df7216b8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7bd7eb236dc0534ed6d7f2f4b1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1f8c185bdb15f255c4c98b0713"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_017c61b1015accf182fcc60892"`);
        await queryRunner.query(`DROP TABLE "segment_members"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_78d07da35a4306fd7312922fae"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5fbea0c321c4f0f4cd40a97c30"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ca5d1f0049115a81dc6df7216b"`);
        await queryRunner.query(`DROP TABLE "segments"`);
    }

}
