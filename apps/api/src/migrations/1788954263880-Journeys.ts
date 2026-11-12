import { MigrationInterface, QueryRunner } from "typeorm";

export class Journeys1788954263880 implements MigrationInterface {
    name = 'Journeys1788954263880'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "journeys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "name" character varying(255) NOT NULL, "description" text, "status" character varying(20) NOT NULL DEFAULT 'draft', "trigger" jsonb NOT NULL, "steps" jsonb NOT NULL, "enrolled_through" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_94b31b067846c92b6811046c81e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_829b8eec954de567b416d0da45" ON "journeys" ("project_id", "status") `);
        await queryRunner.query(`CREATE TABLE "journey_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "journey_id" uuid NOT NULL, "person_key" character varying(255) NOT NULL, "current_step_index" integer NOT NULL DEFAULT '0', "steps_taken" integer NOT NULL DEFAULT '0', "status" character varying(20) NOT NULL DEFAULT 'active', "next_due_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c088ffbc4b6d566cbeffe7e46b5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6e8d547668659f2cdf6a1b4651" ON "journey_runs" ("status", "next_due_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_efa5f7b20a5b4af9480089b125" ON "journey_runs" ("journey_id", "person_key") WHERE status = 'active'`);
        await queryRunner.query(`ALTER TABLE "journeys" ADD CONSTRAINT "FK_0fccdaeb7f353922007c2d46355" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "journey_runs" ADD CONSTRAINT "FK_f2bf21e1df297d45e2dfe3f588a" FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "journey_runs" DROP CONSTRAINT "FK_f2bf21e1df297d45e2dfe3f588a"`);
        await queryRunner.query(`ALTER TABLE "journeys" DROP CONSTRAINT "FK_0fccdaeb7f353922007c2d46355"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_efa5f7b20a5b4af9480089b125"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6e8d547668659f2cdf6a1b4651"`);
        await queryRunner.query(`DROP TABLE "journey_runs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_829b8eec954de567b416d0da45"`);
        await queryRunner.query(`DROP TABLE "journeys"`);
    }

}
