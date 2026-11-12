import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `device_identities.do_not_track_source`: who last set `do_not_track`, `sdk`
 * or `dashboard`, so the SDK cannot clear a flag a team member set. Null on
 * existing rows: who set them was never recorded, so they stay clearable by
 * the SDK, as they were. Also refreshes planner statistics for
 * `tracking_objections`, read on every ingest call.
 */
export class AddDoNotTrackSource1794320000000 implements MigrationInterface {
    name = 'AddDoNotTrackSource1794320000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "device_identities" ADD "do_not_track_source" character varying(10)`);
        await queryRunner.query(`ANALYZE "tracking_objections"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "device_identities" DROP COLUMN "do_not_track_source"`);
    }

}
