import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The SHA-256 of a webhook's signed body, kept once. The provider signs only the
 * body, not the event id header, so one genuine body could otherwise be posted
 * again and again under new event ids, each adding a row to this append-only
 * table. A body already stored is a replay whatever id it comes with. Null for
 * the worker's synthetic events, which have no body. The append-only trigger now
 * keeps the hash from changing too.
 */
export class AddBillingEventBodyHash1794480000003 implements MigrationInterface {
    name = 'AddBillingEventBodyHash1794480000003'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "billing_events" ADD "body_sha256" character(64)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_billing_events_body_sha256" ON "billing_events" ("body_sha256") WHERE "body_sha256" IS NOT NULL`);
        await queryRunner.query(`CREATE OR REPLACE FUNCTION "billing_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.outcome IN ('pending', 'failed')
       AND NEW.id = OLD.id AND NEW.provider = OLD.provider
       AND NEW.provider_event_id = OLD.provider_event_id AND NEW.type = OLD.type
       AND NEW.event_created_at = OLD.event_created_at AND NEW.received_at = OLD.received_at
       AND NEW.payload = OLD.payload
       AND NEW.body_sha256 IS NOT DISTINCT FROM OLD.body_sha256 THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'billing_events is append-only';
END;
$$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE OR REPLACE FUNCTION "billing_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.outcome IN ('pending', 'failed')
       AND NEW.id = OLD.id AND NEW.provider = OLD.provider
       AND NEW.provider_event_id = OLD.provider_event_id AND NEW.type = OLD.type
       AND NEW.event_created_at = OLD.event_created_at AND NEW.received_at = OLD.received_at
       AND NEW.payload = OLD.payload THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'billing_events is append-only';
END;
$$`);
        await queryRunner.query(`DROP INDEX "public"."IDX_billing_events_body_sha256"`);
        await queryRunner.query(`ALTER TABLE "billing_events" DROP COLUMN "body_sha256"`);
    }
}
