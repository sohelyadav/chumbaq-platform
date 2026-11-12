import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `invitation_email_sends`: one row per invitation email Chumbaq attempted, by billing
 * account (the project's `owner_id`), so invite mail through the platform sender is
 * capped per account per rolling 24 hours (`INVITE_EMAILS_PER_DAY`). Rows go with the
 * account or the project; `InvitationsService` deletes an account's rows older than 7
 * days whenever it adds one.
 */
export class AddInvitationEmailSends1794440000001 implements MigrationInterface {
    name = 'AddInvitationEmailSends1794440000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "invitation_email_sends" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "billing_owner_id" uuid NOT NULL, "project_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_invitation_email_sends" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_invitation_email_sends_owner_created" ON "invitation_email_sends" ("billing_owner_id", "created_at") `);
        await queryRunner.query(`ALTER TABLE "invitation_email_sends" ADD CONSTRAINT "FK_invitation_email_sends_billing_owner" FOREIGN KEY ("billing_owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invitation_email_sends" ADD CONSTRAINT "FK_invitation_email_sends_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invitation_email_sends" DROP CONSTRAINT "FK_invitation_email_sends_project"`);
        await queryRunner.query(`ALTER TABLE "invitation_email_sends" DROP CONSTRAINT "FK_invitation_email_sends_billing_owner"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_invitation_email_sends_owner_created"`);
        await queryRunner.query(`DROP TABLE "invitation_email_sends"`);
    }

}
