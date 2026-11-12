import { MigrationInterface, QueryRunner } from "typeorm";

export class PushTemplates1788716509902 implements MigrationInterface {
    name = 'PushTemplates1788716509902'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "push_templates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "name" character varying(255) NOT NULL, "description" text, "title" character varying(255) NOT NULL, "body" text, "image_url" character varying(2048), "deep_link_url" character varying(2048), "data" jsonb, "silent" boolean NOT NULL DEFAULT false, "delivery_options" jsonb, "translations" jsonb, "use_count" integer NOT NULL DEFAULT '0', "last_used_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_410d620a6c20ecc5372eccb6d85" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_545071055b2f42fd4ac2dcf356" ON "push_templates" ("project_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e1a0d6d9811d6daa9cb5566095" ON "push_templates" ("project_id", "name") `);
        await queryRunner.query(`ALTER TABLE "push_templates" ADD CONSTRAINT "FK_545071055b2f42fd4ac2dcf356e" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_templates" DROP CONSTRAINT "FK_545071055b2f42fd4ac2dcf356e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e1a0d6d9811d6daa9cb5566095"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_545071055b2f42fd4ac2dcf356"`);
        await queryRunner.query(`DROP TABLE "push_templates"`);
    }

}
