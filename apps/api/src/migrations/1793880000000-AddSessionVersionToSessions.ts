import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionVersionToSessions1793880000000 implements MigrationInterface {
    name = 'AddSessionVersionToSessions1793880000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "auth_sessions" ADD "session_version" integer NOT NULL DEFAULT '0'`);
        // Rows from before this column cannot say which version they began under. Taking
        // the current one keeps every live session listed; a row already ended by a version
        // change shows until its refresh token expires, and signing it out is harmless.
        await queryRunner.query(`UPDATE "auth_sessions" s SET "session_version" = u."session_version" FROM "users" u WHERE u."id" = s."user_id" AND s."revoked_at" IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "auth_sessions" DROP COLUMN "session_version"`);
    }
}
