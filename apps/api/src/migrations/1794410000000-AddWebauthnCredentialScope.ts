import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Which app a passkey signs in to. Staff keys are made on the admin app's host, a
 * different WebAuthn relying party from the customer app, so each side must look only
 * at its own. Every existing key was made in the customer app, so the default
 * 'customer' is true of all of them.
 */
export class AddWebauthnCredentialScope1794410000000 implements MigrationInterface {
    name = 'AddWebauthnCredentialScope1794410000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "webauthn_credentials" ADD "scope" character varying(16) NOT NULL DEFAULT 'customer'`);
        await queryRunner.query(`CREATE INDEX "IDX_5b3fcef9beaf1544078a041486" ON "webauthn_credentials" ("user_id", "scope") `);
        await queryRunner.query(`ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "CHK_0b1c1155c560d12840af8e131d" CHECK ("scope" IN ('customer', 'staff'))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "webauthn_credentials" DROP CONSTRAINT "CHK_0b1c1155c560d12840af8e131d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5b3fcef9beaf1544078a041486"`);
        await queryRunner.query(`ALTER TABLE "webauthn_credentials" DROP COLUMN "scope"`);
    }

}
