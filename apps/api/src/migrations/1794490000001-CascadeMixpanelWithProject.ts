import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Mixpanel credentials, cohorts and cohort members named their project by a bare
 * column, so deleting a project left them behind and the hourly sync kept pulling the
 * deleted project's end users' profiles from Mixpanel with its stored credentials.
 * They now go with the project. Rows already orphaned by earlier deletes are removed
 * first (members before cohorts, which the member foreign key would cascade anyway).
 */
export class CascadeMixpanelWithProject1794490000001 implements MigrationInterface {
    name = 'CascadeMixpanelWithProject1794490000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "mixpanel_cohort_members" m WHERE NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = m."projectId")`);
        await queryRunner.query(`DELETE FROM "mixpanel_cohorts" c WHERE NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = c."projectId")`);
        await queryRunner.query(`DELETE FROM "mixpanel_configs" c WHERE NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = c."projectId")`);
        await queryRunner.query(`ALTER TABLE "mixpanel_configs" ADD CONSTRAINT "FK_598dd3e5201b5553c1f302ddd55" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mixpanel_cohorts" ADD CONSTRAINT "FK_a13a66d6df5ca5fd763c8fac1a3" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mixpanel_cohort_members" ADD CONSTRAINT "FK_d71a6a9257ec86d928dc248219c" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mixpanel_cohort_members" DROP CONSTRAINT "FK_d71a6a9257ec86d928dc248219c"`);
        await queryRunner.query(`ALTER TABLE "mixpanel_cohorts" DROP CONSTRAINT "FK_a13a66d6df5ca5fd763c8fac1a3"`);
        await queryRunner.query(`ALTER TABLE "mixpanel_configs" DROP CONSTRAINT "FK_598dd3e5201b5553c1f302ddd55"`);
    }
}
