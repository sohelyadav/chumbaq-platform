import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Security alarms: one row per alarm per 15-minute window (repeats in the window raise
 * `count`), so the Incidents page can show what was raised and whether its email went.
 *
 * Append-only in the database: DELETE and TRUNCATE are always refused, and an UPDATE may
 * change only the window's tally and email outcome (`last_at`, `count`, `emailed_at`,
 * `email_failed`). What was raised, when it started, and its details never change.
 */
export class AddSecurityAlerts1794460000000 implements MigrationInterface {
    name = 'AddSecurityAlerts1794460000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "security_alerts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kind" character varying(40) NOT NULL, "dedupe_key" character varying(200) NOT NULL, "details" jsonb NOT NULL DEFAULT '{}', "ip_address" character varying(64), "first_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "count" integer NOT NULL DEFAULT 1, "emailed_at" TIMESTAMP WITH TIME ZONE, "email_failed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_security_alerts" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_security_alerts_window" ON "security_alerts" ("kind", "dedupe_key", "first_at" DESC)`);
        await queryRunner.query(`CREATE INDEX "IDX_security_alerts_first_at" ON "security_alerts" ("first_at" DESC)`);
        await queryRunner.query(`CREATE FUNCTION "security_alerts_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.id = OLD.id AND NEW.kind = OLD.kind AND NEW.dedupe_key = OLD.dedupe_key
       AND NEW.details = OLD.details AND NEW.ip_address IS NOT DISTINCT FROM OLD.ip_address
       AND NEW.first_at = OLD.first_at THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'security_alerts is append-only';
END;
$$`);
        await queryRunner.query(`CREATE TRIGGER "security_alerts_append_only" BEFORE UPDATE OR DELETE ON "security_alerts" FOR EACH ROW EXECUTE FUNCTION "security_alerts_append_only"()`);
        await queryRunner.query(`CREATE TRIGGER "security_alerts_no_truncate" BEFORE TRUNCATE ON "security_alerts" FOR EACH STATEMENT EXECUTE FUNCTION "security_alerts_append_only"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "security_alerts_no_truncate" ON "security_alerts"`);
        await queryRunner.query(`DROP TRIGGER "security_alerts_append_only" ON "security_alerts"`);
        await queryRunner.query(`DROP FUNCTION "security_alerts_append_only"()`);
        await queryRunner.query(`DROP TABLE "security_alerts"`);
    }

}
