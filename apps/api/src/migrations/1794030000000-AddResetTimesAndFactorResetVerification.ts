import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `users.password_reset_at` and `users.factors_reset_at`: when the password was last
 * reset (by email or by a team admin) and when staff last removed every second factor.
 * Each guards the other for 14 days, and both are written in the transaction that makes
 * the change, rather than read from logs written after it.
 *
 * Both are filled from the history that existed until now, so a reset done just before
 * this lands is still guarded: password resets from `auth_events`, factor resets from
 * the `account.factors_reset` audit entries (the delayed reset and the CLI both write one).
 *
 * `factor_resets.verification_method` and `verification_notes`: how staff confirmed who
 * was asking. Nullable, because rows from before were never asked; the service requires
 * them on every new request.
 */
export class AddResetTimesAndFactorResetVerification1794030000000 implements MigrationInterface {
    name = 'AddResetTimesAndFactorResetVerification1794030000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "password_reset_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD "factors_reset_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "factor_resets" ADD "verification_method" character varying(32)`);
        await queryRunner.query(`ALTER TABLE "factor_resets" ADD "verification_notes" text`);

        await queryRunner.query(`
            UPDATE "users" u SET "password_reset_at" = e.at
              FROM (SELECT user_id, max(created_at) AS at FROM "auth_events"
                     WHERE type IN ('password.reset', 'password.reset_by_team') AND user_id IS NOT NULL
                     GROUP BY user_id) e
             WHERE e.user_id = u.id`);
        await queryRunner.query(`
            UPDATE "users" u SET "factors_reset_at" = a.at
              FROM (SELECT target_id, max(created_at) AS at FROM "admin_audit_logs"
                     WHERE action = 'account.factors_reset' AND target_id IS NOT NULL
                     GROUP BY target_id) a
             WHERE a.target_id = u.id`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "factor_resets" DROP COLUMN "verification_notes"`);
        await queryRunner.query(`ALTER TABLE "factor_resets" DROP COLUMN "verification_method"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "factors_reset_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_reset_at"`);
    }
}
