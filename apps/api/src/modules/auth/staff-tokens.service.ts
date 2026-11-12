import { hkdfSync } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

export const STAFF_TOKEN_TYPE = 'staff_access';
export const STAFF_TOKEN_AUDIENCE = 'chumbaq-admin';

/** HKDF inputs for the staff signing key. Changing either signs every staff member out. */
const STAFF_KEY_SALT = 'chumbaq-staff-session';
const STAFF_KEY_INFO = 'staff-access-token-v1';

export interface StaffAccessClaims {
  sub: string;
  email: string;
  type: typeof STAFF_TOKEN_TYPE;
  aud: typeof STAFF_TOKEN_AUDIENCE;
  /** The `staff_sessions` row. */
  sid: string;
  /** `users.session_version` at issue. */
  sv: number;
  amr: string[];
  /** Seconds since epoch of the last real proof. */
  auth_time: number;
  /** An enrolment-only session. */
  enr?: true;
}

/**
 * The staff signing key, derived from JWT_SECRET so no new variable is needed, but a
 * different key: a customer token fails the staff strategy on its signature before its
 * audience or type is even read, and a staff token fails the customer strategy the same
 * way. Both strategies also check the claims, so the separation does not rest on one
 * mechanism.
 */
export function staffAccessKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', jwtSecret, STAFF_KEY_SALT, STAFF_KEY_INFO, 32));
}

@Injectable()
export class StaffTokensService {
  readonly accessKey: Buffer;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    const secret = config.get<string>('jwt.secret');
    if (!secret) throw new Error('jwt.secret is not configured');
    this.accessKey = staffAccessKey(secret);
  }

  /** `ttlMs` is the most it may live; the caller caps it at the session's absolute end. */
  async signAccess(claims: StaffAccessClaims, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
    // Whole seconds and at least one, since `exp` has no finer grain.
    const seconds = Math.max(1, Math.floor(ttlMs / 1000));
    const token = await this.jwt.signAsync(
      { ...claims },
      { secret: this.accessKey, algorithm: 'HS256', expiresIn: seconds },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(exp * 1000) };
  }
}
