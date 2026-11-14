import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * When each address was last mailed a double opt-in confirmation, per project, keyed by
 * a keyed hash of the address (`EmailConfirmationSendEntity`): the once-a-week limit
 * per address, whatever happens to the device rows holding it.
 */
export class AddEmailConfirmationSends1794490000005 implements MigrationInterface {
    name = 'AddEmailConfirmationSends1794490000005'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "email_confirmation_sends" ("project_id" uuid NOT NULL, "address_hash" character varying(64) NOT NULL, "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_49ff2987ed7edda6b83e4994d4d" PRIMARY KEY ("project_id", "address_hash"))`);
        await queryRunner.query(`ALTER TABLE "email_confirmation_sends" ADD CONSTRAINT "FK_51b7687424b0c9ae191a48e1570" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "email_confirmation_sends" DROP CONSTRAINT "FK_51b7687424b0c9ae191a48e1570"`);
        await queryRunner.query(`DROP TABLE "email_confirmation_sends"`);
    }
}
