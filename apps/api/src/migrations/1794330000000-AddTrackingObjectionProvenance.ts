import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Provenance on `tracking_objections`: `created_by` (the dashboard user who
 * made the person-level objection) and `source_identity_id` (the person-page
 * row it was made from). Both nullable and SET NULL on delete, so the
 * objection outlives the account or row that created it. Rows made before
 * this have neither (only the unmerged branch ever wrote any).
 */
export class AddTrackingObjectionProvenance1794330000000 implements MigrationInterface {
    name = 'AddTrackingObjectionProvenance1794330000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tracking_objections" ADD "created_by" uuid`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" ADD "source_identity_id" uuid`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" ADD CONSTRAINT "FK_1281c1757f4da9d53a296385632" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" ADD CONSTRAINT "FK_0da939f49162b942d1e3c5845ad" FOREIGN KEY ("source_identity_id") REFERENCES "device_identities"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tracking_objections" DROP CONSTRAINT "FK_0da939f49162b942d1e3c5845ad"`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" DROP CONSTRAINT "FK_1281c1757f4da9d53a296385632"`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" DROP COLUMN "source_identity_id"`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" DROP COLUMN "created_by"`);
    }

}
