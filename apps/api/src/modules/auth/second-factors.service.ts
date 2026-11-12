import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import type { UserEntity } from '../users/entities/user.entity';
import { RecoveryCodeEntity } from './entities/recovery-code.entity';
import { TotpSecretEntity } from './entities/totp-secret.entity';
import { PasskeyScope, WebauthnCredentialEntity } from './entities/webauthn-credential.entity';

export type SecondFactorMethod = 'webauthn' | 'totp' | 'recovery_code';

/** So losing one key does not lock staff out, or send them to the CLI. */
export const MIN_SUPER_ADMIN_PASSKEYS = 2;

/** Which factors must follow a correct password, and can confirm it is still you later. */
@Injectable()
export class SecondFactorsService {
  constructor(
    @InjectRepository(WebauthnCredentialEntity)
    private readonly credentials: Repository<WebauthnCredentialEntity>,
    @InjectRepository(TotpSecretEntity)
    private readonly totpSecrets: Repository<TotpSecretEntity>,
    @InjectRepository(RecoveryCodeEntity)
    private readonly recoveryCodes: Repository<RecoveryCodeEntity>,
  ) {}

  passkeyCount(userId: string, scope: PasskeyScope): Promise<number> {
    return this.credentials.count({ where: { userId, scope } });
  }

  /** Of either scope: a staff member holding any passkey must not fall back to a password alone. */
  hasAnyPasskey(userId: string): Promise<boolean> {
    return this.credentials.existsBy({ userId });
  }

  /**
   * What staff sign-in on the admin app asks for after the password: staff-scope keys
   * (customer keys belong to another relying party and cannot answer there) and a
   * confirmed authenticator app. Never recovery codes.
   */
  async staffMethodsFor(userId: string): Promise<Array<'webauthn' | 'totp'>> {
    const [passkeys, totp] = await Promise.all([
      this.passkeyCount(userId, 'staff'),
      this.totpSecrets.existsBy({ userId, confirmedAt: Not(IsNull()) }),
    ]);
    const methods: Array<'webauthn' | 'totp'> = [];
    if (passkeys > 0) methods.push('webauthn');
    if (totp) methods.push('totp');
    return methods;
  }

  /**
   * The customer app's: customer-scope keys only, since staff keys cannot answer there.
   * An empty list while `hasAnyPasskey` is true means only staff keys: callers must then
   * refuse a password alone (STAFF_KEYS_ONLY_MESSAGE), not sign in with it.
   *
   * A super admin with a customer passkey is never offered their authenticator app here
   * (see `totpUsableByCustomer`).
   */
  async methodsFor(user: UserEntity): Promise<SecondFactorMethod[]> {
    const userId = user.id;
    const [passkeys, totp, codes] = await Promise.all([
      this.passkeyCount(userId, 'customer'),
      this.totpSecrets.existsBy({ userId, confirmedAt: Not(IsNull()) }),
      this.recoveryCodes.existsBy({ userId, usedAt: IsNull() }),
    ]);
    const methods: SecondFactorMethod[] = [];
    if (passkeys > 0) methods.push('webauthn');
    if (totp && !(user.isSuperAdmin && passkeys > 0)) methods.push('totp');
    // Never a way in by itself, and never one for staff.
    if (methods.length > 0 && codes && !user.isSuperAdmin) methods.push('recovery_code');
    return methods;
  }

  /**
   * Whether the customer app may take an authenticator code from this person. Not from a
   * super admin who holds a customer passkey: their app is enrolled in the admin app and
   * shared with it, and a phishing page can collect a code but cannot get a passkey to
   * sign for the wrong site, so taking the code here would undo the passkey. A super admin
   * with no customer passkey keeps the code, which is how one whose keys are all staff
   * ones signs in here at all.
   */
  async totpUsableByCustomer(user: Pick<UserEntity, 'id' | 'isSuperAdmin'>): Promise<boolean> {
    if (!user.isSuperAdmin) return true;
    return (await this.passkeyCount(user.id, 'customer')) === 0;
  }
}
