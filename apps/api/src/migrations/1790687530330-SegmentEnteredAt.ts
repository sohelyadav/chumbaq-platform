import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Records when a person joined a segment, so "entered this segment" can trigger
 * a journey.
 *
 * Only meaningful alongside the materialisation change that made membership a
 * differential update: while a refresh deleted and recreated every row, this
 * column would have been restamped every hour and said nothing.
 */
export class SegmentEnteredAt1790687530330 implements MigrationInterface {
    name = 'SegmentEnteredAt1790687530330'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "segment_members" ADD "entered_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`);

        // Existing members would otherwise all read as having joined at the
        // moment of this migration, and a segment-triggered journey already
        // running would treat the entire segment as new entrants and enrol it
        // in one go. `materialized_at` is the last time that person was
        // confirmed a member — not when they joined, but real data rather than
        // an invented instant, and old enough not to look like an arrival.
        await queryRunner.query(
            `UPDATE "segment_members" SET "entered_at" = "materialized_at"`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "segment_members" DROP COLUMN "entered_at"`);
    }

}
