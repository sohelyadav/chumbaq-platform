import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { StaffLiveness } from '../modules/auth/staff-sessions.service';
import { StaffSessionsService } from '../modules/auth/staff-sessions.service';
import { StaffTokensService, staffAccessKey } from '../modules/auth/staff-tokens.service';
import { StaffJwtStrategy } from '../modules/staff-auth/staff-jwt.strategy';
import type { UserEntity } from '../modules/users/entities/user.entity';
import { UsersService } from '../modules/users/users.service';

/**
 * For unit specs that put the real `StaffJwtStrategy` behind real HTTP, with users and
 * staff sessions held in maps that answer as the database would. Integration specs use
 * `staff-session.ts` instead, against real rows.
 */
export const STAFF_UNIT_SECRET = 'unit-test-jwt-secret-of-at-least-32-characters';

export const STAFF_UNIT_CONFIG: Record<string, unknown> = {
  'jwt.secret': STAFF_UNIT_SECRET,
  'staff.idleTimeoutMs': 30 * 60_000,
  'staff.maxAgeMs': 8 * 3_600_000,
  'staff.enrolmentTtlMs': 15 * 60_000,
  'staff.accessTtlMs': 10 * 60_000,
};

/** `get` and `getOrThrow` over a flat map, as ConfigService reads registered namespaces. */
export function fakeConfig(values: Record<string, unknown> = {}): ConfigService {
  const all = { ...STAFF_UNIT_CONFIG, ...values };
  return {
    get: (key: string, fallback?: unknown) => (key in all ? all[key] : fallback),
    getOrThrow: (key: string) => {
      if (!(key in all)) throw new Error(`config ${key} missing in test`);
      return all[key];
    },
  } as unknown as ConfigService;
}

/** Staff session rows by id: what `checkLive` would read, plus whose they are. */
export class FakeStaffSessions {
  readonly rows = new Map<string, { userId: string; state: StaffLiveness; enrolmentOnly: boolean }>();
  readonly touched: string[] = [];

  checkLive = async (sessionId: string, userId: string, _limits: unknown, enrolmentOnly = false) => {
    const row = this.rows.get(sessionId);
    if (!row || row.userId !== userId || row.enrolmentOnly !== enrolmentOnly) return 'revoked' as const;
    return row.state;
  };

  touch = async (sessionId: string) => {
    this.touched.push(sessionId);
  };

  isUsable = async (sessionId: string, userId: string) => {
    const row = this.rows.get(sessionId);
    return Boolean(row && row.userId === userId && row.state === 'live' && !row.enrolmentOnly);
  };
}

export function staffStrategyProviders(
  users: () => Map<string, UserEntity>,
  sessions: FakeStaffSessions,
  config: ConfigService = fakeConfig(),
): Provider[] {
  const jwt = new JwtService({});
  return [
    StaffJwtStrategy,
    { provide: StaffTokensService, useValue: new StaffTokensService(config, jwt) },
    { provide: ConfigService, useValue: config },
    { provide: StaffSessionsService, useValue: sessions },
    { provide: UsersService, useValue: { findById: async (id: string) => users().get(id) ?? null } },
  ];
}

/** A staff access token as `StaffAuthService.issueAccess` makes one, with overrides for the bad ones. */
export function signStaffToken(
  user: { id: string; email: string; sessionVersion?: number },
  sessionId: string,
  over: Record<string, unknown> = {},
  key: Buffer | string = staffAccessKey(STAFF_UNIT_SECRET),
): Promise<string> {
  return new JwtService({}).signAsync(
    {
      sub: user.id,
      email: user.email,
      type: 'staff_access',
      aud: 'chumbaq-admin',
      sid: sessionId,
      sv: user.sessionVersion ?? 0,
      amr: ['webauthn', 'uv'],
      auth_time: Math.floor(Date.now() / 1000),
      ...over,
    },
    { secret: key, expiresIn: '5m' },
  );
}
