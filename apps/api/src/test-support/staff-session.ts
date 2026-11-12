import { randomBytes, randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import type { DataSource } from 'typeorm';
import { hashStaffToken } from '../modules/auth/staff-sessions.service';
import { staffAccessKey } from '../modules/auth/staff-tokens.service';

/**
 * A real staff session for integration specs: a `staff_sessions` row and an access token
 * signed with the real staff key from JWT_SECRET, so requests go through the real
 * `StaffJwtStrategy` rather than a stand-in.
 */
export async function issueStaffSessionForTest(
  ds: DataSource,
  user: { id: string; email: string; sessionVersion: number },
  opts: { amr?: string[]; authTime?: Date; enrolmentOnly?: boolean } = {},
): Promise<{ accessToken: string; refreshToken: string | null; sessionId: string }> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set for integration specs');
  const amr = opts.amr ?? (opts.enrolmentOnly ? ['pwd'] : ['webauthn', 'uv']);
  const authTime = opts.authTime ?? new Date();
  const sessionId = randomUUID();
  const refreshToken = opts.enrolmentOnly ? null : `${sessionId}.${randomBytes(32).toString('base64url')}`;
  await ds.query(
    `INSERT INTO staff_sessions
       (id, user_id, current_token_hash, amr, authenticated_at, session_version, enrolment_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionId,
      user.id,
      refreshToken ? hashStaffToken(refreshToken) : null,
      JSON.stringify(amr),
      authTime,
      user.sessionVersion,
      opts.enrolmentOnly ?? false,
    ],
  );
  const accessToken = await new JwtService({}).signAsync(
    {
      sub: user.id,
      email: user.email,
      type: 'staff_access',
      aud: 'chumbaq-admin',
      sid: sessionId,
      sv: user.sessionVersion,
      amr,
      auth_time: Math.floor(authTime.getTime() / 1000),
      ...(opts.enrolmentOnly ? { enr: true } : {}),
    },
    { secret: staffAccessKey(secret), expiresIn: '10m' },
  );
  return { accessToken, refreshToken, sessionId };
}
