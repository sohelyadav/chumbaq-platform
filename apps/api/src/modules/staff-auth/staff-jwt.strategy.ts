import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { StaffSessionsService } from '../auth/staff-sessions.service';
import {
  STAFF_TOKEN_AUDIENCE,
  STAFF_TOKEN_TYPE,
  StaffAccessClaims,
  StaffTokensService,
} from '../auth/staff-tokens.service';
import { UsersService } from '../users/users.service';
import type { AuthenticatedStaff } from './staff-principal';
import { STAFF_SESSION_ENDED_MESSAGE, STAFF_SESSION_IDLE_MESSAGE } from './staff-messages';

/**
 * The admin API's only way in. Verifies with the staff key, the staff audience and the
 * staff type, so a customer token fails three times over. Then, per request, from the
 * database: still a super admin, not suspended, the same session version, and the
 * session row live (not revoked, not idle, within its absolute end), after which the
 * session's last activity moves. One user read and one session read per request.
 */
@Injectable()
export class StaffJwtStrategy extends PassportStrategy(Strategy, 'staff-jwt') {
  constructor(
    tokens: StaffTokensService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly sessions: StaffSessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: tokens.accessKey,
      algorithms: ['HS256'],
      audience: STAFF_TOKEN_AUDIENCE,
    });
  }

  async validate(payload: Partial<StaffAccessClaims> & { exp?: number }): Promise<AuthenticatedStaff> {
    const ended = () => new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    if (payload.type !== STAFF_TOKEN_TYPE || !payload.sub || !payload.sid) throw ended();

    const user = await this.users.findById(payload.sub);
    // Checked on every request, so `admin:revoke` and suspension end staff access at
    // once, whatever the token says.
    if (!user || user.isSuperAdmin !== true || user.suspendedAt) throw ended();
    if ((payload.sv ?? -1) !== user.sessionVersion) throw ended();

    const enrolmentOnly = payload.enr === true;
    const liveness = await this.sessions.checkLive(
      payload.sid,
      user.id,
      {
        idleMs: this.config.getOrThrow<number>('staff.idleTimeoutMs'),
        maxAgeMs: this.config.getOrThrow<number>(enrolmentOnly ? 'staff.enrolmentTtlMs' : 'staff.maxAgeMs'),
      },
      enrolmentOnly,
    );
    if (liveness === 'idle') throw new UnauthorizedException(STAFF_SESSION_IDLE_MESSAGE);
    if (liveness !== 'live') throw ended();
    await this.sessions.touch(payload.sid);

    return {
      kind: 'staff',
      userId: user.id,
      email: user.email,
      isSuperAdmin: true,
      sessionId: payload.sid,
      sessionVersion: user.sessionVersion,
      amr: Array.isArray(payload.amr) ? payload.amr : [],
      ...(typeof payload.auth_time === 'number' ? { authTime: payload.auth_time } : {}),
      enrolmentOnly,
      ...(typeof payload.exp === 'number' ? { accessExp: payload.exp } : {}),
    };
  }
}
