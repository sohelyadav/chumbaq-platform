import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Plans, their prices, and each account's billing state. None of these tables holds
 * anything about a tenant's end users: they describe accounts (tenants) and what
 * they pay for.
 *
 * - `plans`: the plans and the limits each gives while billing is on. Only `free` is
 *   seeded, with null limits (so the install's project and seat defaults apply, and
 *   no MAU limit); every other plan is data staff add. A trigger refuses deleting `free`, renaming it, or switching
 *   it off, since every account without a live subscription falls back to it.
 * - `plan_prices`: versioned prices per plan and interval, in integer paise. The
 *   price excludes GST; `amount_paise` (what the provider charges) is held to
 *   `price + roundHalfUp(price * tax_rate_bps / 10000)` by a CHECK computed in
 *   bigint. At most one current price per plan and interval; `free` has none.
 * - `billing_subscriptions`: a mirror of each provider subscription, its status as
 *   the provider gives it, the ordering fields for out-of-order webhooks, and an
 *   outbox for cancels the worker sends. Deleting a user who has one is refused.
 * - `billing_accounts`: one per account that has touched billing (no row is the free
 *   plan): pointers to the current and next subscription (deferrable, so a
 *   transaction can insert and point in either order), a staff comp, the details
 *   for tax invoices, and the last MAU notice sent. It stores no status of its own:
 *   the plan is derived from the pointers and the comp. It goes with its user.
 */
