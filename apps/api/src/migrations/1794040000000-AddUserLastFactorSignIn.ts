import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `last_factor_sign_in_at`: the last sign-in or re-authentication with a second factor.
 * A staff factor reset requested before it refuses to run, in case the cancel that
 * sign-in should have made failed. Null for every existing account, which changes
 * nothing for resets already waiting: their owners' sign-ins so far did cancel them.
 */
export class AddUserLastFactorSignIn1794040000000 implements MigrationInterface {
    name = 'AddUserLastFactorSignIn1794040000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "last_factor_sign_in_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "last_factor_sign_in_at"`);
    }
}
