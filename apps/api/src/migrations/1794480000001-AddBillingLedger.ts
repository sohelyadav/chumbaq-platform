import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The billing ledger: what the billing provider told us, and the invoices and
 * payments that followed. None of these tables holds anything about a tenant's end
 * users: they describe accounts (tenants) and what they paid.
 *
 * - `billing_events`: every verified webhook (and every synthetic event the worker's
 *   reconciliation applies), once per provider event id. Append-only in the
 *   database: DELETE and TRUNCATE are always refused, and an UPDATE may change only
 *   `outcome`, `detail`, `attempts` and `applied_at`, and only while the outcome is
 *   still `pending` or `failed`, so a settled event is never reopened or rewritten.
 *   The payload keeps allow-listed fields only (no card, bank, contact or notes).
 * - `billing_invoices` and `billing_payments`: integer paise. Both are kept for tax
 *   law, so deleting the user they belong to is refused (ON DELETE RESTRICT), as it
 *   is for `billing_subscriptions`. A payment's refunded amount is cumulative and
 *   never above its amount.
 */
export class AddBillingLedger1794480000001 implements MigrationInterface {
    name = 'AddBillingLedger1794480000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "billing_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "provider" character varying(16) NOT NULL, "provider_event_id" character varying(64) NOT NULL, "type" character varying(64) NOT NULL, "event_created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "payload" jsonb NOT NULL, "outcome" character varying(8) NOT NULL DEFAULT 'pending', "detail" character varying(320), "attempts" integer NOT NULL DEFAULT '0', "applied_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_8483438dcc79f8b8a0411c425cc" UNIQUE ("provider_event_id"), CONSTRAINT "CHK_billing_events_outcome" CHECK ("outcome" IN ('pending', 'applied', 'ignored', 'failed')), CONSTRAINT "PK_billing_events" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "billing_invoices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "provider_invoice_id" character varying(40) NOT NULL, "user_id" uuid NOT NULL, "subscription_id" uuid, "status" character varying(20) NOT NULL, "amount_paise" integer NOT NULL, "tax_paise" integer NOT NULL, "provider_tax_paise" integer NOT NULL, "currency" character(3) NOT NULL, "period_start" TIMESTAMP WITH TIME ZONE, "period_end" TIMESTAMP WITH TIME ZONE, "issued_at" TIMESTAMP WITH TIME ZONE, "paid_at" TIMESTAMP WITH TIME ZONE, "short_url" character varying(200), "number" character varying(40), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_c93fe60aba53b8f7c7e57e2bd37" UNIQUE ("provider_invoice_id"), CONSTRAINT "PK_billing_invoices" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_billing_invoices_user_issued" ON "billing_invoices" ("user_id", "issued_at" DESC) `);
        await queryRunner.query(`CREATE TABLE "billing_payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "provider_payment_id" character varying(40) NOT NULL, "user_id" uuid NOT NULL, "subscription_id" uuid, "provider_invoice_id" character varying(40), "amount_paise" integer NOT NULL, "amount_refunded_paise" integer NOT NULL DEFAULT '0', "tax_rate_bps" integer NOT NULL, "currency" character(3) NOT NULL, "status" character varying(10) NOT NULL, "method" character varying(20), "failure_reason" character varying(200), "paid_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_87db8f4e72da4d4b613b6c5ad81" UNIQUE ("provider_payment_id"), CONSTRAINT "CHK_billing_payments_refund" CHECK ("amount_refunded_paise" BETWEEN 0 AND "amount_paise"), CONSTRAINT "CHK_billing_payments_status" CHECK ("status" IN ('captured', 'failed', 'refunded')), CONSTRAINT "PK_billing_payments" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_billing_payments_paid_at" ON "billing_payments" ("paid_at" DESC) `);
        await queryRunner.query(`CREATE INDEX "IDX_billing_payments_user_paid_at" ON "billing_payments" ("user_id", "paid_at" DESC) `);
        // Invoices and payments are kept for tax law: a user who has any cannot be deleted.
        await queryRunner.query(`ALTER TABLE "billing_invoices" ADD CONSTRAINT "FK_billing_invoices_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_invoices" ADD CONSTRAINT "FK_billing_invoices_subscription" FOREIGN KEY ("subscription_id") REFERENCES "billing_subscriptions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_payments" ADD CONSTRAINT "FK_billing_payments_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_payments" ADD CONSTRAINT "FK_billing_payments_subscription" FOREIGN KEY ("subscription_id") REFERENCES "billing_subscriptions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE FUNCTION "billing_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
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
        await queryRunner.query(`CREATE TRIGGER "billing_events_append_only" BEFORE UPDATE OR DELETE ON "billing_events" FOR EACH ROW EXECUTE FUNCTION "billing_events_append_only"()`);
        await queryRunner.query(`CREATE TRIGGER "billing_events_no_truncate" BEFORE TRUNCATE ON "billing_events" FOR EACH STATEMENT EXECUTE FUNCTION "billing_events_append_only"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "billing_events_no_truncate" ON "billing_events"`);
        await queryRunner.query(`DROP TRIGGER "billing_events_append_only" ON "billing_events"`);
        await queryRunner.query(`DROP FUNCTION "billing_events_append_only"()`);
        await queryRunner.query(`ALTER TABLE "billing_payments" DROP CONSTRAINT "FK_billing_payments_subscription"`);
        await queryRunner.query(`ALTER TABLE "billing_payments" DROP CONSTRAINT "FK_billing_payments_user"`);
        await queryRunner.query(`ALTER TABLE "billing_invoices" DROP CONSTRAINT "FK_billing_invoices_subscription"`);
        await queryRunner.query(`ALTER TABLE "billing_invoices" DROP CONSTRAINT "FK_billing_invoices_user"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_billing_payments_user_paid_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_billing_payments_paid_at"`);
        await queryRunner.query(`DROP TABLE "billing_payments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_billing_invoices_user_issued"`);
        await queryRunner.query(`DROP TABLE "billing_invoices"`);
        await queryRunner.query(`DROP TABLE "billing_events"`);
    }

}
