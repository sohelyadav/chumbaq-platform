import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The incident register for CERT-In's 6-hour rule.
 *
 * `security_incidents` keeps its history: no DELETE or TRUNCATE, and an UPDATE may only
 * move the status forward (open to reported or closed, reported to closed), fill the
 * reported and closed fields once, stamp each reminder once, and set the email-failed
 * flag. What was recorded (when noticed, types, title, description) never changes;
 * corrections are notes. `security_incident_notes` is insert-only.
 *
 * `security_contact` is one row (id 1) of settings for the report draft.
 */
export class AddSecurityIncidents1794460000002 implements MigrationInterface {
    name = 'AddSecurityIncidents1794460000002'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "security_incidents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "noticed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "recorded_by" uuid, "how_noticed" text NOT NULL DEFAULT '', "types" text[] NOT NULL, "title" character varying(200) NOT NULL, "summary" text NOT NULL DEFAULT '', "systems" text NOT NULL DEFAULT '', "tenant_ids" uuid[] NOT NULL DEFAULT '{}', "alert_id" uuid, "status" character varying(10) NOT NULL DEFAULT 'open', "reported_at" TIMESTAMP WITH TIME ZONE, "reported_by" uuid, "report_method" character varying(10), "certin_reference" character varying(100), "closed_at" TIMESTAMP WITH TIME ZONE, "closed_by" uuid, "reminder_4h_at" TIMESTAMP WITH TIME ZONE, "reminder_5h_at" TIMESTAMP WITH TIME ZONE, "reminder_email_failed" boolean NOT NULL DEFAULT false, CONSTRAINT "CHK_security_incidents_status" CHECK ("status" IN ('open', 'reported', 'closed')), CONSTRAINT "CHK_security_incidents_types" CHECK (cardinality("types") > 0), CONSTRAINT "CHK_security_incidents_reported" CHECK ("status" <> 'reported' OR "reported_at" IS NOT NULL), CONSTRAINT "CHK_security_incidents_closed" CHECK ("status" <> 'closed' OR "closed_at" IS NOT NULL), CONSTRAINT "CHK_security_incidents_method" CHECK ("report_method" IS NULL OR "report_method" IN ('email', 'phone', 'fax', 'portal')), CONSTRAINT "PK_security_incidents" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_security_incidents_noticed_at" ON "security_incidents" ("noticed_at" DESC)`);
        await queryRunner.query(`CREATE TABLE "security_incident_notes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "incident_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "note" text NOT NULL, CONSTRAINT "PK_security_incident_notes" PRIMARY KEY ("id"), CONSTRAINT "FK_security_incident_notes_incident" FOREIGN KEY ("incident_id") REFERENCES "security_incidents"("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_security_incident_notes_incident" ON "security_incident_notes" ("incident_id", "created_at")`);
        await queryRunner.query(`CREATE TABLE "security_contact" ("id" smallint NOT NULL DEFAULT 1, "org_name" character varying(300), "org_address" character varying(300), "sector" character varying(300), "poc_name" character varying(300), "poc_role" character varying(300), "poc_email" character varying(300), "poc_phone" character varying(300), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" uuid, CONSTRAINT "CHK_security_contact_single" CHECK ("id" = 1), CONSTRAINT "PK_security_contact" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE FUNCTION "security_incidents_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.id = OLD.id AND NEW.noticed_at = OLD.noticed_at AND NEW.recorded_at = OLD.recorded_at
       AND NEW.recorded_by IS NOT DISTINCT FROM OLD.recorded_by AND NEW.how_noticed = OLD.how_noticed
       AND NEW.types = OLD.types AND NEW.title = OLD.title AND NEW.summary = OLD.summary
       AND NEW.systems = OLD.systems AND NEW.tenant_ids = OLD.tenant_ids
       AND NEW.alert_id IS NOT DISTINCT FROM OLD.alert_id
       AND (NEW.status = OLD.status
            OR (OLD.status = 'open' AND NEW.status IN ('reported', 'closed'))
            OR (OLD.status = 'reported' AND NEW.status = 'closed'))
       AND (OLD.reported_at IS NULL OR (NEW.reported_at = OLD.reported_at
            AND NEW.reported_by IS NOT DISTINCT FROM OLD.reported_by
            AND NEW.report_method IS NOT DISTINCT FROM OLD.report_method
            AND NEW.certin_reference IS NOT DISTINCT FROM OLD.certin_reference))
       AND (OLD.closed_at IS NULL OR (NEW.closed_at = OLD.closed_at AND NEW.closed_by IS NOT DISTINCT FROM OLD.closed_by))
       AND (OLD.reminder_4h_at IS NULL OR NEW.reminder_4h_at = OLD.reminder_4h_at)
       AND (OLD.reminder_5h_at IS NULL OR NEW.reminder_5h_at = OLD.reminder_5h_at)
       AND (NEW.reminder_email_failed OR NOT OLD.reminder_email_failed) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'security_incidents is append-only';
END;
$$`);
        await queryRunner.query(`CREATE TRIGGER "security_incidents_append_only" BEFORE UPDATE OR DELETE ON "security_incidents" FOR EACH ROW EXECUTE FUNCTION "security_incidents_append_only"()`);
        await queryRunner.query(`CREATE TRIGGER "security_incidents_no_truncate" BEFORE TRUNCATE ON "security_incidents" FOR EACH STATEMENT EXECUTE FUNCTION "security_incidents_append_only"()`);
        await queryRunner.query(`CREATE FUNCTION "security_incident_notes_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'security_incident_notes is append-only';
END;
$$`);
        await queryRunner.query(`CREATE TRIGGER "security_incident_notes_append_only" BEFORE UPDATE OR DELETE ON "security_incident_notes" FOR EACH ROW EXECUTE FUNCTION "security_incident_notes_append_only"()`);
        await queryRunner.query(`CREATE TRIGGER "security_incident_notes_no_truncate" BEFORE TRUNCATE ON "security_incident_notes" FOR EACH STATEMENT EXECUTE FUNCTION "security_incident_notes_append_only"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "security_contact"`);
        await queryRunner.query(`DROP TRIGGER "security_incident_notes_no_truncate" ON "security_incident_notes"`);
        await queryRunner.query(`DROP TRIGGER "security_incident_notes_append_only" ON "security_incident_notes"`);
        await queryRunner.query(`DROP FUNCTION "security_incident_notes_append_only"()`);
        await queryRunner.query(`DROP TABLE "security_incident_notes"`);
        await queryRunner.query(`DROP TRIGGER "security_incidents_no_truncate" ON "security_incidents"`);
        await queryRunner.query(`DROP TRIGGER "security_incidents_append_only" ON "security_incidents"`);
        await queryRunner.query(`DROP FUNCTION "security_incidents_append_only"()`);
        await queryRunner.query(`DROP TABLE "security_incidents"`);
    }

}
