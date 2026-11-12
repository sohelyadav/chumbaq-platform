import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAdminAuditLogFilterIndexes1793920000000 implements MigrationInterface {
    name = 'AddAdminAuditLogFilterIndexes1793920000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_95339234ee7f66b02187d19e10" ON "admin_audit_logs" ("actor_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_b7bd791291746de3ed1661478c" ON "admin_audit_logs" ("action", "created_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b7bd791291746de3ed1661478c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_95339234ee7f66b02187d19e10"`);
    }
}
