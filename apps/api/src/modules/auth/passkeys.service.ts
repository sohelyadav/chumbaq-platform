import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { IsNull, Not, QueryFailedError, Repository } from 'typeorm';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { UserEntity } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService, SignedIn } from './auth.service';
import { PasskeyScope, WebauthnCredentialEntity } from './entities/webauthn-credential.entity';
import { FactorChangeProofService } from './factor-change-proof.service';
import { MfaCryptoService } from './mfa-crypto.service';
import { PRE_AUTH_TTL_SECONDS, PreAuthService } from './pre-auth.service';
import { RecoveryCodesService } from './recovery-codes.service';
import { TotpSecretEntity } from './entities/totp-secret.entity';
import { RecoveryCodeEntity } from './entities/recovery-code.entity';
import { SessionsService } from './sessions.service';
import { assertSessionStillCurrent } from './session-still-current';
import { STAFF_KEEP_CUSTOMER_FACTOR_MESSAGE } from '../staff-auth/staff-messages';

/** Enough for every device someone owns, and a limit on what one account can store. */
export const MAX_PASSKEYS_PER_USER = 10;

const SIGN_IN_FAILED = 'Could not verify that passkey.';
const FLOW_EXPIRED = 'Your sign-in has expired. Please start again.';

export interface PasskeySummary {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface Principal {
  userId: string;
  email: string;
  sessionId?: string;
  sessionVersion?: number;
}

const summarise = (row: WebauthnCredentialEntity): PasskeySummary => ({
  id: row.id,
  name: row.name,
  deviceType: row.deviceType,
  backedUp: row.backedUp,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

/** What a passkey's `userHandle` must be: the account, never anything personal. */
const userHandleOf = (userId: string) => Buffer.from(userId, 'utf8');

/**
 * The relying party's side of WebAuthn. Challenges are held server-side and spent by
 * GETDEL, so each can answer one ceremony only.
 *
 * A signature counter going backwards is always refused. Synced passkeys report 0 and
 * never reach that check, so what it can refuse is a cloned device-bound key.
 */
@Injectable()
export class PasskeysService {
  private readonly logger = new Logger(PasskeysService.name);

  constructor(
    @InjectRepository(WebauthnCredentialEntity)
    private readonly credentials: Repository<WebauthnCredentialEntity>,
    private readonly users: UsersService,
    private readonly preAuth: PreAuthService,
    private readonly proofs: FactorChangeProofService,
    private readonly sessions: SessionsService,
    private readonly auth: AuthService,
    private readonly events: AuthEventsService,
    private readonly config: ConfigService,
    private readonly notices: SecurityNoticesService,
    private readonly recoveryCodes: RecoveryCodesService,
    private readonly mfaCrypto: MfaCryptoService,
  ) {}

  /**
   * Each scope has its own relying party: the customer app's host, or the admin app's
   * (`staff.webauthn`). A key is bound to the one it was made on.
   */
  relyingPartyFor(scope: PasskeyScope): { rpID: string; rpName: string; origins: string[] } {
    if (scope === 'staff') {
      const staff = this.config.getOrThrow<{ rpId: string; rpName: string; origins: string[] }>(
        'staff.webauthn',
      );
      return { rpID: staff.rpId, rpName: staff.rpName, origins: staff.origins };
    }
    return {
      rpID: this.config.getOrThrow<string>('webauthn.rpId'),
      rpName: this.config.getOrThrow<string>('webauthn.rpName'),
      origins: this.config.getOrThrow<string[]>('webauthn.origins'),
    };
  }

  private get relyingParty() {
    return this.relyingPartyFor('customer');
  }

  /** Staff keys must prove the user, not just their presence. */
  private userVerification(user: UserEntity): 'required' | 'preferred' {
    return user.isSuperAdmin ? 'required' : 'preferred';
  }

  private async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  /**
   * Two ways to plant a factor on an account you do not really own are shut here: an
   * unverified address, so nobody can register a stranger's email and wait for them to
   * claim it, and a team-created account, whose password its team admin knows.
   * Super admins are made by CLI, so they need neither email nor this flag. A tenant's
   * first key comes with recovery codes, which need the encryption key, because without
   * them a lost passkey would be a lost account.
   */
  private assertMayEnrol(user: UserEntity): void {
    if (user.managedByTeamId) {
      throw new ForbiddenException('Set your own password before adding a passkey.');
    }
    if (user.isSuperAdmin) return;
    if (!this.tenantsMayUsePasskeys) {
      throw new ForbiddenException('Passkeys are not available for this account yet.');
    }
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Verify your email address before adding a passkey.');
    }
  }

  private get tenantsMayUsePasskeys(): boolean {
    return Boolean(this.config.get<boolean>('webauthn.forTenants')) && this.mfaCrypto.isConfigured;
  }

  allowList(rows: WebauthnCredentialEntity[]) {
    return rows.map((row) => ({
      id: row.credentialId,
      transports: row.transports as AuthenticatorTransport[],
    }));
  }

  // ---- Managing

  /** Whoever else holds a session loses it, and the owner hears. */
  private async afterFactorChange(
    user: UserEntity,
    principal: Principal,
    change: 'added' | 'removed',
    name: string,
  ): Promise<void> {
    await this.sessions.revokeOthers(user.id, principal.sessionId as string);
    this.notices.passkeyChanged(user, change, name);
  }

  async list(userId: string): Promise<{ canEnrol: boolean; passkeys: PasskeySummary[] }> {
    const [user, rows] = await Promise.all([
      this.requireUser(userId),
      this.credentials.find({ where: { userId, scope: 'customer' }, order: { createdAt: 'ASC' } }),
    ]);
    let canEnrol = true;
    try {
      this.assertMayEnrol(user);
    } catch {
      canEnrol = false;
    }
    return { canEnrol, passkeys: rows.map(summarise) };
  }

  async registrationOptions(principal: Principal) {
    await this.proofs.assertHeld(principal);
    const user = await this.requireUser(principal.userId);
    this.assertMayEnrol(user);
    const existing = await this.credentials.find({ where: { userId: user.id, scope: 'customer' } });
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new ConflictException('This account has as many passkeys as it can hold.');
    }

    const { rpID, rpName } = this.relyingParty;
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: userHandleOf(user.id),
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: 'none',
      excludeCredentials: this.allowList(existing),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: this.userVerification(user),
      },
    });
    await this.preAuth.putChallenge('register', user.id, options.challenge);
    return options;
  }

  async register(
    principal: Principal,
    response: RegistrationResponseJSON,
    name: string | undefined,
    context: RequestContext = {},
  ): Promise<PasskeySummary & { recoveryCodes?: string[] }> {
    await this.proofs.spend(principal);
    const challenge = await this.preAuth.takeChallenge('register', principal.userId);
    if (!challenge) throw new BadRequestException('That took too long. Please try again.');

    const user = await this.requireUser(principal.userId);
    this.assertMayEnrol(user);

    const info = await this.verifyRegistration(response, challenge, 'customer', user.isSuperAdmin);

    try {
      const credential = info.credential;
      const { credentialDeviceType, credentialBackedUp } = info;
      // Together, and with the user locked, so a tenant never holds a key with no way back
      // in, and simultaneous first keys cannot each make a set of codes.
      const { row, recoveryCodes } = await this.credentials.manager.transaction(async (manager) => {
        // The checks above ran before this lock; a staff reset may have committed since.
        await assertSessionStillCurrent(manager, await this.users.findByIdForUpdate(user.id, manager), principal);
        const repository = manager.getRepository(WebauthnCredentialEntity);
        const saved = await repository.save(
          repository.create({
            userId: user.id,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: String(credential.counter),
            transports: credential.transports ?? [],
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            name: name?.trim() || 'Passkey',
            scope: 'customer',
          }),
        );
        const hasCodes = await manager.exists(RecoveryCodeEntity, {
          where: { userId: user.id, usedAt: IsNull() },
        });
        return {
          row: saved,
          recoveryCodes:
            user.isSuperAdmin || hasCodes ? undefined : await this.recoveryCodes.replace(user.id, manager),
        };
      });
      await this.events.record({
        type: 'passkey.added',
        userId: user.id,
        email: user.email,
        sessionId: principal.sessionId,
        ...context,
      });
      await this.afterFactorChange(user, principal, 'added', row.name);
      return { ...summarise(row), ...(recoveryCodes ? { recoveryCodes } : {}) };
    } catch (error) {
      if (error instanceof QueryFailedError) {
        throw new ConflictException('That passkey is already registered.');
      }
      throw error;
    }
  }

  async remove(principal: Principal, id: string, context: RequestContext = {}): Promise<void> {
    await this.proofs.spend(principal);
    // The user row is locked for the count and the delete, or two simultaneous removals
    // could each see room and leave staff below the minimum.
    const { user, removed } = await this.credentials.manager.transaction(async (manager) => {
      const owner = await this.users.findByIdForUpdate(principal.userId, manager);
      if (!owner) throw new UnauthorizedException('User not found');
      const repository = manager.getRepository(WebauthnCredentialEntity);
      // Customer settings never see or remove a staff key: those are managed in the
      // admin app, where the minimum-keys rule for staff is kept.
      const row = await repository.findOne({ where: { id, userId: owner.id, scope: 'customer' } });
      if (!row) throw new NotFoundException('Passkey not found');

      // The customer TOTP routes refuse super admins, so for them a customer key is the
      // only factor this app can remove. Removing the last one would leave the customer
      // account on a password alone, where before the split their keys always guarded it.
      if (owner.isSuperAdmin) {
        const [keys, totp] = await Promise.all([
          repository.count({ where: { userId: owner.id, scope: 'customer' } }),
          manager.exists(TotpSecretEntity, { where: { userId: owner.id, confirmedAt: Not(IsNull()) } }),
        ]);
        if (keys <= 1 && !totp) throw new ConflictException(STAFF_KEEP_CUSTOMER_FACTOR_MESSAGE);
      }
      await repository.delete({ id: row.id });
      // Recovery codes go with the last factor, since they would have nothing to recover.
      const factorsLeft =
        (await repository.count({ where: { userId: owner.id, scope: 'customer' } })) +
        (await manager.count(TotpSecretEntity, { where: { userId: owner.id } }));
      if (factorsLeft === 0) await manager.delete(RecoveryCodeEntity, { userId: owner.id });
      return { user: owner, removed: row };
    });
    await this.events.record({
      type: 'passkey.removed',
      userId: principal.userId,
      email: principal.email,
      sessionId: principal.sessionId,
      ...context,
    });
    await this.afterFactorChange(user, principal, 'removed', removed.name);
  }

  // ---- Using

  /**
   * Conditional on the counter moving forward, so a replayed or cloned assertion loses
   * even if two arrive at once. Never throws: every failure is simply not verified.
   */
  /**
   * Against the relying party of the key's own scope, so a key can only ever answer the
   * app it was made for, whichever route it was presented to.
   */
  async verifyAssertion(
    row: WebauthnCredentialEntity,
    response: AuthenticationResponseJSON,
    challenge: string,
    requireUserVerification: boolean,
  ): Promise<boolean> {
    const { rpID, origins } = this.relyingPartyFor(row.scope ?? 'customer');
    try {
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification,
        credential: {
          id: row.credentialId,
          publicKey: new Uint8Array(row.publicKey),
          counter: Number(row.counter),
          transports: row.transports as AuthenticatorTransport[],
        },
      });
      if (!verified) return false;

      const moved = await this.credentials
        .createQueryBuilder()
        .update(WebauthnCredentialEntity)
        .set({
          counter: String(authenticationInfo.newCounter),
          backedUp: authenticationInfo.credentialBackedUp,
          lastUsedAt: () => 'now()',
        })
        .where('id = :id AND (counter < :next OR :next = 0)', {
          id: row.id,
          next: authenticationInfo.newCounter,
        })
        .execute();
      return Boolean(moved.affected);
    } catch (error) {
      this.logger.warn(`Passkey assertion refused: ${(error as Error).message}`);
      return false;
    }
  }

  /** The key the browser presented, of this scope only: another scope's key reads as unknown. */
  findCredential(response: AuthenticationResponseJSON, scope: PasskeyScope, userId?: string) {
    if (typeof response?.id !== 'string') return Promise.resolve(null);
    return this.credentials.findOne({
      where: userId ? { credentialId: response.id, userId, scope } : { credentialId: response.id, scope },
    });
  }

  private findByBrowserId(response: AuthenticationResponseJSON, userId?: string) {
    return this.findCredential(response, 'customer', userId);
  }

  /**
   * Verifies a new key against the scope's relying party. Throws 400 if it does not
   * verify, or if it syncs between devices where staff keys must be device-bound
   * (unless SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS).
   */
  async verifyRegistration(
    response: RegistrationResponseJSON,
    challenge: string,
    scope: PasskeyScope,
    staffRules: boolean,
  ) {
    const { rpID, origins } = this.relyingPartyFor(scope);
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: staffRules,
      });
      info = result.verified ? result.registrationInfo : undefined;
    } catch (error) {
      // The reason stays here: it says what the verifier expected, and a mismatched
      // origin or RP ID in deployment config shows up nowhere else.
      this.logger.warn(`Passkey registration refused: ${(error as Error).message}`);
      info = undefined;
    }
    if (!info) throw new BadRequestException('Could not verify that passkey.');

    // A flag, not proof: with no attestation the device reports this about itself.
    if (
      staffRules &&
      info.credentialDeviceType === 'multiDevice' &&
      !this.config.get<boolean>('webauthn.superAdminAllowSynced')
    ) {
      throw new BadRequestException(
        'Staff accounts need a device-bound key, such as a hardware security key. ' +
          'This one syncs between devices. To allow that, set SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS.',
      );
    }
    return info;
  }

  /** After a correct password. The handle says whose keys to ask for. */
  async secondFactorOptions(handle: string, context: RequestContext = {}) {
    const state = await this.preAuth.peekFor(handle, 'customer');
    if (!state) throw new UnauthorizedException(FLOW_EXPIRED);
    const user = await this.requireUser(state.userId);
    await this.auth.assertUnderLoginLimit(user.email, context);

    const rows = await this.credentials.find({ where: { userId: user.id, scope: 'customer' } });
    const options = await generateAuthenticationOptions({
      rpID: this.relyingParty.rpID,
      allowCredentials: this.allowList(rows),
      userVerification: this.userVerification(user),
    });
    await this.preAuth.putChallenge('second-factor', handle, options.challenge);
    return options;
  }

  /**
   * After a password a touch is a valid second factor, so user verification is not
   * required: except for staff, whose keys must always verify the user. A wrong answer
   * spends the challenge but not the handle, and counts towards the sign-in limit.
   */
  async verifySecondFactor(
    handle: string,
    response: AuthenticationResponseJSON,
    context: RequestContext = {},
  ): Promise<SignedIn> {
    const state = await this.preAuth.peekFor(handle, 'customer');
    if (!state) throw new UnauthorizedException(FLOW_EXPIRED);
    const user = await this.requireUser(state.userId);
    await this.auth.assertUnderLoginLimit(user.email, context);

    const challenge = await this.preAuth.takeChallenge('second-factor', handle);
    if (!challenge) throw new UnauthorizedException(FLOW_EXPIRED);

    // Scoped to this user: someone else's valid passkey is not this account's factor.
    const row = await this.findByBrowserId(response, user.id);
    if (!row || !(await this.verifyAssertion(row, response, challenge, user.isSuperAdmin))) {
      await this.events.record({
        type: 'login.failed',
        userId: user.id,
        email: user.email,
        reason: 'passkey_failed',
        ...context,
      });
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    return this.auth.completeSecondFactor(handle, 'webauthn', context);
  }

  /** No email yet: the browser offers whichever passkeys it holds for this site. */
  async passwordlessOptions(timeout?: number) {
    const flowId = randomBytes(32).toString('base64url');
    const options = await generateAuthenticationOptions({
      rpID: this.relyingParty.rpID,
      userVerification: 'required',
      ...(timeout ? { timeout } : {}),
    });
    await this.preAuth.putChallenge('passwordless', flowId, options.challenge);
    return { flowId, options };
  }

  /**
   * The same flow as `passwordlessOptions`, answered by the same `verifyPasswordless`,
   * for the browser to offer passkeys in the email field's autofill. That request waits
   * on the page for as long as it is open, so the browser is told to give up when the
   * challenge does, rather than let someone pick a passkey for a flow already gone.
   *
   * Off while tenants cannot have passkeys: the sign-in page cannot know whose it is,
   * and every visitor would otherwise leave a challenge behind for the few staff, who
   * still have the button.
   */
  async autofillOptions() {
    if (!this.tenantsMayUsePasskeys) return { available: false as const };
    return { available: true as const, ...(await this.passwordlessOptions(PRE_AUTH_TTL_SECONDS * 1000)) };
  }

  /**
   * Stands in for both password and second factor, which is only sound because user
   * verification is required here. Failures do not count towards the address's limit:
   * a passkey cannot be guessed, and counting would let anyone who knows a credential
   * ID lock its owner out of password sign-in.
   */
  async verifyPasswordless(
    flowId: string,
    response: AuthenticationResponseJSON,
    context: RequestContext = {},
  ): Promise<SignedIn> {
    const challenge = await this.preAuth.takeChallenge('passwordless', flowId);
    if (!challenge) throw new UnauthorizedException(FLOW_EXPIRED);

    const row = await this.findByBrowserId(response);
    const user = row ? await this.users.findById(row.userId) : null;
    const handleMatches =
      user && response.response?.userHandle === userHandleOf(user.id).toString('base64url');
    if (!row || !user || !handleMatches || !(await this.verifyAssertion(row, response, challenge, true))) {
      await this.events.record({
        type: 'passkey.failed',
        userId: user?.id,
        email: user?.email,
        ...context,
      });
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    return this.auth.signInWithPasskey(user, context);
  }

  /** For `RecentAuthGuard`, on an account where a password alone is no longer enough. */
  async reauthOptions(principal: Principal) {
    const user = await this.requireUser(principal.userId);
    const rows = await this.credentials.find({ where: { userId: user.id, scope: 'customer' } });
    if (!principal.sessionId || rows.length === 0) {
      throw new ForbiddenException('This session cannot confirm with a passkey.');
    }
    const options = await generateAuthenticationOptions({
      rpID: this.relyingParty.rpID,
      allowCredentials: this.allowList(rows),
      userVerification: this.userVerification(user),
    });
    await this.preAuth.putChallenge('reauth', principal.sessionId, options.challenge);
    return options;
  }

  /** Answers failure with 403, for the reason `AuthService.reauthenticate` does. */
  async verifyReauth(
    principal: Principal,
    response: AuthenticationResponseJSON,
    context: RequestContext = {},
  ): Promise<{ accessToken: string }> {
    const user = await this.requireUser(principal.userId);
    const challenge = principal.sessionId
      ? await this.preAuth.takeChallenge('reauth', principal.sessionId)
      : null;
    if (!challenge) throw new ForbiddenException('That took too long. Please try again.');

    const row = await this.findByBrowserId(response, user.id);
    if (!row || !(await this.verifyAssertion(row, response, challenge, user.isSuperAdmin))) {
      await this.events.record({
        type: 'passkey.failed',
        userId: user.id,
        email: user.email,
        sessionId: principal.sessionId,
        reason: 'reauth',
        ...context,
      });
      throw new ForbiddenException(SIGN_IN_FAILED);
    }
    return this.auth.issueReauthenticatedToken(user, principal.sessionId as string, 'webauthn', context);
  }
}
