import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A campaign's recipients move from jsonb id lists on the campaign row
 * (`target_device_ids`, `control_device_ids`) to `campaign_recipients`, one row per
 * device, so an audience has no size limit. Existing lists are copied first, keeping
 * only devices that still exist (the table's foreign key needs them). Adds the
 * (project_id, external_user_id) index a segment's fan-out to devices probes, and
 * keeps the statistics of the tables a send reads close to current.
 */
const STATS_TABLES = ['campaign_recipients', 'device_identities', 'push_tokens'];

export class CampaignRecipients1794490000007 implements MigrationInterface {
  name = 'CampaignRecipients1794490000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "campaign_recipients" ("campaign_id" uuid NOT NULL, "role" character varying(8) NOT NULL, "device_identity_id" uuid NOT NULL, CONSTRAINT "PK_2c185b35abbbde3ed401680d203" PRIMARY KEY ("campaign_id", "role", "device_identity_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_campaign_recipients_device" ON "campaign_recipients" ("device_identity_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "campaign_recipients" ADD CONSTRAINT "FK_37f67f778844dcc3a0d641a6173" FOREIGN KEY ("campaign_id") REFERENCES "push_notification_logs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "campaign_recipients" ADD CONSTRAINT "FK_8dd286c105190d2d3cb2ad518e9" FOREIGN KEY ("device_identity_id") REFERENCES "device_identities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    for (const [column, role] of [
      ['target_device_ids', 'target'],
      ['control_device_ids', 'control'],
    ]) {
      await queryRunner.query(
        `INSERT INTO campaign_recipients (campaign_id, role, device_identity_id)
         SELECT l.id, '${role}', d.id
           FROM push_notification_logs l
           CROSS JOIN LATERAL jsonb_array_elements_text(l.${column}) AS e(value)
           JOIN device_identities d ON d.id::text = e.value AND d.project_id = l.project_id
          WHERE jsonb_typeof(l.${column}) = 'array'
         ON CONFLICT DO NOTHING`,
      );
    }
    await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "target_device_ids"`);
    await queryRunner.query(`ALTER TABLE "push_notification_logs" DROP COLUMN "control_device_ids"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_device_identities_project_external_user" ON "device_identities" ("project_id", "external_user_id") `,
    );
    // Re-analysed after every 5,000 changed rows instead of a tenth of the table. These
    // tables are shared by every tenant, so a project that grows by tens of thousands of
    // rows can be a sliver of them, and until the statistics know about it the planner
    // takes it for a handful of rows and may scan it once per recipient.
    for (const table of STATS_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 5000)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of STATS_TABLES) {
      await queryRunner.query(`ALTER TABLE "${table}" RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold)`);
    }
    await queryRunner.query(`DROP INDEX "public"."IDX_device_identities_project_external_user"`);
    await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "control_device_ids" jsonb`);
    await queryRunner.query(`ALTER TABLE "push_notification_logs" ADD "target_device_ids" jsonb`);
    for (const [column, role] of [
      ['target_device_ids', 'target'],
      ['control_device_ids', 'control'],
    ]) {
      await queryRunner.query(
        `UPDATE push_notification_logs l
            SET ${column} = r.ids
           FROM (SELECT campaign_id, jsonb_agg(device_identity_id) AS ids
                   FROM campaign_recipients WHERE role = '${role}' GROUP BY campaign_id) r
          WHERE r.campaign_id = l.id`,
      );
    }
    await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP CONSTRAINT "FK_8dd286c105190d2d3cb2ad518e9"`);
    await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP CONSTRAINT "FK_37f67f778844dcc3a0d641a6173"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_campaign_recipients_device"`);
    await queryRunner.query(`DROP TABLE "campaign_recipients"`);
  }
}
