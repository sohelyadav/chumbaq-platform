import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DNS proof of a project's domain (`ProjectDomainsService`): when it was proved, the
 * token the TXT record must carry, and one verified project per domain. Existing
 * projects get a token and start unverified.
 */
export class AddDomainVerification1794490000004 implements MigrationInterface {
    name = 'AddDomainVerification1794490000004'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD "domain_verified_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "domain_verification_token" character varying(64)`);
        await queryRunner.query(`UPDATE "projects" SET "domain_verification_token" = md5(random()::text || "id"::text) WHERE "domain_verification_token" IS NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_projects_verified_domain" ON "projects" ("domain") WHERE "domain_verified_at" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."UQ_projects_verified_domain"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "domain_verification_token"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "domain_verified_at"`);
    }
}
