import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTotpAndRecoveryCodes1793870000000 implements MigrationInterface {
    name = 'AddTotpAndRecoveryCodes1793870000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "totp_secrets" ("user_id" uuid NOT NULL, "secret_ciphertext" text NOT NULL, "confirmed_at" TIMESTAMP WITH TIME ZONE, "last_used_step" bigint NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3e4fac76b4c0964c30c11c2fa8d" PRIMARY KEY ("user_id"))`);
        await queryRunner.query(`ALTER TABLE "totp_secrets" ADD CONSTRAINT "FK_3e4fac76b4c0964c30c11c2fa8d" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TABLE "recovery_codes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "code_hash" character varying(64) NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0723b9e53961e799027d7f7ba32" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d07c335ded337e58c4f36f234d" ON "recovery_codes" ("user_id", "code_hash") `);
        await queryRunner.query(`ALTER TABLE "recovery_codes" ADD CONSTRAINT "FK_fb82b2ac740ca095b617afad031" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "recovery_codes"`);
        await queryRunner.query(`DROP TABLE "totp_secrets"`);
    }
}
