import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { RecoveryCodeEntity } from './entities/recovery-code.entity';
import { MfaCryptoService } from './mfa-crypto.service';
import { base32Encode } from './totp';

export const RECOVERY_CODE_COUNT = 10;
/** 80 bits, written as 16 base32 characters. NIST's minimum is 64. */
const RECOVERY_CODE_BYTES = 10;

/** So a code still works however someone copied it down. */
const normalise = (code: string) => code.replace(/[\s-]/g, '').toLowerCase();

const format = (code: string) => code.match(/.{4}/g)?.join('-') as string;

@Injectable()
export class RecoveryCodesService {
  constructor(
    @InjectRepository(RecoveryCodeEntity)
    private readonly repository: Repository<RecoveryCodeEntity>,
    private readonly crypto: MfaCryptoService,
  ) {}

  /** Every earlier code stops working. The returned codes exist nowhere else after this. */
  async replace(userId: string, manager: EntityManager): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      base32Encode(randomBytes(RECOVERY_CODE_BYTES)).toLowerCase(),
    );
    const repository = manager.getRepository(RecoveryCodeEntity);
    await repository.delete({ userId });
    await repository.insert(
      codes.map((code) => ({ userId, codeHash: this.crypto.hashRecoveryCode(userId, code) })),
    );
    return codes.map(format);
  }

  /** One conditional UPDATE, so of two simultaneous uses exactly one succeeds. */
  async consume(userId: string, code: string): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(RecoveryCodeEntity)
      .set({ usedAt: () => 'now()' })
      .where('user_id = :userId AND code_hash = :codeHash AND used_at IS NULL', {
        userId,
        codeHash: this.crypto.hashRecoveryCode(userId, normalise(code)),
      })
      .execute();
    return Boolean(result.affected);
  }

  remaining(userId: string): Promise<number> {
    return this.repository.count({ where: { userId, usedAt: IsNull() } });
  }

  async removeAll(userId: string, manager: EntityManager): Promise<void> {
    await manager.getRepository(RecoveryCodeEntity).delete({ userId });
  }
}
