import { TripwiresService } from '../security-alerts/tripwires.service';
import { EMAIL_TAKEN_MESSAGE } from '../users/users.service';
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserEntity } from '../users/entities/user.entity';
import { AuthEventsService, RequestContext } from '../auth-events/auth-events.service';
import { SecurityNoticesService } from '../platform-email/security-notices.service';
import { noticeDevice, SessionAuth, SessionsService } from './sessions.service';
import { AccountRecoveryService } from './account-recovery.service';
import { FACTOR_CHANGE_PROOF, PreAuthService } from './pre-auth.service';
import { DEFAULT_REFRESH_LIFETIME_MS, DEFAULT_SESSION_MAX_AGE_MS } from '../../config/jwt.config';
import { SecondFactorMethod, SecondFactorsService } from './second-factors.service';
import { FactorResetsService } from '../factor-resets/factor-resets.service';
import type { ProfileBilling, ProfileStaffLink } from '@chumbaq/shared';
import type { BillingConfig } from '../../config/billing.config';
import { STAFF_KEYS_ONLY_MESSAGE } from '../staff-auth/staff-messages';
import { rateLimitKey } from '../../common/throttle-tracker';
import { logValue } from '../../common/log-value';
import { readSignupToken, signupKey } from './signup-token';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  type?: 'access' | 'refresh';
  /** `users.session_version` at issue. Absent on tokens from before this existed. */
  sv?: number;
  /** The `auth_sessions` row. Absent on tokens from before this existed. */
  sid?: string;
  /** Refresh tokens only: which rotation of the session this token is. */
  jti?: string;
  /** How the session proved who it is. Absent on tokens from before this existed. */
  amr?: string[];
  /** Seconds since epoch of the last real proof, which refreshing never moves. */
  auth_time?: number;
  /**
   * Access tokens only, and not trusted by the API: when the session reaches its maximum
   * length, and that length, both in seconds. The dashboard keeps them so it can say why
   * it was signed out once the refresh cookie has expired and the API cannot.
   */
  session_exp?: number;
  session_max_age?: number;
}

/** The 401 for a session past SESSION_MAX_AGE, matched exactly by the dashboard. */
export const SESSION_EXPIRED_MESSAGE = 'Session reached its maximum length';

export interface SignedIn {
  user: Partial<UserEntity>;
  tokens: AuthTokens;
  /** See `FactorResetPending` in @chumbaq/shared. Absent when false. */
  factorResetPending?: true;
  /** See `StaffLinkPending` in @chumbaq/shared. Absent when false. */
  staffLinkPending?: true;
}

/** What a re-authentication returns. */
export interface Reauthenticated {
  accessToken: string;
  factorResetPending?: true;
  staffLinkPending?: true;
}

export type LoginResult =
  | SignedIn
  | { requiresSecondFactor: true; handle: string; methods: SecondFactorMethod[] };

/** The same answer for every way a handle can be no good. */
export const INVALID_HANDLE_MESSAGE = 'Your sign-in has expired. Please start again.';

const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MINUTES = 15;
/** First-step attempts on one address from any number of networks in the window. */
const LOGIN_ATTEMPT_CEILING = 100;
const SECOND_FACTOR_FIELD = 'second-factor';
const SIGNUP_MAILS_PER_HOUR = 3;
export const SIGNUP_LINK_INVALID = 'This sign-up link has expired or was already used. Sign up again, or sign in.';

/** Compared against for an unknown address, so timing does not reveal which exist. */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hash('no-account-has-this-password', 12));

/** Spends as long as a real comparison, for an address with no account. Always false. */
export async function compareWithNobody(password: string): Promise<false> {
  await bcrypt.compare(password, await getDummyHash());
  return false;
}

const freshAuth = (amr: string[]): SessionAuth => ({ amr, authenticatedAt: new Date() });

