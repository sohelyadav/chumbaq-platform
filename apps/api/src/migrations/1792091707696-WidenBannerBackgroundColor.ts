import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `banner_categories.background_color` from varchar(20) to varchar(32).
 *
 * 20 is too narrow for a valid CSS colour: a spaced
 * `rgba(255, 255, 255, 0.5)` is 24 characters. The dashboard emits the
 * compact form, so nothing stored today exceeds it — but the DTO's
 * `@MaxLength(20)`, added to match the column and stop an over-long value
 * reaching the insert as a 500, therefore refused input that is perfectly
 * legitimate. Widening the column is what makes that limit honest rather
 * than merely safe.
 *
 * **Hand-written, because the generated version was destructive** — and more
 * so than it looks. TypeORM emitted `DROP COLUMN` + `ADD ... NOT NULL DEFAULT
 * '#ffffff'`, which would not just discard every category's colour but
 * silently replace each one with the default, so the result is a table of
 * plausible white backgrounds rather than an obvious failure. `ALTER COLUMN
 * ... TYPE` widens in place; Postgres does not rewrite the table for a
 * varchar length increase, and no value can fail to fit a larger ceiling.
 * This is the second time today the generator produced this shape, after
 * `WidenLocaleAndLanguage`, and the third occurrence in the repo's history —
 * see the `scheduled_at` note in `docs/push-notification-parity.md`.
 *
 * `down` narrows back to varchar(20) and will fail rather than truncate if
 * any colour longer than that is stored by then, which is the honest
 * behaviour: a revert must not destroy data to tidy itself up.
 */
export class WidenBannerBackgroundColor1792091707696
  implements MigrationInterface
{
  name = 'WidenBannerBackgroundColor1792091707696';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "banner_categories" ALTER COLUMN "background_color" TYPE character varying(32)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "banner_categories" ALTER COLUMN "background_color" TYPE character varying(20)`,
    );
  }
}
