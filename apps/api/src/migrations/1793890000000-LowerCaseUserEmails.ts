import { MigrationInterface, QueryRunner } from "typeorm";

export class LowerCaseUserEmails1793890000000 implements MigrationInterface {
    name = 'LowerCaseUserEmails1793890000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Two accounts whose addresses differ only in case are two people's data, or one
        // person's twice. Which to keep is a decision for a person, so stop and say which.
        const clashes: { email: string; accounts: number }[] = await queryRunner.query(
            `SELECT lower(email) AS email, count(*)::int AS accounts FROM "users" GROUP BY lower(email) HAVING count(*) > 1`,
        );
        if (clashes.length > 0) {
            throw new Error(
                `These addresses belong to more than one account once lower-cased: ` +
                clashes.map((c) => `${c.email} (${c.accounts})`).join(', ') +
                `. Merge or rename them, then run the migration again.`,
            );
        }
        await queryRunner.query(`UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email")`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_email_lower_case" CHECK ("email" = lower("email"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_email_lower_case"`);
    }
}
