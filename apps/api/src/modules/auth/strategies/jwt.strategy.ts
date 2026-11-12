import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { SessionsService } from '../sessions.service';
import { StaffSessionsService } from '../staff-sessions.service';

export interface JwtPayload {
  sub: string;
  email: string;
  type: 'access' | 'refresh';
  /** Impersonation only: the super admin looking through `sub`'s eyes. */
  imp?: string;
  /** `users.session_version` of `sub` at issue. Absent on older tokens, read as 0. */
  sv?: number;
  /** Impersonation only: `users.session_version` of the super admin at issue. */
  impSv?: number;
  /**
   * Impersonation only: the staff session that asked for it. Required, so a view-as
   * ends when that staff session does (sign-out, revoke, its absolute end).
   */
  impSid?: string;
  /** Never on a customer token. Present on staff tokens, which are refused here. */
  aud?: string | string[];
  /** The `auth_sessions` row. Absent on older and impersonation tokens. */
  sid?: string;
  /** How the session proved who it is. Absent on older and impersonation tokens. */
  amr?: string[];
  /** Seconds since epoch of the last real proof, not of this token. Absent if unknown. */
  auth_time?: number;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  isSuperAdmin: boolean;
  impersonatedBy?: string;
  sessionId?: string;
  /** `sv` from the token, so code that adds a factor can recheck it under its lock. */
  sessionVersion?: number;
  amr?: string[];
  authTime?: number;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly sessions: SessionsService,
    private readonly staffSessions: StaffSessionsService,
  ) {
    const secret = configService.get<string>('jwt.secret');
    if (!secret) {
      throw new Error('jwt.secret is not configured');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<AuthenticatedUser> {
    // A staff token is signed with another key and fails before this, but its claims
    // are refused too, so the two never rest on one check.
    if (payload.type !== 'access' || payload.aud !== undefined) {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Read from the database on every request, so suspending an account ends
    // its live tokens at once rather than when they expire.
    if (user.suspendedAt) {
      throw new ForbiddenException('Account suspended');
    }

    // Holds no query of its own: the user row is already loaded for this request.
    if ((payload.sv ?? 0) !== user.sessionVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }

    // So signing a device out ends it now, and not when its access token expires. Older
    // and impersonation tokens have no row, and the version check above covers them.
    if (payload.sid && !(await this.sessions.isLive(payload.sid, payload.sub))) {
      throw new UnauthorizedException('Session has been revoked');
    }

    const authenticated: AuthenticatedUser = {
      userId: payload.sub,
      email: payload.email,
      isSuperAdmin: user.isSuperAdmin,
      sessionVersion: payload.sv ?? 0,
    };
    if (payload.sid) authenticated.sessionId = payload.sid;
    if (payload.amr) authenticated.amr = payload.amr;
    if (payload.auth_time !== undefined) authenticated.authTime = payload.auth_time;

    if (payload.imp) {
      await this.assertImpersonationStillAllowed(payload, user.isSuperAdmin);
      if (!READ_ONLY_METHODS.has(req.method)) {
        throw new ForbiddenException('Impersonation sessions are read-only');
      }
      authenticated.impersonatedBy = payload.imp;
    }

    return authenticated;
  }

  /**
   * The rules for issuing an impersonation token are rechecked for its whole
   * life, because any of them can stop holding within the 30 minutes it lasts.
   */
  private async assertImpersonationStillAllowed(
    payload: JwtPayload,
    targetIsSuperAdmin: boolean,
  ): Promise<void> {
    const actor = await this.usersService.findById(payload.imp as string);
    if (
      !actor ||
      actor.isSuperAdmin !== true ||
      actor.suspendedAt ||
      (payload.impSv ?? 0) !== actor.sessionVersion ||
      // Tokens from before the admin split have none and are refused; they lasted 30
      // minutes at most.
      typeof payload.impSid !== 'string' ||
      !(await this.staffSessions.isUsable(payload.impSid, actor.id))
    ) {
      throw new UnauthorizedException('Impersonation session is no longer valid');
    }
    if (targetIsSuperAdmin) {
      throw new UnauthorizedException('Impersonation session is no longer valid');
    }
  }
}
