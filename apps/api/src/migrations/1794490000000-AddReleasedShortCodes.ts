import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Remembers the short code of every deleted link, with its project, so another
 * project cannot claim it and take over a URL that is still out in the world. The
 * trigger runs for every delete of a links row, including the cascade from deleting
 * a project, so no delete path can forget to record one. Codes of links deleted
 * before this migration were never recorded and stay free.
 */
export class AddReleasedShortCodes1794490000000 implements MigrationInterface {
    name = 'AddReleasedShortCodes1794490000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "released_short_codes" ("short_code" character varying(30) NOT NULL, "project_id" uuid NOT NULL, "released_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_released_short_codes" PRIMARY KEY ("short_code"))`);
        await queryRunner.query(`CREATE OR REPLACE FUNCTION "links_release_short_code"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO released_short_codes (short_code, project_id)
    VALUES (OLD.short_code, OLD.project_id)
    ON CONFLICT (short_code) DO NOTHING;
    RETURN OLD;
END;
$$`);
        await queryRunner.query(`CREATE TRIGGER "links_release_short_code" AFTER DELETE ON "links" FOR EACH ROW EXECUTE FUNCTION "links_release_short_code"()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "links_release_short_code" ON "links"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS "links_release_short_code"()`);
        await queryRunner.query(`DROP TABLE "released_short_codes"`);
    }
}
