import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAccountTokens1793794463400 implements MigrationInterface {
    name = 'AddAccountTokens1793794463400'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "account_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "purpose" character varying(32) NOT NULL, "token_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5e3640c493cc6206a44b885e6a9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_167033390a71c52224c7c636c8" ON "account_tokens" ("token_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_dc3fdc213b9bfc438a86fed443" ON "account_tokens" ("user_id", "purpose", "created_at") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "email_verified_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "account_tokens" ADD CONSTRAINT "FK_1b5fea09efc20c7f63c4a09b3d6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "account_tokens" DROP CONSTRAINT "FK_1b5fea09efc20c7f63c4a09b3d6"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email_verified_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dc3fdc213b9bfc438a86fed443"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_167033390a71c52224c7c636c8"`);
        await queryRunner.query(`DROP TABLE "account_tokens"`);
    }

}
