import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { QueryFailedError, Repository } from 'typeorm';
import type { StaffEnrolled, StaffReauthenticated } from '@chumbaq/shared';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { INVALID_HANDLE_MESSAGE } from '../auth/auth.service';
import { WebauthnCredentialEntity } from '../auth/entities/webauthn-credential.entity';
import { MAX_PASSKEYS_PER_USER, PasskeysService } from '../auth/passkeys.service';
import { PreAuthService } from '../auth/pre-auth.service';
import { MIN_SUPER_ADMIN_PASSKEYS } from '../auth/second-factors.service';
import { UsersService } from '../users/users.service';
import type { AuthenticatedStaff } from './staff-principal';
import { StaffAuthService, StaffSignInResult } from './staff-auth.service';
import { StaffFactorsService, staffFactorCount } from './staff-factors.service';
import {
  PASSKEY_NOT_RECOGNISED_MESSAGE,
  STAFF_LAST_FACTOR_MESSAGE,
  STAFF_SESSION_ENDED_MESSAGE,
} from './staff-messages';

const SIGN_IN_FAILED = 'Could not verify that passkey.';
const TOO_SLOW = 'That took too long. Please try again.';

/** Challenges live in the same Redis as the customer app's, under names of their own. */
const CEREMONY = {
  secondFactor: 'staff-second-factor',
  passwordless: 'staff-passwordless',
  reauth: 'staff-reauth',
  register: 'staff-register',
} as const;

/** What a passkey's `userHandle` must be: the account, never anything personal. */
const userHandleOf = (userId: string) => Buffer.from(userId, 'utf8');

/**
 * Staff passkeys: `scope = 'staff'` keys on the admin app's relying party
 * (`staff.webauthn`). Verification itself is `PasskeysService`'s, which checks each key
 * against its own scope's relying party, so a customer key cannot answer here even if
 * presented. Staff keys always verify the user and are device-bound unless
 * SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS.
 */
@Injectable()
export class StaffPasskeysService {
  constructor(
    @InjectRepository(WebauthnCredentialEntity)
    private readonly credentials: Repository<WebauthnCredentialEntity>,
    private readonly passkeys: PasskeysService,
    private readonly preAuth: PreAuthService,
    private readonly users: UsersService,
    private readonly staffAuth: StaffAuthService,
    private readonly factors: StaffFactorsService,
    private readonly events: AuthEventsService,
    private readonly config: ConfigService,
  ) {}

  private get rpID(): string {
    return this.passkeys.relyingPartyFor('staff').rpID;
  }

  private staffKeys(userId: string) {
    return this.credentials.find({ where: { userId, scope: 'staff' }, order: { createdAt: 'ASC' } });
  }

  // ---- Signing in

