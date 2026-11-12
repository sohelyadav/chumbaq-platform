import { normaliseEmail } from './email';
import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserEntity } from './entities/user.entity';

const NEXT_SESSION_VERSION = () => 'session_version + 1';
/** Keeps the original moment if the address was already verified. */
const VERIFIED_NOW = () => 'COALESCE(email_verified_at, now())';
/** The database's clock, which the 14-day windows are measured by. */
const NOW = () => 'now()';

export const EMAIL_TAKEN_MESSAGE = 'A user with this email already exists';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { email: normaliseEmail(email) } });
  }

  async findById(id: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async create(data: {
    email: string;
    name: string;
    passwordHash: string;
    managedByTeamId?: string;
  }): Promise<UserEntity> {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      throw new ConflictException(EMAIL_TAKEN_MESSAGE);
    }

    const user = this.userRepository.create({ ...data, email: normaliseEmail(data.email) });
    return this.userRepository.save(user);
  }

  /**
   * A team admin setting a member's password. A column update rather than save():
   * saving a row read earlier could write back a stale suspended_at or is_super_admin.
   * `password_reset_at` goes in the same statement, because a staff factor reset is
   * refused on it and it must never miss a reset that happened.
   */
  async resetPasswordByTeam(id: string, passwordHash: string, manager: EntityManager): Promise<void> {
    await manager.getRepository(UserEntity).update(id, {
      passwordHash,
      sessionVersion: NEXT_SESSION_VERSION,
      passwordResetAt: NOW,
    });
  }

  /** The owner setting their own password takes the account back from any team. */
  async changeOwnPassword(id: string, passwordHash: string): Promise<void> {
    await this.userRepository.update(id, {
      passwordHash,
      managedByTeamId: null,
      sessionVersion: NEXT_SESSION_VERSION,
    });
  }

  /**
   * A reset through the account's mailbox. Proves control of the address, so it also
   * verifies it, and takes the account back from any team. `suspended_at` is left
   * alone: a reset never reactivates an account. `password_reset_at`: see
   * `resetPasswordByTeam`.
   */
  async resetPassword(id: string, passwordHash: string, manager: EntityManager): Promise<void> {
    await manager.getRepository(UserEntity).update(id, {
      passwordHash,
      managedByTeamId: null,
      sessionVersion: NEXT_SESSION_VERSION,
      emailVerifiedAt: VERIFIED_NOW,
      passwordResetAt: NOW,
    });
  }

  async markEmailVerified(id: string, manager: EntityManager): Promise<void> {
    await manager.getRepository(UserEntity).update(id, { emailVerifiedAt: VERIFIED_NOW });
  }

  /**
   * Holds the row until the transaction ends, so nothing changes it mid-decision. FOR
   * NO KEY UPDATE, which excludes every other locker just the same but lets foreign key
   * checks through: a transaction that holds a row another is waiting on, and then
   * inserts something naming this user, must not wait on this one too.
   */
  async findByIdForUpdate(id: string, manager: EntityManager): Promise<UserEntity | null> {
    return manager
      .getRepository(UserEntity)
      .findOne({ where: { id }, lock: { mode: 'for_no_key_update' } });
  }

  /** Ends every session the user has, on every device, at their next request. */
  async revokeAllSessions(id: string): Promise<void> {
    await this.userRepository.update(id, { sessionVersion: NEXT_SESSION_VERSION });
  }
}
