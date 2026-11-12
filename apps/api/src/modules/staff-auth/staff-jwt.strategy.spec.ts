import { hkdfSync } from 'crypto';
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { staffAccessKey } from '../auth/staff-tokens.service';
import type { UserEntity } from '../users/entities/user.entity';
import {
  FakeStaffSessions,
  signStaffToken,
  STAFF_UNIT_SECRET,
  staffStrategyProviders,
} from '../../test-support/staff-strategy-fakes';
import { AllowEnrolmentSession } from './allow-enrolment-session.decorator';
import { StaffJwtAuthGuard } from './staff-jwt-auth.guard';
import {
  STAFF_ENROLMENT_ONLY_MESSAGE,
  STAFF_SESSION_ENDED_MESSAGE,
  STAFF_SESSION_IDLE_MESSAGE,
} from './staff-messages';
import type { AuthenticatedStaff } from './staff-principal';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ENROLMENT_SESSION = '44444444-4444-4444-8444-444444444444';

@Controller('probe')
@UseGuards(StaffJwtAuthGuard)
class ProbeController {
  @Get()
  get(@CurrentUser() user: AuthenticatedStaff) {
    return user;
  }

  @Get('enrol')
  @AllowEnrolmentSession()
  enrol(@CurrentUser() user: AuthenticatedStaff) {
    return user;
  }
}

const buildUser = (over: Partial<UserEntity>): UserEntity =>
  ({
    id: STAFF_ID,
    email: 'staff@example.com',
    name: 'Staff',
    sessionVersion: 0,
    isSuperAdmin: true,
    suspendedAt: null,
    ...over,
  }) as UserEntity;

describe('StaffJwtStrategy, through the real guard over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let users: Map<string, UserEntity>;
  let sessions: FakeStaffSessions;
  const staff = { id: STAFF_ID, email: 'staff@example.com' };

  const call = async (token: string, path = '/probe') => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    users = new Map([
      [STAFF_ID, buildUser({})],
      [TENANT_ID, buildUser({ id: TENANT_ID, email: 'tenant@example.com', isSuperAdmin: false })],
    ]);
    sessions = new FakeStaffSessions();
    sessions.rows.set(SESSION, { userId: STAFF_ID, state: 'live', enrolmentOnly: false });
    sessions.rows.set(ENROLMENT_SESSION, { userId: STAFF_ID, state: 'live', enrolmentOnly: true });

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: staffStrategyProviders(() => users, sessions),
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterEach(() => app.close());

  it('derives its key from JWT_SECRET with HKDF, and it is not JWT_SECRET', () => {
    const key = staffAccessKey(STAFF_UNIT_SECRET);
    expect(key).toEqual(
      Buffer.from(hkdfSync('sha256', STAFF_UNIT_SECRET, 'chumbaq-staff-session', 'staff-access-token-v1', 32)),
    );
    expect(key.length).toBe(32);
    expect(key.equals(Buffer.from(STAFF_UNIT_SECRET))).toBe(false);
  });

  it('accepts a staff token and builds the staff principal from the database', async () => {
    const { status, body } = await call(await signStaffToken(staff, SESSION));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      kind: 'staff',
      userId: STAFF_ID,
      isSuperAdmin: true,
      sessionId: SESSION,
      enrolmentOnly: false,
      amr: ['webauthn', 'uv'],
    });
    expect(body.impersonatedBy).toBeUndefined();
    // Idleness is measured from authenticated requests.
    expect(sessions.touched).toEqual([SESSION]);
  });

  describe('a customer token', () => {
    const customerToken = (over: Record<string, unknown> = {}) =>
      new JwtService({}).signAsync(
        { sub: STAFF_ID, email: 'staff@example.com', type: 'access', sv: 0, sid: SESSION, ...over },
        { secret: STAFF_UNIT_SECRET, expiresIn: '5m' },
      );

    it('is refused, even a super admin\'s', async () => {
      expect((await call(await customerToken())).status).toBe(401);
    });

    it('is refused even with the staff claims, since it is signed with JWT_SECRET', async () => {
      const forged = await signStaffToken(staff, SESSION, {}, STAFF_UNIT_SECRET);
      expect((await call(forged)).status).toBe(401);
    });

    it('is refused as a view-as token', async () => {
      expect((await call(await customerToken({ imp: STAFF_ID, sub: TENANT_ID }))).status).toBe(401);
    });
  });

  it.each([
    ['no audience', { aud: undefined }],
    ['another audience', { aud: 'chumbaq-dashboard' }],
    ['the customer type', { type: 'access' }],
    ['no type', { type: undefined }],
    ['no session', { sid: undefined }],
  ])('refuses a staff-signed token with %s', async (_label, over) => {
    expect((await call(await signStaffToken(staff, SESSION, over))).status).toBe(401);
  });

  it('refuses someone who is no longer a super admin, at once', async () => {
    const token = await signStaffToken(staff, SESSION);
    expect((await call(token)).status).toBe(200);
    users.set(STAFF_ID, buildUser({ isSuperAdmin: false }));
    const { status, body } = await call(token);
    expect(status).toBe(401);
    expect(body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
  });

  it('refuses a token from before a session version bump', async () => {
    const token = await signStaffToken(staff, SESSION);
    users.set(STAFF_ID, buildUser({ sessionVersion: 1 }));
    expect((await call(token)).status).toBe(401);
  });

  it('ends a token whose session was revoked', async () => {
    const token = await signStaffToken(staff, SESSION);
    sessions.rows.set(SESSION, { userId: STAFF_ID, state: 'revoked', enrolmentOnly: false });
    const { status, body } = await call(token);
    expect(status).toBe(401);
    expect(body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
  });

  it('says an idle session ended for inactivity', async () => {
    const token = await signStaffToken(staff, SESSION);
    sessions.rows.set(SESSION, { userId: STAFF_ID, state: 'idle', enrolmentOnly: false });
    const { status, body } = await call(token);
    expect(status).toBe(401);
    expect(body.message).toBe(STAFF_SESSION_IDLE_MESSAGE);
    expect(sessions.touched).toEqual([]);
  });

  it('refuses a session row of someone else', async () => {
    const token = await signStaffToken({ id: TENANT_ID, email: 'tenant@example.com' }, SESSION);
    users.set(TENANT_ID, buildUser({ id: TENANT_ID }));
    expect((await call(token)).status).toBe(401);
  });

  describe('enrolment-only sessions', () => {
    it('reach only routes that allow them', async () => {
      const token = await signStaffToken(staff, ENROLMENT_SESSION, { enr: true, amr: ['pwd'] });
      const refused = await call(token);
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe(STAFF_ENROLMENT_ONLY_MESSAGE);

      const allowed = await call(token, '/probe/enrol');
      expect(allowed.status).toBe(200);
      expect(allowed.body.enrolmentOnly).toBe(true);
    });

    it('cannot pass for a full session by dropping the claim', async () => {
      const token = await signStaffToken(staff, ENROLMENT_SESSION, { amr: ['pwd'] });
      expect((await call(token)).status).toBe(401);
    });

    it('cannot make a full session one by adding the claim', async () => {
      const token = await signStaffToken(staff, SESSION, { enr: true });
      expect((await call(token, '/probe/enrol')).status).toBe(401);
    });
  });
});
