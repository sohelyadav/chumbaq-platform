import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Double opt-in for email: when the address holder confirmed from the mailed link, and
 * when that link was last sent (`DeviceIdentityEntity.emailConfirmedAt`).
 */
export class AddEmailConfirmation1794490000003 implements MigrationInterface {
    name = 'AddEmailConfirmation1794490000003'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "device_identities" ADD "email_confirmed_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "device_identities" ADD "email_confirm_sent_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "device_identities" DROP COLUMN "email_confirm_sent_at"`);
        await queryRunner.query(`ALTER TABLE "device_identities" DROP COLUMN "email_confirmed_at"`);
    }
}
