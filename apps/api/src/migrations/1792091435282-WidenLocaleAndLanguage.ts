import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `device_identities.locale` and `language` from varchar(10) to
 * varchar(35).
 *
 * At 10 characters a genuine device locale did not fit: `en-US-POSIX` is a
 * real Apple locale identifier at 11, and a language-script-region tag with a
 * variant is longer again. The value reached the insert and came back as a
 * raw 500 (`value too long for type character varying(10)`), taking the whole
 * `identify` call with it — so one cosmetic field cost the device its
 * identity. 35 is the practical BCP-47 ceiling.
 *
 * **Written by hand because the generated version was destructive.** TypeORM
 * emitted `DROP COLUMN` + `ADD` for each column, which widens the type by
 * discarding every locale and language already stored. `ALTER COLUMN ... TYPE`
 * widens in place: Postgres does not rewrite the table for a varchar length
 * increase, and no value can fail to fit a larger ceiling, so no `USING`
 * clause is needed and nothing is lost. The same generator produced the same
 * destructive shape for `scheduled_at` — see the note in
 * `docs/push-notification-parity.md`.
 *
 * `down` narrows back to varchar(10), which **can** fail: any row storing
 * more than 10 characters by then blocks the revert. That is the honest
 * behaviour — silently truncating real locales to make a revert succeed would
 * destroy data to tidy up a rollback.
 */
export class WidenLocaleAndLanguage1792091435282 implements MigrationInterface {
  name = 'WidenLocaleAndLanguage1792091435282';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "device_identities" ALTER COLUMN "locale" TYPE character varying(35)`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_identities" ALTER COLUMN "language" TYPE character varying(35)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "device_identities" ALTER COLUMN "language" TYPE character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_identities" ALTER COLUMN "locale" TYPE character varying(10)`,
    );
  }
}
