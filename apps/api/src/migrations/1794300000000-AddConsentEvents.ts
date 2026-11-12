import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `consent_events`: an append-only history of consent changes per identity
 * (channel, granted, source, when), so the fiduciary can show when consent was
 * given and withdrawn (DPDP Act s.6(10)). Written by `ConsentEventsService`
 * only. Rows cascade with their identity and project, so erasing a person
 * erases their history. Starts empty: changes before this migration left only
 * `device_identities.consent_updated_at`, which says when, not what.
 */
export class AddConsentEvents1794300000000 implements MigrationInterface {
    name = 'AddConsentEvents1794300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "consent_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "device_identity_id" uuid NOT NULL, "channel" character varying(20) NOT NULL, "granted" boolean NOT NULL, "source" character varying(32) NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_40ecc066035b8a4e5a6dcdfb46e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_78d666b17d7c5dfb733647c177" ON "consent_events" ("project_id", "device_identity_id", "occurred_at") `);
        await queryRunner.query(`ALTER TABLE "consent_events" ADD CONSTRAINT "FK_0902b415f7e46df8051974e72b2" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "consent_events" ADD CONSTRAINT "FK_99d7a78e311b6be0056027dc523" FOREIGN KEY ("device_identity_id") REFERENCES "device_identities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "consent_events" DROP CONSTRAINT "FK_99d7a78e311b6be0056027dc523"`);
        await queryRunner.query(`ALTER TABLE "consent_events" DROP CONSTRAINT "FK_0902b415f7e46df8051974e72b2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_78d666b17d7c5dfb733647c177"`);
        await queryRunner.query(`DROP TABLE "consent_events"`);
    }

}
