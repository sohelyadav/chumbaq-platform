import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `tracking_objections`: a do-not-track covering a whole person (every
 * identity with this external id), written only from a trusted source (the
 * dashboard). An SDK-set `device_identities.do_not_track` covers only its own
 * row, since SDK identity links are unverified claims. Keyed by its primary
 * key, which is what the per-ingest lookup in TrackingConsentService reads.
 * Holds the external id (personal data), so erasure must delete it.
 */
export class AddTrackingObjections1794310000000 implements MigrationInterface {
    name = 'AddTrackingObjections1794310000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tracking_objections" ("project_id" uuid NOT NULL, "external_user_id" character varying(255) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_59de228e90736be16373fce0570" PRIMARY KEY ("project_id", "external_user_id"))`);
        await queryRunner.query(`ALTER TABLE "tracking_objections" ADD CONSTRAINT "FK_80e07ea2fa8d440e83f22521855" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // Fresh statistics, so the per-ingest lookup is planned on the new
        // table at once rather than after the first autovacuum.
        await queryRunner.query(`ANALYZE "tracking_objections"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tracking_objections" DROP CONSTRAINT "FK_80e07ea2fa8d440e83f22521855"`);
        await queryRunner.query(`DROP TABLE "tracking_objections"`);
    }

}
