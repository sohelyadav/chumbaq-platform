import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The project activity log: `project_activity`, one row per consequential action in a
 * project (who, what, on what, when, from where). No foreign keys, so entries outlive the
 * project, the actor's account and the target.
 *
 * Append-only in the database: `project_activity_append_only()` runs before every UPDATE
 * and DELETE. It refuses UPDATE always. It refuses DELETE unless the transaction has set
 * `chumbaq.activity_retention = 'on'` (only the retention job does) and the row is older
 * than the 180 days CERT-In requires, so neither a bug nor a careless manual query can
 * rewrite history, and even the retention job can't remove a younger row. A statement
 * trigger runs the same function before TRUNCATE, which row triggers never see, and so
 * always refuses it.
 */
export class AddProjectActivity1794440000002 implements MigrationInterface {
    name = 'AddProjectActivity1794440000002'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_activity" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "actor_kind" text NOT NULL, "actor_user_id" uuid, "actor_label" text NOT NULL, "action" text NOT NULL, "target_type" text, "target_id" text, "target_label" text, "details" jsonb, "ip_address" character varying(64), "user_agent" character varying(512), "country" character(2), CONSTRAINT "CHK_project_activity_actor_kind" CHECK ("actor_kind" IN ('user', 'staff', 'api_key', 'system', 'app')), CONSTRAINT "PK_d1d722fe8898deff9b95ba377a7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_project_activity_page" ON "project_activity" ("project_id", "occurred_at" DESC, "id" DESC)`);
        await queryRunner.query(`CREATE INDEX "IDX_project_activity_actor" ON "project_activity" ("project_id", "actor_user_id", "occurred_at" DESC)`);
        await queryRunner.query(`CREATE INDEX "IDX_project_activity_occurred_at" ON "project_activity" ("occurred_at")`);
        await queryRunner.query(`CREATE FUNCTION "project_activity_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('chumbaq.activity_retention', true) = 'on'
       AND OLD.occurred_at < now() - interval '180 days' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project_activity is append-only';
END;
$$`);
        await queryRunner.query(`CREATE TRIGGER "project_activity_append_only" BEFORE UPDATE OR DELETE ON "project_activity" FOR EACH ROW EXECUTE FUNCTION "project_activity_append_only"()`);
        await queryRunner.query(`CREATE TRIGGER "project_activity_no_truncate" BEFORE TRUNCATE ON "project_activity" FOR EACH STATEMENT EXECUTE FUNCTION "project_activity_append_only"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "project_activity_no_truncate" ON "project_activity"`);
        await queryRunner.query(`DROP TRIGGER "project_activity_append_only" ON "project_activity"`);
        await queryRunner.query(`DROP FUNCTION "project_activity_append_only"()`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_activity_occurred_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_activity_actor"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_project_activity_page"`);
        await queryRunner.query(`DROP TABLE "project_activity"`);
    }

}
