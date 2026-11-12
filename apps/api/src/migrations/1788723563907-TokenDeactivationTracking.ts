import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Records when and why a push token stopped being reachable.
 *
 * `updated_at` could not answer either question: it moves for any write to the
 * row, a `last_used_at` refresh included.
 *
 * Deliberately no backfill. Tokens already deactivated keep NULL, because
 * nothing in the table records when that happened or whether the provider
 * rejected them or the app asked — inventing a date would put fabricated
 * points on a churn chart. They are simply absent from the figures until they
 * either come back or are deactivated again.
 */
export class TokenDeactivationTracking1788723563907 implements MigrationInterface {
    name = 'TokenDeactivationTracking1788723563907'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "push_tokens" ADD "deactivated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "push_tokens" ADD "deactivation_reason" character varying(20)`);
        // Partial: nearly every row is live and holds NULL here, so indexing
        // those would cover most of the table to serve a query that only ever
        // reads the minority that are not.
        await queryRunner.query(`CREATE INDEX "IDX_e31303e85366fccd54588c1a52" ON "push_tokens" ("project_id", "deactivated_at") WHERE "deactivated_at" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_e31303e85366fccd54588c1a52"`);
        await queryRunner.query(`ALTER TABLE "push_tokens" DROP COLUMN "deactivation_reason"`);
        await queryRunner.query(`ALTER TABLE "push_tokens" DROP COLUMN "deactivated_at"`);
    }

}
