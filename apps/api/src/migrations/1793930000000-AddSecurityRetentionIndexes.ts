import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSecurityRetentionIndexes1793930000000 implements MigrationInterface {
    name = 'AddSecurityRetentionIndexes1793930000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // For SecurityRetentionScheduler's deletes. auth_events' existing indexes lead with
        // user_id and email, so neither serves a range over created_at alone.
        await queryRunner.query(`CREATE INDEX "IDX_64ac9bded13b2b6b75b128d8e5" ON "auth_events" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_4986dc4cff339e47577ce74582" ON "auth_sessions" ("revoked_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_bd53afff66d00f2483c6a1973e" ON "auth_sessions" ("last_used_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_be5e41138d1874b8c512fe2f0c" ON "account_tokens" ("expires_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_3b6ae8d8b853d0b4f14f86293d" ON "account_tokens" ("used_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_3b6ae8d8b853d0b4f14f86293d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_be5e41138d1874b8c512fe2f0c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bd53afff66d00f2483c6a1973e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4986dc4cff339e47577ce74582"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_64ac9bded13b2b6b75b128d8e5"`);
    }
}
