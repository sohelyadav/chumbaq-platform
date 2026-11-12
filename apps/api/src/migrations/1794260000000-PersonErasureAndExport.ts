import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Person erasure and export (DPDP). Design:
 * docs/superpowers/specs/2026-11-07-person-erasure-export.md.
 *
 * - `privacy_request_logs`: the fiduciary's record of each erasure and export,
 *   with keyed hashes of identifiers, never the identifiers.
 * - `erased_suppressions`: unsubscribes, bounces and complaints of erased
 *   people, kept as keyed hashes so the addresses stay unmessageable.
 * - Indexes for deleting a person's journey runs and segment memberships.
 * - `privacy` becomes the first enforced API key permission, and server-only.
 *   No key can have been meant to hold it before this, since it did not exist,
 *   so it is stripped from any key that was created with it as a free string.
 *   Down leaves it stripped: there is nothing to put back.
 */
export class PersonErasureAndExport1794260000000 implements MigrationInterface {
    name = 'PersonErasureAndExport1794260000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "privacy_request_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "kind" character varying(16) NOT NULL, "subject_type" character varying(24) NOT NULL, "identifier_hashes" character varying(64) array NOT NULL, "actor_type" character varying(16) NOT NULL, "actor_id" uuid, "result" character varying(24) NOT NULL, "counts" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8c518c88144868598ee794e73e9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e33b0f429fe09401a101dba030" ON "privacy_request_logs" ("project_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "erased_suppressions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "channel" character varying(10) NOT NULL, "address_hash" character varying(64) NOT NULL, "reason" character varying(20) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_75754fc24106e4a91f4d1f559b2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4819f7b3344215c9ab81a0aa5a" ON "erased_suppressions" ("project_id", "channel", "address_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_c088caaf3d5dad5346c4cfe8ac" ON "segment_members" ("project_id", "person_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_9ace4a9a81792ec9e6424156ad" ON "journey_runs" ("project_id", "person_key") `);
        await queryRunner.query(`ALTER TABLE "privacy_request_logs" ADD CONSTRAINT "FK_cbe0798877249add2d77316a211" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "erased_suppressions" ADD CONSTRAINT "FK_e3d47cf95e698fbccb874e257d5" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // simple-array: comma-separated text.
        await queryRunner.query(`UPDATE "api_keys" SET "permissions" = array_to_string(array_remove(string_to_array("permissions", ','), 'privacy'), ',') WHERE 'privacy' = ANY(string_to_array("permissions", ','))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "erased_suppressions" DROP CONSTRAINT "FK_e3d47cf95e698fbccb874e257d5"`);
        await queryRunner.query(`ALTER TABLE "privacy_request_logs" DROP CONSTRAINT "FK_cbe0798877249add2d77316a211"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9ace4a9a81792ec9e6424156ad"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c088caaf3d5dad5346c4cfe8ac"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4819f7b3344215c9ab81a0aa5a"`);
        await queryRunner.query(`DROP TABLE "erased_suppressions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e33b0f429fe09401a101dba030"`);
        await queryRunner.query(`DROP TABLE "privacy_request_logs"`);
    }
}
