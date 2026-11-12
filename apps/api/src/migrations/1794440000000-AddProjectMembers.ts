import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Team roles: `project_members` (who works in a project, and as owner, admin or member)
 * and `project_invitations` (emailed offers to join). Also `users.seat_limit` (staff's
 * override of MAX_SEATS_PER_ACCOUNT) and the two columns that hold a pending offer of
 * billing ownership on `projects`.
 *
 * Every existing project gets one owner row from `projects.owner_id`. The older
 * `teams`, `team_members` and `managed_by_team_id` are deliberately kept: nothing here
 * reads or drops them.
 */
export class AddProjectMembers1794440000000 implements MigrationInterface {
    name = 'AddProjectMembers1794440000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" character varying(16) NOT NULL, "added_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_project_members_project_user" UNIQUE ("project_id", "user_id"), CONSTRAINT "CHK_project_members_role" CHECK ("role" IN ('owner', 'admin', 'member')), CONSTRAINT "PK_0b2f46f804be4aea9234c78bcc9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e89aae80e010c2faa72e6a49ce" ON "project_members" ("user_id") `);
        await queryRunner.query(`CREATE TABLE "project_invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "email" character varying(255) NOT NULL, "role" character varying(16) NOT NULL, "token_hash" character varying(64) NOT NULL, "invited_by" uuid, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE, "accepted_by" uuid, "revoked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_project_invitations_email_lower_case" CHECK ("email" = lower("email")), CONSTRAINT "CHK_project_invitations_role" CHECK ("role" IN ('owner', 'admin', 'member')), CONSTRAINT "PK_bddf504e527c1c64289e2c9cfd8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_31864b119bed75bb89a010fc25" ON "project_invitations" ("token_hash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_project_invitations_pending" ON "project_invitations" ("project_id", "email") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL`);
        await queryRunner.query(`ALTER TABLE "users" ADD "seat_limit" integer`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_seat_limit_not_negative" CHECK ("seat_limit" >= 0)`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "pending_billing_owner_id" uuid`);
        await queryRunner.query(`ALTER TABLE "projects" ADD "pending_billing_offered_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_b5729113570c20c7e214cf3f58d" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_members" ADD CONSTRAINT "FK_c9a0d7362410c69355c3773176b" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_invitations" ADD CONSTRAINT "FK_ff93e974f241ea13e6f7d5aa2d5" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_invitations" ADD CONSTRAINT "FK_1ad3a7cab9985a9974194a4cbba" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "project_invitations" ADD CONSTRAINT "FK_7e353b685a7a628357da004eef1" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "FK_04832c91755212691fada66cc2d" FOREIGN KEY ("pending_billing_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`INSERT INTO "project_members" ("project_id", "user_id", "role") SELECT "id", "owner_id", 'owner' FROM "projects" ON CONFLICT DO NOTHING`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_04832c91755212691fada66cc2d"`);
        await queryRunner.query(`ALTER TABLE "project_invitations" DROP CONSTRAINT "FK_7e353b685a7a628357da004eef1"`);
        await queryRunner.query(`ALTER TABLE "project_invitations" DROP CONSTRAINT "FK_1ad3a7cab9985a9974194a4cbba"`);
        await queryRunner.query(`ALTER TABLE "project_invitations" DROP CONSTRAINT "FK_ff93e974f241ea13e6f7d5aa2d5"`);
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_c9a0d7362410c69355c3773176b"`);
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_e89aae80e010c2faa72e6a49ce8"`);
        await queryRunner.query(`ALTER TABLE "project_members" DROP CONSTRAINT "FK_b5729113570c20c7e214cf3f58d"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "pending_billing_offered_at"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "pending_billing_owner_id"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_seat_limit_not_negative"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "seat_limit"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_project_invitations_pending"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_31864b119bed75bb89a010fc25"`);
        await queryRunner.query(`DROP TABLE "project_invitations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e89aae80e010c2faa72e6a49ce"`);
        await queryRunner.query(`DROP TABLE "project_members"`);
    }

}
