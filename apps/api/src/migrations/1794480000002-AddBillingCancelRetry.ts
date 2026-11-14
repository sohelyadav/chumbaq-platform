import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * When the worker may next try an outbox cancel that failed. A cancel is retried
 * with a growing wait instead of being dropped after a fixed number of tries: a
 * dropped cancel leaves a subscription live at the provider, charging at its next
 * renewal. Null means try at the next run.
 */
export class AddBillingCancelRetry1794480000002 implements MigrationInterface {
    name = 'AddBillingCancelRetry1794480000002'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD "cancel_retry_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP COLUMN "cancel_retry_at"`);
    }
}
