import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Keyed hashes of every address an erasure removed (`ErasedAddressEntity`), so a
 * suppression that arrives later for one of them is kept as a hash rather than storing
 * the erased person's address in clear again. Erasures before this migration recorded
 * none, which only means their late suppressions are stored as before.
 */
export class AddErasedAddresses1794490000002 implements MigrationInterface {
    name = 'AddErasedAddresses1794490000002'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "erased_addresses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "channel" character varying(20) NOT NULL, "address_hash" character varying(64) NOT NULL, "erased_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3d45c1493f6b7ed5d4f1d6b8253" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_427a5f298e766cda7de717084b" ON "erased_addresses" ("project_id", "channel", "address_hash") `);
        await queryRunner.query(`ALTER TABLE "erased_addresses" ADD CONSTRAINT "FK_57023e7f9ae2643c85b5253d1ea" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "erased_addresses" DROP CONSTRAINT "FK_57023e7f9ae2643c85b5253d1ea"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_427a5f298e766cda7de717084b"`);
        await queryRunner.query(`DROP TABLE "erased_addresses"`);
    }
}
