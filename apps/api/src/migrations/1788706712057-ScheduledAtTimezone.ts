import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts scheduled_at from timestamp to timestamptz **in place**.
 *
 * TypeORM generates DROP COLUMN + ADD COLUMN for a type change, which would
 * erase the schedule from every pending campaign — leaving them in
 * `scheduled` with a null time, which the promotion sweep
 * (`scheduled_at <= now()`) can never satisfy, so they would sit there
 * forever. ALTER ... TYPE ... USING keeps the values.
 *
 * The existing values are wall-clock readings in the server's zone, so they
 * are interpreted in that zone to recover the instant each one meant.
 */
export class ScheduledAtTimezone1788706712057 implements MigrationInterface {
    name = 'ScheduledAtTimezone1788706712057'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "push_notification_logs"
            ALTER COLUMN "scheduled_at" TYPE TIMESTAMP WITH TIME ZONE
            USING "scheduled_at" AT TIME ZONE current_setting('TimeZone')
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "push_notification_logs"
            ALTER COLUMN "scheduled_at" TYPE TIMESTAMP
            USING "scheduled_at" AT TIME ZONE current_setting('TimeZone')
        `);
    }
}