/** Using any of these shows the account was never locked out, so a staff reset stops. */
const SECOND_FACTOR_AMR = new Set<string>(['webauthn', 'totp', 'recovery_code']);
const usesSecondFactor = (method: string) => SECOND_FACTOR_AMR.has(method);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessions: SessionsService,
    private readonly events: AuthEventsService,
    private readonly recovery: AccountRecoveryService,
    private readonly preAuth: PreAuthService,
    private readonly secondFactors: SecondFactorsService,
    private readonly notices: SecurityNoticesService,
    private readonly factorResets: FactorResetsService,
    private readonly tripwires: TripwiresService,
  ) {}

  /**
   * The first step of signing up: the same answer for every address, so the form tells
   * nobody which addresses have accounts. The account is made by `completeSignup` from
   * the link mailed to the address (`AccountRecoveryService.startSignup`), so whoever
   * holds the mailbox chooses the password. At most `SIGNUP_MAILS_PER_HOUR` mails per
   * address, so the form cannot be used to flood one inbox.
   */
  async register(dto: RegisterDto, context: RequestContext = {}): Promise<void> {
    const trap = await this.tripwires.findAccount(dto.email);
    // Counted for every address, a trap's too, so its answer takes no less time. Fails
    // closed: with Redis away no mail goes out (the answer is the same either way).
    let admitted = false;
    try {
      admitted = await this.preAuth.admitLimited('signup-mail', dto.email, SIGNUP_MAILS_PER_HOUR, 3600);
    } catch (error) {
      this.logger.error(`Sign-up mail not counted, so not sent: ${logValue((error as Error).message)}`);
    }
    if (trap) {
      // Not awaited, and no mail: answered exactly as any other address.
      void this.tripwires.trippedAccount(trap, 'sign_up', context.ipAddress ?? null);
      return;
    }
    if (admitted) this.recovery.startSignup(dto.email, dto.name);
  }

  /**
   * Makes the account a sign-up link names, with the password chosen now, its address
   * verified (the link came through the mailbox), and signs it in. Any link that is
   * forged, expired or already used (the address now has an account) gets the same 400.
   */
  async completeSignup(
    token: string,
    password: string,
    context: RequestContext = {},
  ): Promise<{ user: Partial<UserEntity>; tokens: AuthTokens }> {
    const claim = readSignupToken(signupKey(this.configService.getOrThrow<string>('jwt.secret')), token);
    if (!claim) throw new BadRequestException(SIGNUP_LINK_INVALID);
    const passwordHash = await bcrypt.hash(password, 12);
    let user: UserEntity;
    try {
      user = await this.usersService.create({ email: claim.email, name: claim.name, passwordHash, emailVerified: true });
    } catch (error) {
      if (error instanceof ConflictException) throw new BadRequestException(SIGNUP_LINK_INVALID);
      throw error;
    }

    const { tokens, sessionId } = await this.startSession(user, context, freshAuth(['pwd']));
    await this.events.record({
      type: 'register.succeeded',
      userId: user.id,
      email: user.email,
      sessionId,
      ...context,
    });
    return { user: this.sanitizeUser(user), tokens };
  }

  /**
   * Every factor counts against this, so no route can be used to guess free of it.
   *
   * Admits or refuses the attempt atomically in Redis before the guess is checked, so
   * attempts sent together are held to the limits exactly, and refused attempts are
   * not counted. A password (or other first step) is limited to `LOGIN_FAILURE_LIMIT`
   * per address from one network (an IPv6 /64 counts as one), so a stranger who knows
   * an address cannot lock its owner out from elsewhere, and to `LOGIN_ATTEMPT_CEILING`
   * per address from anywhere. A second factor (an authenticator or recovery code, a
   * passkey after a password) is limited to `LOGIN_FAILURE_LIMIT` per account from
   * anywhere: reaching it takes the password, and a code is far easier to guess. A
   * right password gives its attempt back, a complete sign-in clears the window, and
   * a step that is not a guess (passkey options) only checks. Fails open to the old
   * count of recorded failures if Redis is away.
   */
  async assertUnderLoginLimit(
    email: string,
    context: RequestContext = {},
    { count = true, secondFactor = false }: { count?: boolean; secondFactor?: boolean } = {},
  ): Promise<void> {
    const address = email.trim().toLowerCase();
    let admitted: boolean;
    try {
      admitted = await this.preAuth.admitSignInAttempt(
        address,
        secondFactor ? [{ field: SECOND_FACTOR_FIELD, limit: LOGIN_FAILURE_LIMIT }] : this.firstStepLimits(context),
        LOGIN_FAILURE_WINDOW_MINUTES * 60,
        count,
      );
    } catch (error) {
      this.logger.error(`Sign-in attempts not counted: ${logValue((error as Error).message)}`);
      admitted = (await this.events.recentLoginFailures(email, LOGIN_FAILURE_WINDOW_MINUTES)) < LOGIN_FAILURE_LIMIT;
    }
    if (!admitted) {
      await this.events.record({ type: 'login.limited', email, ...context });
      throw new HttpException(
        'Too many failed attempts. Try again in a few minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private firstStepLimits(context: RequestContext): Array<{ field: string; limit: number }> {
    return [
      { field: `net:${rateLimitKey(context.ipAddress ?? '')}`, limit: LOGIN_FAILURE_LIMIT },
      { field: 'total', limit: LOGIN_ATTEMPT_CEILING },
    ];
  }

  /**
   * Gives back the first-step attempt `assertUnderLoginLimit` counted, when the
   * password was right but sign-in is not complete yet (a second factor follows), so
   * only wrong guesses use up the allowance. Never throws.
   */
  async releaseLoginAttempt(email: string, context: RequestContext = {}): Promise<void> {
    try {
      await this.preAuth.releaseSignInAttempt(
        email.trim().toLowerCase(),
        this.firstStepLimits(context).map((limit) => limit.field),
      );
    } catch (error) {
      this.logger.error(`Sign-in attempt not released: ${logValue((error as Error).message)}`);
    }
  }

  /** Ends the address's sign-in window: see `assertUnderLoginLimit`. Never throws. */
  async clearLoginLimit(email: string): Promise<void> {
    try {
      await this.preAuth.clearSignInAttempts(email.trim().toLowerCase());
    } catch (error) {
      this.logger.error(`Sign-in attempts not cleared: ${logValue((error as Error).message)}`);
    }
  }

  async login(
    dto: LoginDto,
    context: RequestContext = {},
  ): Promise<LoginResult> {
    await this.assertUnderLoginLimit(dto.email, context);

    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      await bcrypt.compare(dto.password, await getDummyHash());
      await this.events.record({
        type: 'login.failed',
        email: dto.email,
        reason: 'unknown_email',
        ...context,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      await this.events.record({
        type: 'login.failed',
        userId: user.id,
        email: dto.email,
        reason: 'wrong_password',
        ...context,
      });
      throw new UnauthorizedException('Invalid email or password');
    }
    // The right password is no wrong guess, whatever comes next.
    await this.releaseLoginAttempt(dto.email, context);

    // After the password check, so only the holder of the password learns this
    // account exists and is suspended.
    if (user.suspendedAt) {
      await this.events.record({
        type: 'login.failed',
        userId: user.id,
        email: dto.email,
        reason: 'suspended',
        ...context,
      });
    }
    this.assertNotSuspended(user);
    // Staff links are voided by `finishSignIn`, not here: with a factor still to come,
    // the password alone does not show this is the owner.

    const methods = await this.secondFactors.methodsFor(user);
    if (methods.length > 0) {
      // No `login.succeeded` yet: that event lifts the failure limit, and knowing the
      // password alone must not.
      await this.events.record({
        type: 'login.password_accepted',
        userId: user.id,
        email: dto.email,
        ...context,
      });
      const handle = await this.preAuth.create({
        userId: user.id,
        sessionVersion: user.sessionVersion,
        amr: ['pwd'],
      });
      return { requiresSecondFactor: true, handle, methods };
    }
    // Only staff keys, which cannot answer here. Before the admin split the same keys
    // guarded this account too, so the password must not now be enough on its own.
    if (await this.secondFactors.hasAnyPasskey(user.id)) {
      await this.events.record({
        type: 'login.password_accepted',
        userId: user.id,
        email: dto.email,
        reason: 'staff_keys_only',
        ...context,
      });
      throw new ForbiddenException(STAFF_KEYS_ONLY_MESSAGE);
    }

    return this.finishSignIn(user, ['pwd'], context);
  }

  /**
   * The last step of a sign-in that needed a second factor. The caller has already
   * verified `factor`, using `preAuth.peek` to learn whose it should be. Spending the
   * handle here means a verified factor signs in once, however many arrive at once.
   */
  async completeSecondFactor(
    handle: string,
    factor: SecondFactorMethod,
    context: RequestContext = {},
  ): Promise<SignedIn> {
    const state = await this.preAuth.consumeFor(handle, 'customer');
    if (!state) throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);

    // Everything the password step checked can have changed in the five minutes since.
    const user = await this.usersService.findById(state.userId);
    if (!user || user.sessionVersion !== state.sessionVersion) {
      throw new UnauthorizedException(INVALID_HANDLE_MESSAGE);
    }
    this.assertNotSuspended(user);

    return this.finishSignIn(user, [...state.amr, factor], context);
  }

  private async finishSignIn(
    user: UserEntity,
    amr: string[],
    context: RequestContext,
  ): Promise<SignedIn> {
    const { tokens, sessionId } = await this.startSession(user, context, freshAuth(amr));
    await this.clearLoginLimit(user.email);
    await this.events.record({
      type: 'login.succeeded',
      userId: user.id,
      email: user.email,
      sessionId,
      ...context,
    });
    const usedFactor = amr.some(usesSecondFactor);
    const factorResetPending = usedFactor && (await this.factorResets.cancelOnFactorUse(user, context));
    // Every complete sign-in comes through here: the password on an account with no
    // factor, the password and its factor, or a passkey alone.
    const staffLinkPending = await this.factorResets.voidStaffLinksOnSignIn(
      user,
      usedFactor ? 'factor' : 'password',
      context,
    );
    this.notices.inBackground(async () => {
      if (await this.sessions.isNewDevice(user.id, sessionId, context.userAgent)) {
        await this.notices.newDevice(
          user,
          noticeDevice(context.userAgent),
          context.ipAddress,
        );
      }
    });
    return {
      user: this.sanitizeUser(user),
      tokens,
      ...(factorResetPending && { factorResetPending }),
      ...(staffLinkPending && { staffLinkPending }),
    };
  }

  /**
   * Proves it is still the same person, for actions behind `RecentAuthGuard`. Failures
   * count towards the sign-in limit, or a stolen session could guess the password here
   * free of it. Answers a wrong password with 403, because a 401 makes the web client
   * refresh and retry, and then sign the person out.
   *
   * An account with a second factor cannot do this with a password alone.
   */
  async reauthenticate(
    user: { userId: string; email: string; sessionId?: string },
    password: string,
    context: RequestContext = {},
  ): Promise<Reauthenticated> {
    await this.assertUnderLoginLimit(user.email, context);

    const account = await this.usersService.findById(user.userId);
    if (!account) throw new UnauthorizedException('User not found');

    // A stolen password must not be able to stand in for the factor it was backing up.
    if ((await this.secondFactors.methodsFor(account)).length > 0) {
      throw new ForbiddenException('Confirm with your second factor instead.');
    }
    if (await this.secondFactors.hasAnyPasskey(account.id)) {
      throw new ForbiddenException(STAFF_KEYS_ONLY_MESSAGE);
    }

    if (!(await bcrypt.compare(password, account.passwordHash))) {
      await this.events.record({
        type: 'login.failed',
        userId: account.id,
        email: user.email,
        sessionId: user.sessionId,
        reason: 'reauth_wrong_password',
        ...context,
      });
      throw new ForbiddenException('Incorrect password');
    }

    // Tokens from before sessions existed have no row to record this on.
    if (!user.sessionId) throw new UnauthorizedException('Session has been revoked');
    return this.issueReauthenticatedToken(account, user.sessionId, undefined, context);
  }

  /** The caller has verified the proof. */
  async issueReauthenticatedToken(
    user: UserEntity,
    sessionId: string,
    method: 'webauthn' | 'totp' | 'recovery_code' | undefined,
    context: RequestContext = {},
  ): Promise<Reauthenticated> {
    const auth = await this.sessions.markAuthenticated(sessionId, user.id, method);
    if (!auth) throw new UnauthorizedException('Session has been revoked');
    await this.preAuth.putChallenge(FACTOR_CHANGE_PROOF, sessionId, '1');

    await this.events.record({
      type: 'reauth.succeeded',
      userId: user.id,
      email: user.email,
      sessionId,
      reason: method ?? 'password',
      ...context,
    });
    const factorResetPending = Boolean(method) && (await this.factorResets.cancelOnFactorUse(user, context));
    // A complete proof either way: `reauthenticate` refuses a password alone on an
    // account with a factor.
    const staffLinkPending = await this.factorResets.voidStaffLinksOnSignIn(
      user,
      method ? 'factor' : 'password',
      context,
    );
    return {
      accessToken: await this.signAccessToken(user, sessionId, auth),
      ...(factorResetPending && { factorResetPending }),
      ...(staffLinkPending && { staffLinkPending }),
    };
  }

  /** The caller has verified a passkey that also verified the user. */
  async signInWithPasskey(user: UserEntity, context: RequestContext = {}): Promise<SignedIn> {
    this.assertNotSuspended(user);
    return this.finishSignIn(user, ['webauthn', 'uv'], context);
  }

  async refresh(refreshToken: string, context: RequestContext = {}): Promise<AuthTokens> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret(),
        algorithms: ['HS256'],
      });
    } catch {
      await this.events.record({ type: 'refresh.failed', reason: 'invalid_token', ...context });
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const refuse = async (reason: string, message = 'Invalid or expired refresh token') => {
      await this.events.record({
        type: 'refresh.failed',
        userId: payload.sub,
        email: payload.email,
        sessionId: payload.sid,
        reason,
        ...context,
      });
      return new UnauthorizedException(message);
    };

    if (payload.type !== 'refresh') throw await refuse('wrong_token_type', 'Invalid refresh token');

    const user = await this.usersService.findById(payload.sub);
    if (!user) throw await refuse('no_user', 'User not found');

    this.assertNotSuspended(user);

    if ((payload.sv ?? 0) !== user.sessionVersion) throw await refuse('session_version');

    // Every refresh token this key has signed names its session. One that does not was
    // made some other way.
    if (!payload.sid || !payload.jti) throw await refuse('no_session');

    const rotation = await this.sessions.rotate(
      payload.sid,
      user.id,
      payload.jti,
      this.sessionMaxAgeMs(),
    );
    if (rotation.outcome === 'revoked') throw await refuse('session_revoked');
    if (rotation.outcome === 'expired') throw await refuse('session_expired', SESSION_EXPIRED_MESSAGE);
    if (rotation.outcome === 'reused') {
      await this.events.record({
        type: 'refresh.reuse_detected',
        userId: user.id,
        email: user.email,
        sessionId: payload.sid,
        ...context,
      });
      this.notices.sessionReplayed(user);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.events.record({
      type: 'refresh.succeeded',
      userId: user.id,
      email: user.email,
      sessionId: payload.sid,
      reason: rotation.outcome === 'retried' ? 'retried_within_grace' : null,
      ...context,
    });
    return this.signTokens(user, payload.sid, rotation.jti, rotation, rotation.createdAt);
  }

  /** Ends this device's session, and its access token with it. */
  async logout(
    user: { userId: string; email: string; sessionId?: string },
    context: RequestContext = {},
  ): Promise<void> {
    if (user.sessionId) await this.sessions.revoke(user.sessionId, user.userId);
    await this.events.record({
      type: 'logout',
      userId: user.userId,
      email: user.email,
      sessionId: user.sessionId,
      ...context,
    });
  }

  /** Ends every session on every device, at their next request. */
  async logoutAll(
    user: { userId: string; email: string },
    context: RequestContext = {},
  ): Promise<void> {
    await this.usersService.revokeAllSessions(user.userId);
    await this.sessions.revokeAll(user.userId);
    await this.events.record({
      type: 'logout.all',
      userId: user.userId,
      email: user.email,
      ...context,
    });
  }

  /**
   * With `staffLinkPending`, so the dashboard can show a signed-in owner the cancel
   * banner while a reset link support issued is live. Always false for staff looking
   * through the account, who must not be shown, or nudged to cancel, the link.
   */
  async getProfile(
    userId: string,
    { impersonated = false }: { impersonated?: boolean } = {},
  ): Promise<Partial<UserEntity> & ProfileStaffLink & ProfileBilling> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const staffLinkPending = !impersonated && (await this.factorResets.staffLinkPending(user.id));
    // View-as never sees billing: the billing routes refuse it, and staff see billing in the admin app.
    const billingEnabled = !impersonated && this.configService.get<BillingConfig>('billing')?.enabled === true;
    return { ...this.sanitizeUser(user), staffLinkPending, billingEnabled };
  }

  private async startSession(
    user: UserEntity,
    context: RequestContext,
    auth: SessionAuth,
  ): Promise<{ tokens: AuthTokens; sessionId: string }> {
    const { sessionId, jti, createdAt } = await this.sessions.create(
      user.id,
      context,
      auth,
      user.sessionVersion,
    );
    return { tokens: await this.signTokens(user, sessionId, jti, auth, createdAt), sessionId };
  }

  private claims(user: UserEntity, sessionId: string, auth: SessionAuth) {
    return {
      sub: user.id,
      email: user.email,
      sv: user.sessionVersion,
      sid: sessionId,
      amr: auth.amr,
      ...(auth.authenticatedAt
        ? { auth_time: Math.floor(new Date(auth.authenticatedAt).getTime() / 1000) }
        : {}),
    };
  }

  private signAccessToken(
    user: UserEntity,
    sessionId: string,
    auth: SessionAuth,
    sessionEnd?: Pick<JwtPayload, 'session_exp' | 'session_max_age'>,
  ): Promise<string> {
    const payload: JwtPayload = {
      ...this.claims(user, sessionId, auth),
      ...sessionEnd,
      type: 'access',
    };
    return this.jwtService.signAsync(payload, {
      expiresIn: this.configService.get<string>('jwt.expiration', '15m'),
    });
  }

  private async signTokens(
    user: UserEntity,
    sessionId: string,
    jti: string,
    auth: SessionAuth,
    sessionCreatedAt: Date,
  ): Promise<AuthTokens> {
    // The refresh token's claims are not trusted later: `refresh` reads the session row.
    const refreshPayload: JwtPayload = {
      ...this.claims(user, sessionId, auth),
      type: 'refresh',
      jti,
    };

    // Never outliving the session, so the cookie, whose lifetime follows the token's,
    // goes when the session does.
    const maxAgeMs = this.sessionMaxAgeMs();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sessionExp = Math.floor((new Date(sessionCreatedAt).getTime() + maxAgeMs) / 1000);
    const refreshExp = Math.min(
      nowSeconds + Math.floor(
        this.configService.get<number>('jwt.refreshLifetimeMs', DEFAULT_REFRESH_LIFETIME_MS) / 1000,
      ),
      sessionExp,
    );

    const [accessToken, refreshToken] = await Promise.all([
      this.signAccessToken(user, sessionId, auth, {
        session_exp: sessionExp,
        session_max_age: Math.floor(maxAgeMs / 1000),
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret(),
        // In seconds. The database's clock decided the session is live, so if this one
        // runs a little ahead the token is still not issued already expired.
        expiresIn: Math.max(1, refreshExp - nowSeconds),
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private sessionMaxAgeMs(): number {
    return this.configService.get<number>('jwt.sessionMaxAgeMs', DEFAULT_SESSION_MAX_AGE_MS);
  }

  /**
   * Read every time and never defaulted: left undefined, `JwtService` would quietly sign
   * with the access key instead, and the two kinds of token would share one again.
   */
  private refreshSecret(): string {
    const secret = this.configService.get<string>('jwt.refreshSecret');
    if (!secret) throw new Error('jwt.refreshSecret is not configured');
    return secret;
  }

  private assertNotSuspended(user: UserEntity): void {
    if (user.suspendedAt) {
      throw new ForbiddenException('Account suspended');
    }
  }

  private sanitizeUser(user: UserEntity): Partial<UserEntity> {
    const { passwordHash, sessionVersion, ...sanitized } = user;
    // A freshly inserted row has no value here, and the client should see null.
    return { ...sanitized, emailVerifiedAt: user.emailVerifiedAt ?? null };
  }
}
