import { MigrationInterface, QueryRunner } from "typeorm";

/** The version of each project's identity secret (`IdentityVerificationService`). */
export class AddIdentityKeyVersion1794490000006 implements MigrationInterface {
    name = 'AddIdentityKeyVersion1794490000006'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD "identity_key_version" integer NOT NULL DEFAULT '1'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "identity_key_version"`);
    }
}