  /** After the password: the handle says whose staff keys to ask for. */
  async secondFactorOptions(handle: string, context: RequestContext = {}) {
    const user = await this.staffAuth.pendingUser(handle, context);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: this.passkeys.allowList(await this.staffKeys(user.id)),
      userVerification: 'required',
    });
    await this.preAuth.putChallenge(CEREMONY.secondFactor, handle, options.challenge);
    return { options };
  }

  /** A wrong answer spends the challenge but not the handle, and counts towards the limit. */
  async verifySecondFactor(
    handle: string,
    response: AuthenticationResponseJSON,
    context: RequestContext = {},
  ): Promise<StaffSignInResult> {
    const user = await this.staffAuth.pendingUser(handle, context);
    const challenge = await this.preAuth.takeChallenge(CEREMONY.secondFactor, handle);
    if (!challenge) throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);

    const row = await this.passkeys.findCredential(response, 'staff', user.id);
    if (!row || !(await this.passkeys.verifyAssertion(row, response, challenge, true))) {
      await this.events.record({
        type: 'login.failed',
        userId: user.id,
        email: user.email,
        reason: 'passkey_failed',
        ...context,
      });
      await this.staffAuth.auditFailure(user, 'passkey_failed', context);
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    return this.staffAuth.completeSecondFactor(handle, 'webauthn', context);
  }

  /** No email yet: the browser offers whichever keys it holds for the admin host. */
  async passwordlessOptions() {
    const ceremonyId = randomBytes(32).toString('base64url');
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'required' });
    await this.preAuth.putChallenge(CEREMONY.passwordless, ceremonyId, options.challenge);
    return { ceremonyId, options };
  }

  /**
   * Stands in for password and second factor, which is only sound because user
   * verification is required. Only a staff key of a current super admin; anything else
   * is the same 401. Failures do not count towards the address's limit: a passkey cannot
   * be guessed, and counting would let anyone who knows a credential ID lock its owner
   * out of password sign-in.
   */
  async verifyPasswordless(
    ceremonyId: string,
    response: AuthenticationResponseJSON,
    context: RequestContext = {},
  ): Promise<StaffSignInResult> {
    const challenge = await this.preAuth.takeChallenge(CEREMONY.passwordless, ceremonyId);
    if (!challenge) throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);

    const row = await this.passkeys.findCredential(response, 'staff');
    const user = row ? await this.users.findById(row.userId) : null;
    const handleMatches =
      user && response.response?.userHandle === userHandleOf(user.id).toString('base64url');
    if (
      !row ||
      !user ||
      !handleMatches ||
      user.isSuperAdmin !== true ||
      user.suspendedAt ||
      !(await this.passkeys.verifyAssertion(row, response, challenge, true))
    ) {
      await this.events.record({
        type: 'passkey.failed',
        userId: user?.id,
        email: user?.email,
        reason: 'staff_passwordless',
        ...context,
      });
      throw new UnauthorizedException(PASSKEY_NOT_RECOGNISED_MESSAGE);
    }
    return this.staffAuth.finishSignIn(user, ['webauthn', 'uv'], context);
  }

  // ---- Re-authentication

  async reauthOptions(staff: AuthenticatedStaff) {
    const rows = await this.staffKeys(staff.userId);
    if (rows.length === 0) throw new ForbiddenException('This session cannot confirm with a passkey.');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: this.passkeys.allowList(rows),
      userVerification: 'required',
    });
    await this.preAuth.putChallenge(CEREMONY.reauth, staff.sessionId, options.challenge);
    return { options };
  }

  /** Failure is 403, for the reason `StaffAuthService.reauthWithTotp` gives. */
  async verifyReauth(
    staff: AuthenticatedStaff,
    response: AuthenticationResponseJSON,
    context: RequestContext = {},
  ): Promise<StaffReauthenticated> {
    const user = await this.factors.requireUser(staff.userId);
    const challenge = await this.preAuth.takeChallenge(CEREMONY.reauth, staff.sessionId);
    if (!challenge) throw new ForbiddenException(TOO_SLOW);

    const row = await this.passkeys.findCredential(response, 'staff', user.id);
    if (!row || !(await this.passkeys.verifyAssertion(row, response, challenge, true))) {
      await this.events.record({
        type: 'passkey.failed',
        userId: user.id,
        email: user.email,
        sessionId: staff.sessionId,
        reason: 'staff_reauth',
        ...context,
      });
      await this.staffAuth.auditFailure(user, 'reauth_passkey_failed', context);
      throw new ForbiddenException(SIGN_IN_FAILED);
    }
    return this.staffAuth.issueReauthenticated(staff, user, 'webauthn', context);
  }

  // ---- Managing

  async registrationOptions(staff: AuthenticatedStaff) {
    await this.factors.assertMayAdd(staff, false, 'webauthn');
    const user = await this.factors.requireUser(staff.userId);
    const existing = await this.staffKeys(user.id);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new ConflictException('This account has as many passkeys as it can hold.');
    }
    const { rpID, rpName } = this.passkeys.relyingPartyFor('staff');
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: userHandleOf(user.id),
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: 'none',
      excludeCredentials: this.passkeys.allowList(existing),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await this.preAuth.putChallenge(CEREMONY.register, staff.sessionId, options.challenge);
    return { options };
  }

  async register(
    staff: AuthenticatedStaff,
    response: RegistrationResponseJSON,
    name: string,
    context: RequestContext = {},
  ): Promise<StaffEnrolled> {
    await this.factors.assertMayAdd(staff, true, 'webauthn');
    const challenge = await this.preAuth.takeChallenge(CEREMONY.register, staff.sessionId);
    if (!challenge) throw new BadRequestException(TOO_SLOW);
    const info = await this.passkeys.verifyRegistration(response, challenge, 'staff', true);

    let user;
    try {
      user = await this.credentials.manager.transaction(async (manager) => {
        // The checks above ran before this lock; a reset or revoke may have committed since.
        const locked = await this.factors.assertStillCurrent(manager, staff);
        const repository = manager.getRepository(WebauthnCredentialEntity);
        if ((await repository.count({ where: { userId: locked.id, scope: 'staff' } })) >= MAX_PASSKEYS_PER_USER) {
          throw new ConflictException('This account has as many passkeys as it can hold.');
        }
        await repository.insert({
          userId: locked.id,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: String(info.credential.counter),
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          name: name.trim() || 'Passkey',
          scope: 'staff',
        });
        await this.factors.clearEnrolmentAllowance(manager, locked.id);
        await this.factors.endSessionsForAdd(manager, staff);
        return locked;
      });
    } catch (error) {
      if (error instanceof QueryFailedError) throw new ConflictException('That passkey is already registered.');
      throw error;
    }
    return this.factors.afterAdded(staff, user, 'webauthn', name.trim() || 'Passkey', context);
  }

  async remove(staff: AuthenticatedStaff, id: string, context: RequestContext = {}): Promise<void> {
    await this.factors.assertMayRemove(staff);
    const { user, removed } = await this.credentials.manager.transaction(async (manager) => {
      const owner = await this.users.findByIdForUpdate(staff.userId, manager);
      if (!owner) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
      const repository = manager.getRepository(WebauthnCredentialEntity);
      const row = await repository.findOne({ where: { id, userId: owner.id, scope: 'staff' } });
      if (!row) throw new NotFoundException('Passkey not found');
      const { passkeys, totp } = await staffFactorCount(manager, owner.id);
      if (passkeys + (totp ? 1 : 0) <= 1) throw new ConflictException(STAFF_LAST_FACTOR_MESSAGE);
      if (this.config.get<boolean>('webauthn.superAdminPasskeyRequired') && passkeys <= MIN_SUPER_ADMIN_PASSKEYS) {
        throw new ConflictException(
          `Staff accounts must keep ${MIN_SUPER_ADMIN_PASSKEYS} passkeys. Add another before removing this one.`,
        );
      }
      await repository.delete({ id: row.id });
      return { user: owner, removed: row };
    });
    await this.factors.afterRemoved(staff, user, 'webauthn', removed.name, context);
  }
}
