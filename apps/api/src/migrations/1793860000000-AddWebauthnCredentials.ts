import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWebauthnCredentials1793860000000 implements MigrationInterface {
    name = 'AddWebauthnCredentials1793860000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "webauthn_credentials" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "credential_id" character varying(1024) NOT NULL, "public_key" bytea NOT NULL, "counter" bigint NOT NULL DEFAULT '0', "transports" jsonb NOT NULL DEFAULT '[]', "device_type" character varying(32) NOT NULL, "backed_up" boolean NOT NULL, "name" character varying(64) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_webauthn_credentials" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cf9dd4c89545f22418bfcec368" ON "webauthn_credentials" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8292f27b760a80388601db2d42" ON "webauthn_credentials" ("credential_id") `);
        await queryRunner.query(`ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "FK_cf9dd4c89545f22418bfcec368e" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "webauthn_credentials"`);
    }
}