export class AddPlansAndBillingAccounts1794480000000 implements MigrationInterface {
    name = 'AddPlansAndBillingAccounts1794480000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "plans" ("code" character varying(32) NOT NULL, "name" character varying(60) NOT NULL, "mau_limit" integer, "project_limit" integer, "seat_limit" integer, "sort_order" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_plans_seat_limit" CHECK ("seat_limit" >= 1), CONSTRAINT "CHK_plans_project_limit" CHECK ("project_limit" BETWEEN 1 AND 1000), CONSTRAINT "CHK_plans_mau_limit" CHECK ("mau_limit" >= 1), CONSTRAINT "CHK_plans_code" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,31}$'), CONSTRAINT "PK_plans" PRIMARY KEY ("code"))`);
        await queryRunner.query(`CREATE TABLE "plan_prices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "plan_code" character varying(32) NOT NULL, "interval" character varying(7) NOT NULL, "price_paise" integer NOT NULL, "tax_rate_bps" integer NOT NULL, "amount_paise" integer NOT NULL, "currency" character(3) NOT NULL DEFAULT 'INR', "razorpay_plan_id" character varying(40) NOT NULL, "is_current" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, CONSTRAINT "UQ_e97e56215f7a8591f3f27f87d18" UNIQUE ("razorpay_plan_id"), CONSTRAINT "CHK_plan_prices_not_free" CHECK ("plan_code" <> 'free'), CONSTRAINT "CHK_plan_prices_currency" CHECK ("currency" = 'INR'), CONSTRAINT "CHK_plan_prices_amount" CHECK ("amount_paise" = "price_paise" + ("price_paise"::bigint * "tax_rate_bps" + 5000) / 10000), CONSTRAINT "CHK_plan_prices_tax_rate" CHECK ("tax_rate_bps" BETWEEN 0 AND 10000), CONSTRAINT "CHK_plan_prices_price_positive" CHECK ("price_paise" > 0), CONSTRAINT "CHK_plan_prices_interval" CHECK ("interval" IN ('monthly', 'yearly')), CONSTRAINT "PK_plan_prices" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_plan_prices_current" ON "plan_prices" ("plan_code", "interval") WHERE "is_current"`);
        await queryRunner.query(`CREATE TABLE "billing_subscriptions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "provider" character varying(16) NOT NULL DEFAULT 'razorpay', "provider_subscription_id" character varying(40) NOT NULL, "price_id" uuid NOT NULL, "plan_code" character varying(32) NOT NULL, "interval" character varying(7) NOT NULL, "status" character varying(16) NOT NULL, "method" character varying(20), "current_start" TIMESTAMP WITH TIME ZONE, "current_end" TIMESTAMP WITH TIME ZONE, "start_at" TIMESTAMP WITH TIME ZONE, "charge_at" TIMESTAMP WITH TIME ZONE, "ended_at" TIMESTAMP WITH TIME ZONE, "paid_count" integer NOT NULL DEFAULT '0', "cancel_at_period_end" boolean NOT NULL DEFAULT false, "grace_until" TIMESTAMP WITH TIME ZONE, "status_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_event_at" TIMESTAMP WITH TIME ZONE, "last_event_rank" smallint NOT NULL DEFAULT '0', "superseded_by" uuid, "was_current" boolean NOT NULL DEFAULT false, "cancel_requested_at" TIMESTAMP WITH TIME ZONE, "cancel_at_cycle_end" boolean, "cancel_requested_by" uuid, "cancel_sent_at" TIMESTAMP WITH TIME ZONE, "cancel_attempts" integer NOT NULL DEFAULT '0', "cancel_error" character varying(320), "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_a7273c138c0f2fbc0cbb77cc6cc" UNIQUE ("provider_subscription_id"), CONSTRAINT "CHK_billing_subscriptions_interval" CHECK ("interval" IN ('monthly', 'yearly')), CONSTRAINT "CHK_billing_subscriptions_status" CHECK ("status" IN ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired')), CONSTRAINT "PK_billing_subscriptions" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_billing_subscriptions_cancel_outbox" ON "billing_subscriptions" ("cancel_requested_at") WHERE "cancel_requested_at" IS NOT NULL AND "cancel_sent_at" IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_billing_subscriptions_user_created" ON "billing_subscriptions" ("user_id", "created_at" DESC) `);
        await queryRunner.query(`CREATE TABLE "billing_accounts" ("user_id" uuid NOT NULL, "provider_customer_id" character varying(40), "current_subscription_id" uuid, "next_subscription_id" uuid, "comp_plan_code" character varying(32), "comp_until" TIMESTAMP WITH TIME ZONE, "comp_reason" character varying(500), "comped_by" uuid, "comped_at" TIMESTAMP WITH TIME ZONE, "legal_name" character varying(200), "gstin" character(15), "address" jsonb, "state_code" character(2), "mau_notice_month" date, "mau_notice_level" smallint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_157a81695a2437205eb00771581" UNIQUE ("provider_customer_id"), CONSTRAINT "CHK_billing_accounts_mau_notice_level" CHECK ("mau_notice_level" IN (80, 100)), CONSTRAINT "PK_billing_accounts" PRIMARY KEY ("user_id"))`);
        await queryRunner.query(`ALTER TABLE "plan_prices" ADD CONSTRAINT "FK_plan_prices_plan" FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "FK_billing_subscriptions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "FK_billing_subscriptions_price" FOREIGN KEY ("price_id") REFERENCES "plan_prices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "FK_billing_subscriptions_plan" FOREIGN KEY ("plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "FK_billing_subscriptions_superseded_by" FOREIGN KEY ("superseded_by") REFERENCES "billing_subscriptions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" ADD CONSTRAINT "FK_billing_accounts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" ADD CONSTRAINT "FK_billing_accounts_current" FOREIGN KEY ("current_subscription_id") REFERENCES "billing_subscriptions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" ADD CONSTRAINT "FK_billing_accounts_next" FOREIGN KEY ("next_subscription_id") REFERENCES "billing_subscriptions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" ADD CONSTRAINT "FK_billing_accounts_comp_plan" FOREIGN KEY ("comp_plan_code") REFERENCES "plans"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`INSERT INTO "plans" ("code", "name", "mau_limit", "project_limit", "seat_limit", "sort_order", "is_active") VALUES ('free', 'Free', NULL, NULL, NULL, 0, true)`);
        await queryRunner.query(`
            CREATE FUNCTION plans_keep_free() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    IF OLD.code = 'free' THEN
                        RAISE EXCEPTION 'The free plan cannot be deleted' USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN OLD;
                END IF;
                IF OLD.code = 'free' AND (NEW.code <> 'free' OR NOT NEW.is_active) THEN
                    RAISE EXCEPTION 'The free plan cannot be renamed or switched off' USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END
            $$`);
        await queryRunner.query(`CREATE TRIGGER "TRG_plans_keep_free" BEFORE UPDATE OR DELETE ON "plans" FOR EACH ROW EXECUTE FUNCTION plans_keep_free()`);
        await queryRunner.query(`
            CREATE FUNCTION plans_refuse_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'plans cannot be truncated' USING ERRCODE = 'check_violation';
            END
            $$`);
        await queryRunner.query(`CREATE TRIGGER "TRG_plans_refuse_truncate" BEFORE TRUNCATE ON "plans" FOR EACH STATEMENT EXECUTE FUNCTION plans_refuse_truncate()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "TRG_plans_refuse_truncate" ON "plans"`);
        await queryRunner.query(`DROP FUNCTION plans_refuse_truncate()`);
        await queryRunner.query(`DROP TRIGGER "TRG_plans_keep_free" ON "plans"`);
        await queryRunner.query(`DROP FUNCTION plans_keep_free()`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" DROP CONSTRAINT "FK_billing_accounts_comp_plan"`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" DROP CONSTRAINT "FK_billing_accounts_next"`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" DROP CONSTRAINT "FK_billing_accounts_current"`);
        await queryRunner.query(`ALTER TABLE "billing_accounts" DROP CONSTRAINT "FK_billing_accounts_user"`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "FK_billing_subscriptions_superseded_by"`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "FK_billing_subscriptions_plan"`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "FK_billing_subscriptions_price"`);
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "FK_billing_subscriptions_user"`);
        await queryRunner.query(`ALTER TABLE "plan_prices" DROP CONSTRAINT "FK_plan_prices_plan"`);
        await queryRunner.query(`DROP TABLE "billing_accounts"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_billing_subscriptions_user_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_billing_subscriptions_cancel_outbox"`);
        await queryRunner.query(`DROP TABLE "billing_subscriptions"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_plan_prices_current"`);
        await queryRunner.query(`DROP TABLE "plan_prices"`);
        await queryRunner.query(`DROP TABLE "plans"`);
    }

}
