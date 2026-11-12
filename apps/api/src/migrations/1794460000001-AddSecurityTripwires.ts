import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Tripwires: a fake API key, or an email address no real account uses. Only a SHA-256
 * of the key or of the lower-cased address is kept, so the table cannot give either
 * back. Never deleted, only revoked, so an alarm always has the trap it names.
 */
export class AddSecurityTripwires1794460000001 implements MigrationInterface {
    name = 'AddSecurityTripwires1794460000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "security_tripwires" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kind" character varying(16) NOT NULL, "value_hash" character(64) NOT NULL, "label" character varying(100) NOT NULL, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_security_tripwires_kind" CHECK ("kind" IN ('api_key', 'account')), CONSTRAINT "UQ_security_tripwires_value_hash" UNIQUE ("value_hash"), CONSTRAINT "PK_security_tripwires" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "security_tripwires"`);
    }

}
