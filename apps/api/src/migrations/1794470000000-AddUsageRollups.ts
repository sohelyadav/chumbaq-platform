import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Daily usage counts per project, the devices active in each month, and where
 * the roll-up has got to.
 *
 * - `usage_daily` holds counts only (no person, address or device), one row
 *   per non-zero value (the API key snapshot stores zeros too, so a missing
 *   row there means no snapshot). No foreign key: the counts are kept after a project
 *   is deleted.
 * - `monthly_active_devices` holds internal device ids, so erasure deletes
 *   from it (person inventory); it goes with its project.
 * - `usage_rollup_state` is a single row.
 *
 * Also indexes the raw tables the roll-up counts, by project and the time a
 * row was written, so a day's count reads only that day's rows. Plain
 * `CREATE INDEX` (migrations run in one transaction): writes to those tables
 * wait while each index builds.
 */
export class AddUsageRollups1794470000000 implements MigrationInterface {
    name = 'AddUsageRollups1794470000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "usage_daily" ("project_id" uuid NOT NULL, "day" date NOT NULL, "metric" character varying(40) NOT NULL, "owner_id" uuid NOT NULL, "value" bigint NOT NULL, "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_usage_daily" PRIMARY KEY ("project_id", "day", "metric"))`);
        await queryRunner.query(`CREATE INDEX "IDX_usage_daily_day" ON "usage_daily" ("day") `);
        await queryRunner.query(`CREATE INDEX "IDX_usage_daily_owner_day" ON "usage_daily" ("owner_id", "day") `);
        await queryRunner.query(`CREATE TABLE "monthly_active_devices" ("project_id" uuid NOT NULL, "month" date NOT NULL, "device_identity_id" uuid NOT NULL, "first_day" date NOT NULL, CONSTRAINT "PK_monthly_active_devices" PRIMARY KEY ("project_id", "month", "device_identity_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_mad_month" ON "monthly_active_devices" ("month") `);
        await queryRunner.query(`ALTER TABLE "monthly_active_devices" ADD CONSTRAINT "FK_monthly_active_devices_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TABLE "usage_rollup_state" ("id" smallint NOT NULL DEFAULT '1', "started_on" date NOT NULL, "first_day" date NOT NULL, "last_closed_day" date NOT NULL, "devices_through" TIMESTAMP WITH TIME ZONE, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_usage_rollup_state_single" CHECK ("id" = 1), CONSTRAINT "PK_usage_rollup_state" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_push_logs_project_completed" ON "push_notification_logs" ("project_id", "completed_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_push_events_project_created" ON "push_notification_events" ("project_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_in_app_impressions_project_created" ON "in_app_message_impressions" ("project_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_user_events_project_created" ON "user_events" ("project_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_device_identities_project_first_seen" ON "device_identities" ("project_id", "first_seen_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_device_identities_project_first_seen"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_events_project_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_in_app_impressions_project_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_push_events_project_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_push_logs_project_completed"`);
        await queryRunner.query(`DROP TABLE "usage_rollup_state"`);
        await queryRunner.query(`ALTER TABLE "monthly_active_devices" DROP CONSTRAINT "FK_monthly_active_devices_project"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_mad_month"`);
        await queryRunner.query(`DROP TABLE "monthly_active_devices"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_usage_daily_owner_day"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_usage_daily_day"`);
        await queryRunner.query(`DROP TABLE "usage_daily"`);
    }

}
