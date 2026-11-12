import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a saved template carry the rich content a campaign already can.
 *
 * `push_templates` held title, body, image, deep link, data, silent,
 * delivery options and translations — enough for a text or image push and
 * nothing else. A campaign has carried action buttons, a carousel and a
 * countdown since RichPushContent, so a template could not reproduce the
 * three layouts those make possible, and "start from a template" silently
 * dropped them.
 *
 * Additive and nullable: every existing template keeps meaning exactly what
 * it meant, and `down` loses only what could not have been there before it.
 */
export class RichPushTemplates1792067340810 implements MigrationInterface {
  name = 'RichPushTemplates1792067340810';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "push_templates" ADD "actions" jsonb`);
    await queryRunner.query(`ALTER TABLE "push_templates" ADD "ios_category" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "push_templates" ADD "carousel" jsonb`);
    await queryRunner.query(`ALTER TABLE "push_templates" ADD "timer" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "push_templates" DROP COLUMN "timer"`);
    await queryRunner.query(`ALTER TABLE "push_templates" DROP COLUMN "carousel"`);
    await queryRunner.query(`ALTER TABLE "push_templates" DROP COLUMN "ios_category"`);
    await queryRunner.query(`ALTER TABLE "push_templates" DROP COLUMN "actions"`);
  }
}
