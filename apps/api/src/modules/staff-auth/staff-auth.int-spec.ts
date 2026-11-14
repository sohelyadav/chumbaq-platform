import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { FakeAuthenticator } from '../../test-support/fake-authenticator';
import { hotp, totpStepAt } from '../auth/totp';
import { AccountTokensService } from '../auth/account-tokens.service';
import { staffAccessKey } from '../auth/staff-tokens.service';
import { resetSuperAdminPasskeys, setSuperAdmin, staffEnrolment } from '../../scripts/super-admin';
import {
  STAFF_ENROLMENT_BLOCKED_MESSAGE,
  STAFF_ENROLMENT_ONLY_MESSAGE,
  STAFF_LAST_FACTOR_MESSAGE,
  STAFF_MANAGE_IN_ADMIN_MESSAGE,
  STAFF_PASSKEY_NEEDED_MESSAGE,
  STAFF_SESSION_ENDED_MESSAGE,
  STAFF_SESSION_IDLE_MESSAGE,
  STAFF_KEYS_ONLY_MESSAGE,
  PASSKEY_NOT_RECOGNISED_MESSAGE,
} from './staff-messages';

const DOMAIN = '@staff-auth-int.test';
const PASSWORD = 'correct horse battery staple';
const RP_ID = 'localhost';
const ADMIN_ORIGIN = 'https://localhost:5174';
// The customer app on the same RP ID, as in dev, so a key's signature is good for both
// relying parties and only the scope on its row tells them apart.
const CUSTOMER_ORIGIN = 'https://localhost:5173';
const INVALID_HANDLE = 'Your sign-in has expired. Please start again.';

interface Reply {
  status: number;
  body: any;
  cookie: string | null;
}

/** RFC 4648 base32, for the secret `totp/setup` shows. */
function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Staff sign-in over real HTTP on both APIs, against Postgres, Redis, the real WebAuthn
 * library with a software authenticator, and real TOTP codes.
 */
describe('Staff sign-in (integration)', () => {
  let ds: DataSource;
  let customer: BootedApp;
  let admin: BootedApp;
  const saved = {
    adminAppUrl: process.env.ADMIN_APP_URL,
    mfa: process.env.MFA_ENCRYPTION_KEY,
    rpId: process.env.WEBAUTHN_RP_ID,
    origins: process.env.WEBAUTHN_ORIGINS,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const send = async (
    base: string,
    method: string,
    path: string,
    { token, body, cookie, client = true }: { token?: string; body?: unknown; cookie?: string; client?: boolean } = {},
  ): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(client ? { 'x-chumbaq-client': 'admin' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie') };
  };
  const staffApi = (method: string, path: string, opts?: Parameters<typeof send>[3]) =>
    send(admin.base, method, `/api/staff/auth${path}`, opts);
  const adminApi = (method: string, path: string, opts?: Parameters<typeof send>[3]) =>
    send(admin.base, method, `/api/admin${path}`, opts);
  const customerApi = (method: string, path: string, opts?: Parameters<typeof send>[3]) =>
    send(customer.base, method, `/api${path}`, opts);

  const refreshCookieOf = (reply: Reply) => /chumbaq_staff_refresh=([^;]*)/.exec(reply.cookie ?? '')?.[1] ?? null;
  const asCookie = (value: string) => `chumbaq_staff_refresh=${value}`;

  const makeUser = async (name: string, { staff = true } = {}) => {
    const email = `${name}-${randomUUID().slice(0, 8)}${DOMAIN}`;
    const [row] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin, email_verified_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id, email, session_version`,
      [email, await bcrypt.hash(PASSWORD, 4), name, staff],
    );
    return { id: row.id as string, email: row.email as string, sessionVersion: row.session_version as number };
  };

  const customerToken = (user: { id: string; email: string }, sv = 0) =>
    new JwtService({}).signAsync(
      { sub: user.id, email: user.email, type: 'access', sv, auth_time: Math.floor(Date.now() / 1000) },
      { secret: process.env.JWT_SECRET as string, expiresIn: '5m' },
    );

  /** A token signed with the real staff key, claiming whatever the test says. */
  const staffToken = (
    user: { id: string; email: string; sessionVersion: number },
    sid: string,
    { enr = false }: { enr?: boolean } = {},
  ) =>
    new JwtService({}).signAsync(
      {
        sub: user.id,
        email: user.email,
        type: 'staff_access',
        aud: 'chumbaq-admin',
        sid,
        sv: user.sessionVersion,
        amr: enr ? ['pwd'] : ['webauthn', 'uv'],
        auth_time: Math.floor(Date.now() / 1000),
        ...(enr ? { enr: true } : {}),
      },
      { secret: staffAccessKey(process.env.JWT_SECRET as string), expiresIn: '5m' },
    );

  const login = (email: string, password = PASSWORD, enrolmentCode?: string) =>
    staffApi('POST', '/login', { body: { email, password, ...(enrolmentCode !== undefined ? { enrolmentCode } : {}) } });

  const authenticator = () => new FakeAuthenticator({ rpId: RP_ID, origin: ADMIN_ORIGIN });

  const enrolPasskey = async (token: string, key: FakeAuthenticator) => {
    const options = await staffApi('POST', '/passkeys/options', { token, body: {} });
    expect(options.status).toBe(200);
    const { options: o } = options.body.data;
    return staffApi('POST', '/passkeys', { token, body: { response: key.register(o.challenge, o.user.id), name: 'Desk key' } });
  };

  const passkeySignIn = async (key: FakeAuthenticator, origin?: string) => {
    const started = await staffApi('POST', '/passkey/options', { body: {} });
    const { ceremonyId, options } = started.body.data;
    return staffApi('POST', '/passkey/verify', {
      body: { ceremonyId, response: key.assert(options.challenge, origin) },
    });
  };

  /** A staff member with one staff passkey, signed in with it. */
  const signedInStaff = async (name: string) => {
    const user = await makeUser(name);
    const enrol = await login(user.email);
    const key = authenticator();
    expect((await enrolPasskey(enrol.body.data.accessToken, key)).body.data).toEqual({ enrolled: true, signInAgain: true });
    const signedIn = await passkeySignIn(key);
    expect(signedIn.status).toBe(200);
    return {
      user,
      key,
      token: signedIn.body.data.accessToken as string,
      refresh: refreshCookieOf(signedIn) as string,
      sessionId: signedIn.body.data.session.id as string,
    };
  };

  const auditActions = async (userId: string) =>
    (
      await ds.query(`SELECT action, metadata FROM admin_audit_logs WHERE target_id = $1 ORDER BY created_at`, [userId])
    ) as { action: string; metadata: Record<string, unknown> | null }[];

  const codeAt = (secret: Buffer, offset = 0) => hotp(secret, totpStepAt(Date.now()) + offset);

  beforeAll(async () => {
    ds = await openIntDb();
    // The staff relying party is the admin app's dev origin, whatever the .env says.
    process.env.ADMIN_APP_URL = ADMIN_ORIGIN;
    delete process.env.STAFF_WEBAUTHN_RP_ID;
    delete process.env.STAFF_WEBAUTHN_ORIGINS;
    process.env.WEBAUTHN_RP_ID = RP_ID;
    process.env.WEBAUTHN_ORIGINS = CUSTOMER_ORIGIN;
    process.env.MFA_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    customer = await bootIntApp('customer');
    admin = await bootIntApp('admin');
  }, 120000);

  afterAll(async () => {
    await customer?.app.close();
    await admin?.app.close();
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label LIKE $1 OR actor_email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM auth_events WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    await closeIntDb(ds);
    restore('ADMIN_APP_URL', saved.adminAppUrl);
    restore('MFA_ENCRYPTION_KEY', saved.mfa);
    restore('WEBAUTHN_RP_ID', saved.rpId);
    restore('WEBAUTHN_ORIGINS', saved.origins);
  });

  describe('the password step', () => {
    it('answers a non-staff account, an unknown address and a wrong password the same', async () => {
      const tenant = await makeUser('tenant', { staff: false });
      const staff = await makeUser('wrongpw');
      const replies = [
        await login(tenant.email),
        await login(`nobody-${randomUUID()}${DOMAIN}`),
        await login(staff.email, 'not the password'),
      ];
      // Everything but the timestamp the error filter adds.
      const shape = ({ timestamp: _at, ...rest }: Record<string, unknown>) => rest;
      for (const reply of replies) {
        expect(reply.status).toBe(401);
        expect(shape(reply.body)).toEqual(shape(replies[0].body));
      }
      expect(replies[0].body.message).toBe('Invalid email or password');

      // A known staff member's failure is in the staff log; anyone else's is not.
      expect((await auditActions(staff.id)).map((row) => row.action)).toEqual(['staff.sign_in_failed']);
      expect(await auditActions(tenant.id)).toEqual([]);
      const [reasons] = await ds.query(
        `SELECT array_agg(reason ORDER BY created_at) AS r FROM auth_events WHERE email = $1 AND type = 'login.failed'`,
        [tenant.email],
      );
      expect(reasons.r).toEqual(['not_staff']);
    });

    it('shares one failure limit with the customer app', async () => {
      const staff = await makeUser('limit');
      for (let i = 0; i < 5; i++) {
        expect((await customerApi('POST', '/auth/login', { body: { email: staff.email, password: 'nope' } })).status).toBe(401);
        expect((await login(staff.email, 'nope')).status).toBe(401);
      }
      const limited = await login(staff.email);
      expect(limited.status).toBe(429);
    });

    it('never signs in with a password alone', async () => {
      const staff = await makeUser('pwonly');
      const reply = await login(staff.email);
      expect(reply.body.data.step).toBe('enrol');
      expect(reply.cookie).toBeNull();
    });
  });

  describe('a staff member with no factor at all, like the dev admin', () => {
    // The accepted residual: with SUPER_ADMIN_PASSKEY_REQUIRED off, a password alone is
    // still enough here, as it was their whole sign-in before the split. The flag-on case
    // below needs a code.
    it('gets an enrolment session that can only enrol, then must sign in again', async () => {
      const staff = await makeUser('devadmin');
      const reply = await login(staff.email);
      expect(reply.status).toBe(200);
      expect(reply.body.data).toMatchObject({ step: 'enrol', session: { enrolmentOnly: true } });
      expect(reply.cookie).toBeNull();
      expect((await auditActions(staff.id)).map((row) => row.action)).toEqual(['staff.enrolment_started']);
      const token = reply.body.data.accessToken;

      const me = await staffApi('GET', '/me', { token });
      expect(me.status).toBe(200);
      expect(me.body.data).toMatchObject({ email: staff.email, enrolmentOnly: true, factors: { passkeys: 0, totp: false }, billingEnabled: false });

      const overview = await adminApi('GET', '/overview', { token });
      expect(overview.status).toBe(403);
      expect(overview.body.message).toBe(STAFF_ENROLMENT_ONLY_MESSAGE);

      const enrolled = await enrolPasskey(token, authenticator());
      expect(enrolled.status).toBe(200);
      expect(enrolled.body.data).toEqual({ enrolled: true, signInAgain: true });
      expect((await staffApi('GET', '/me', { token })).status).toBe(401);

      // A password now leads to the passkey, not to another enrolment.
      const again = await login(staff.email);
      expect(again.body.data).toMatchObject({ step: 'second_factor', methods: ['webauthn'] });
    });
  });

  describe('several enrolment sessions at once', () => {
    const liveSessions = async (userId: string) =>
      (
        await ds.query(`SELECT count(*)::int AS live FROM staff_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [
          userId,
        ])
      )[0].live as number;
    const factorCount = async (userId: string) =>
      (
        await ds.query(
          `SELECT (SELECT count(*) FROM webauthn_credentials WHERE user_id = $1 AND scope = 'staff')::int
                + (SELECT count(*) FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NOT NULL)::int AS n`,
          [userId],
        )
      )[0].n as number;

    it('ends them all with the first factor, and one left alive still cannot add', async () => {
      const staff = await makeUser('twoenrol');
      const first = (await login(staff.email)).body.data;
      const second = (await login(staff.email)).body.data;
      expect((await enrolPasskey(first.accessToken, authenticator())).status).toBe(200);
      expect((await staffApi('GET', '/me', { token: second.accessToken })).status).toBe(401);
      expect(await liveSessions(staff.id)).toBe(0);

      // Even had it survived, an enrolment session may not add once a staff factor exists.
      await ds.query(`UPDATE staff_sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [
        second.session.id,
      ]);
      const options = await staffApi('POST', '/passkeys/options', { token: second.accessToken, body: {} });
      expect(options.status).toBe(200);
      const { options: o } = options.body.data;
      const late = await staffApi('POST', '/passkeys', {
        token: second.accessToken,
        body: { response: authenticator().register(o.challenge, o.user.id), name: 'Late key' },
      });
      expect(late.status).toBe(401);
      expect(late.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
      expect(await factorCount(staff.id)).toBe(1);
    });

    it('lets one of a passkey and an authenticator app, sent at once, through', async () => {
      const staff = await makeUser('enrolrace');
      const viaKey = (await login(staff.email)).body.data.accessToken;
      const viaApp = (await login(staff.email)).body.data.accessToken;
      const { options: o } = (await staffApi('POST', '/passkeys/options', { token: viaKey, body: {} })).body.data;
      const setup = await staffApi('POST', '/totp/setup', { token: viaApp, body: {} });
      const secret = base32Decode(setup.body.data.secret);

      const replies = await Promise.all([
        staffApi('POST', '/passkeys', {
          token: viaKey,
          body: { response: authenticator().register(o.challenge, o.user.id), name: 'Desk key' },
        }),
        staffApi('POST', '/totp/confirm', { token: viaApp, body: { code: codeAt(secret) } }),
      ]);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
      expect(await factorCount(staff.id)).toBe(1);
      expect(await liveSessions(staff.id)).toBe(0);
    });

    it('lets one of two authenticator app confirmations through and ends both sessions', async () => {
      const staff = await makeUser('totprace');
      const a = (await login(staff.email)).body.data.accessToken;
      const b = (await login(staff.email)).body.data.accessToken;
      const secret = base32Decode((await staffApi('POST', '/totp/setup', { token: a, body: {} })).body.data.secret);
      const code = codeAt(secret);

      const replies = await Promise.all([
        staffApi('POST', '/totp/confirm', { token: a, body: { code } }),
        staffApi('POST', '/totp/confirm', { token: b, body: { code } }),
      ]);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
      expect(await factorCount(staff.id)).toBe(1);
      expect(await liveSessions(staff.id)).toBe(0);
    });
  });

  describe('a staff member whose only passkeys are customer ones', () => {
    const withCustomerKey = async (name: string) => {
      const staff = await makeUser(name);
      await ds.query(
        `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_type, backed_up, name, scope)
         VALUES ($1, $2, '\\x00', 'singleDevice', false, 'Old key', 'customer')`,
        [staff.id, randomUUID()],
      );
      return staff;
    };
    const allowance = async (id: string) =>
      (await ds.query(`SELECT used_at, used_ip, voided_at, voided_reason FROM staff_enrolment_allowances WHERE id = $1`, [id]))[0];
    // Everything but the timestamp the error filter adds.
    const shape = ({ timestamp: _at, ...rest }: Record<string, unknown>) => rest;

    it('is refused without a code, even once an operator has made one', async () => {
      const staff = await withCustomerKey('legacy');
      const refused = await login(staff.email);
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe(STAFF_ENROLMENT_BLOCKED_MESSAGE);

      // The old allowance was a time window that a password alone could use. Not now.
      const issued = await staffEnrolment(ds, staff.email);
      const still = await login(staff.email);
      expect(still.status).toBe(403);
      expect(shape(still.body)).toEqual(shape(refused.body));
      expect((await allowance(issued.id)).used_at).toBeNull();
    });

    it('starts enrolment with the code, spending it, and audits which allowance', async () => {
      const staff = await withCustomerKey('legacy-code');
      const issued = await staffEnrolment(ds, staff.email);
      const allowed = await login(staff.email, PASSWORD, issued.code);
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.step).toBe('enrol');
      const spent = await allowance(issued.id);
      expect(spent.used_at).not.toBeNull();
      expect(spent.used_ip).toBeTruthy();
      const started = (await auditActions(staff.id)).find((row) => row.action === 'staff.enrolment_started');
      expect(started?.metadata).toMatchObject({ allowanceId: issued.id, sessionId: allowed.body.data.session.id });

      // Spent: the same code cannot start a second enrolment session.
      const again = await login(staff.email, PASSWORD, issued.code);
      expect(again.status).toBe(403);
      expect(again.body.message).toBe(STAFF_ENROLMENT_BLOCKED_MESSAGE);

      expect((await enrolPasskey(allowed.body.data.accessToken, authenticator())).status).toBe(200);
      expect((await login(staff.email)).body.data.step).toBe('second_factor');
    });

    it('lets one of two sign-ins sent at once with the code through', async () => {
      const staff = await withCustomerKey('legacy-race');
      const { code } = await staffEnrolment(ds, staff.email);
      const replies = await Promise.all([
        login(staff.email, PASSWORD, code),
        login(staff.email, PASSWORD, code),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 403]);
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM staff_sessions WHERE user_id = $1 AND enrolment_only`,
        [staff.id],
      );
      expect(n).toBe(1);
    });

    it('answers a wrong, expired or replaced code as a missing one, and counts a wrong one', async () => {
      const staff = await withCustomerKey('legacy-wrong');
      const missing = await login(staff.email);
      const old = await staffEnrolment(ds, staff.email);
      const current = await staffEnrolment(ds, staff.email);
      const replies = [
        await login(staff.email, PASSWORD, 'A'.repeat(43)),
        await login(staff.email, PASSWORD, old.code),
      ];
      await ds.query(`UPDATE staff_enrolment_allowances SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        current.id,
      ]);
      replies.push(await login(staff.email, PASSWORD, current.code));
      for (const reply of replies) {
        expect(reply.status).toBe(403);
        expect(shape(reply.body)).toEqual(shape(missing.body));
      }
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM auth_events WHERE email = $1 AND type = 'login.failed' AND reason = 'enrolment_code_refused'`,
        [staff.email],
      );
      expect(n).toBe(3);
      expect((await auditActions(staff.id)).filter((row) => row.action === 'staff.sign_in_failed')).toHaveLength(3);
    });

    it('stops guessing at the shared failure limit, even with the right code', async () => {
      const staff = await withCustomerKey('legacy-limit');
      const { code } = await staffEnrolment(ds, staff.email);
      for (let i = 0; i < 10; i++) {
        expect((await login(staff.email, PASSWORD, randomBytes(32).toString('base64url'))).status).toBe(403);
      }
      expect((await login(staff.email, PASSWORD, code)).status).toBe(429);
      await ds.query(`DELETE FROM auth_events WHERE email = $1`, [staff.email]);
    });

    it('says nothing about the code to someone without the password, and spends nothing', async () => {
      const staff = await withCustomerKey('legacy-nopw');
      const { id, code } = await staffEnrolment(ds, staff.email);
      const wrongPassword = await login(staff.email, 'not the password', code);
      const noCode = await login(staff.email, 'not the password');
      expect(wrongPassword.status).toBe(401);
      expect(shape(wrongPassword.body)).toEqual(shape(noCode.body));
      expect((await allowance(id)).used_at).toBeNull();
    });

    it("refuses someone else's code, even with the right password, and spends nothing", async () => {
      // A code is for one person: another staff member who knows their own password
      // must not be able to enrol with a code the operator handed to someone else.
      const owner = await withCustomerKey('legacy-owner');
      const other = await withCustomerKey('legacy-other');
      const issued = await staffEnrolment(ds, owner.email);
      const missing = await login(other.email);
      const borrowed = await login(other.email, PASSWORD, issued.code);
      expect(borrowed.status).toBe(403);
      expect(borrowed.body.message).toBe(STAFF_ENROLMENT_BLOCKED_MESSAGE);
      expect(shape(borrowed.body)).toEqual(shape(missing.body));
      expect((await allowance(issued.id)).used_at).toBeNull();
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM staff_sessions WHERE user_id = $1 AND enrolment_only`,
        [other.id],
      );
      expect(n).toBe(0);

      // Still good for the person it was made for.
      expect((await login(owner.email, PASSWORD, issued.code)).body.data.step).toBe('enrol');
    });

    it('is voided, with the staff sessions ended, by a customer password reset', async () => {
      const staff = await withCustomerKey('legacy-reset');
      const { id, code } = await staffEnrolment(ds, staff.email);
      // A live staff session too, whose row the reset must revoke, not just outdate.
      const session = (await login(staff.email, PASSWORD, code)).body.data.session.id as string;
      const second = await staffEnrolment(ds, staff.email);
      const resetToken = await customer.app.get(AccountTokensService).issue(staff.id, 'reset_password');
      const reset = await customerApi('POST', '/auth/reset-password', {
        body: { token: resetToken, newPassword: 'a different long passphrase 42' },
      });
      expect(reset.status).toBe(200);
      expect((await allowance(second.id)).voided_reason).toBe('password_reset');
      expect((await allowance(id)).used_at).not.toBeNull();
      const [row] = await ds.query(`SELECT revoked_reason FROM staff_sessions WHERE id = $1`, [session]);
      expect(row.revoked_reason).toBe('password_reset');
      const after = await login(staff.email, 'a different long passphrase 42', second.code);
      expect(after.status).toBe(403);
      expect(after.body.message).toBe(STAFF_ENROLMENT_BLOCKED_MESSAGE);
    });

    it('is used up by the first staff factor, whichever way it was started', async () => {
      const staff = await withCustomerKey('legacy-used');
      const first = await staffEnrolment(ds, staff.email);
      const token = (await login(staff.email, PASSWORD, first.code)).body.data.accessToken;
      // Another code made while enrolling, which the new factor must void.
      const spare = await staffEnrolment(ds, staff.email);
      expect((await enrolPasskey(token, authenticator())).status).toBe(200);
      expect((await allowance(spare.id)).voided_reason).toBe('enrolled');
    });

    it('refuses the CLI allowance for someone who is not staff', async () => {
      const tenant = await makeUser('notstaff', { staff: false });
      await expect(staffEnrolment(ds, tenant.email)).rejects.toThrow('is not a super admin');
    });
  });

  describe('a staff member with no passkey, when passkeys are required', () => {
    it('needs a code too, since then a password alone was never meant to be enough', async () => {
      const staff = await makeUser('required-nokey');
      const config = admin.app.get(ConfigService);
      const realGet = config.get.bind(config);
      const required = jest
        .spyOn(config, 'get')
        .mockImplementation(((path: string, ...rest: unknown[]) =>
          path === 'webauthn.superAdminPasskeyRequired' ? true : (realGet as any)(path, ...rest)) as never);
      try {
        const refused = await login(staff.email);
        expect(refused.status).toBe(403);
        expect(refused.body.message).toBe(STAFF_ENROLMENT_BLOCKED_MESSAGE);
        const { code } = await staffEnrolment(ds, staff.email);
        expect((await login(staff.email, PASSWORD, code)).body.data.step).toBe('enrol');
      } finally {
        required.mockRestore();
      }
    });
  });

  describe('passkey sign-in', () => {
    it('signs in with a staff passkey and sets the staff cookie', async () => {
      const staff = await makeUser('passkey');
      const key = authenticator();
      await enrolPasskey((await login(staff.email)).body.data.accessToken, key);

      const signedIn = await passkeySignIn(key);
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data).toMatchObject({ step: 'signed_in', session: { enrolmentOnly: false, idleTimeoutSeconds: 1800 } });
      const cookie = signedIn.cookie as string;
      expect(cookie).toMatch(/^chumbaq_staff_refresh=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/api/staff/auth/session');
      expect(cookie).not.toMatch(/Domain=/i);
      // Only its hash is stored.
      const [stored] = await ds.query(`SELECT current_token_hash FROM staff_sessions WHERE id = $1`, [signedIn.body.data.session.id]);
      expect(stored.current_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.current_token_hash).not.toContain(refreshCookieOf(signedIn));
      const signIn = (await auditActions(staff.id)).find((row) => row.action === 'staff.signed_in');
      expect(signIn?.metadata).toMatchObject({ amr: ['webauthn', 'uv'] });

      // A password and the same key also work, as a second factor.
      const handle = (await login(staff.email)).body.data.handle;
      const options = await staffApi('POST', '/login/passkey/options', { body: { handle } });
      const second = await staffApi('POST', '/login/passkey/verify', {
        body: { handle, response: key.assert(options.body.data.options.challenge) },
      });
      expect(second.status).toBe(200);
      expect(second.body.data.step).toBe('signed_in');
    });

    it('does not recognise a customer passkey', async () => {
      const staff = await makeUser('custkey');
      const key = authenticator();
      await enrolPasskey((await login(staff.email)).body.data.accessToken, key);
      await ds.query(`UPDATE webauthn_credentials SET scope = 'customer' WHERE user_id = $1`, [staff.id]);
      const reply = await passkeySignIn(key);
      expect(reply.status).toBe(401);
      expect(reply.body.message).toBe(PASSKEY_NOT_RECOGNISED_MESSAGE);
      expect(reply.cookie).toBeNull();
    });

    it('does not take a customer key that signs correctly for the customer app', async () => {
      // The key's signature, RP ID and origin are all good for the customer relying
      // party, so only the scope filter on the lookup can turn it away here.
      const staff = await makeUser('custkey-origin');
      const key = authenticator();
      await enrolPasskey((await login(staff.email)).body.data.accessToken, key);
      await ds.query(`UPDATE webauthn_credentials SET scope = 'customer' WHERE user_id = $1`, [staff.id]);
      const reply = await passkeySignIn(key, CUSTOMER_ORIGIN);
      expect(reply.status).toBe(401);
      expect(reply.body.message).toBe(PASSKEY_NOT_RECOGNISED_MESSAGE);
      expect(reply.cookie).toBeNull();
    });

    it('is not a way into the customer app with a staff key', async () => {
      // The other way: a staff key signing for the admin origin is good for the staff
      // relying party, so the customer app must not find it at all.
      const { key, user } = await signedInStaff('staffkey-customer');
      // Nor does the password replace it there: before the split that key guarded both.
      const password = await customerApi('POST', '/auth/login', { body: { email: user.email, password: PASSWORD } });
      expect(password.status).toBe(403);
      expect(password.body.message).toBe(STAFF_KEYS_ONLY_MESSAGE);
      expect(password.cookie ?? '').not.toContain('chumbaq_refresh=');
      const started = await customerApi('POST', '/auth/passkey/options', { body: {} });
      expect(started.status).toBe(200);
      const { flowId, options } = started.body.data;
      const reply = await customerApi('POST', '/auth/passkey/verify', {
        body: { flowId, response: key.assert(options.challenge, ADMIN_ORIGIN) },
      });
      expect(reply.status).toBe(401);
      expect(reply.body.data).toBeUndefined();
      expect(reply.cookie ?? '').not.toContain('chumbaq_refresh=');
    });

    it('does not sign in someone who stopped being staff', async () => {
      const { user, key } = await signedInStaff('demoted');
      await setSuperAdmin(ds, user.email, false);
      const reply = await passkeySignIn(key);
      expect(reply.status).toBe(401);
      expect(reply.body.message).toBe(PASSKEY_NOT_RECOGNISED_MESSAGE);
    });
  });

  describe('authenticator app', () => {
    it('enrols without recovery codes, then signs in with password and code', async () => {
      const staff = await makeUser('totp');
      const token = (await login(staff.email)).body.data.accessToken;
      const factors = await staffApi('GET', '/factors', { token });
      expect(factors.body.data).toEqual({ passkeys: [], totp: { enabled: false, available: true }, canRemove: false });
      const setup = await staffApi('POST', '/totp/setup', { token, body: {} });
      expect(setup.status).toBe(200);
      const secret = base32Decode(setup.body.data.secret);
      const confirmed = await staffApi('POST', '/totp/confirm', { token, body: { code: codeAt(secret, -1) } });
      expect(confirmed.body.data).toEqual({ enrolled: true, signInAgain: true });
      expect(JSON.stringify(confirmed.body)).not.toContain('recovery');

      const step = await login(staff.email);
      expect(step.body.data).toMatchObject({ step: 'second_factor', methods: ['totp'] });
      const wrong = await staffApi('POST', '/login/totp', { body: { handle: step.body.data.handle, code: '000000' } });
      expect(wrong.status).toBe(401);
      const signedIn = await staffApi('POST', '/login/totp', { body: { handle: step.body.data.handle, code: codeAt(secret) } });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.step).toBe('signed_in');
      expect(refreshCookieOf(signedIn)).toBeTruthy();

      // A handle works only on the app that issued it, both ways.
      const customerStep = await customerApi('POST', '/auth/login', { body: { email: staff.email, password: PASSWORD } });
      expect(customerStep.body.data.requiresSecondFactor).toBe(true);
      const crossed = await staffApi('POST', '/login/totp', {
        body: { handle: customerStep.body.data.handle, code: codeAt(secret, 1) },
      });
      expect(crossed.status).toBe(401);
      expect(crossed.body.message).toBe(INVALID_HANDLE);
      const staffHandle = (await login(staff.email)).body.data.handle;
      const crossedBack = await customerApi('POST', '/auth/login/totp', {
        body: { handle: staffHandle, code: codeAt(secret, 1) },
      });
      expect(crossedBack.status).toBe(401);
      expect(crossedBack.body.message).toBe(INVALID_HANDLE);

      // The customer app does not let a super admin remove what is now a staff factor.
      const customerAccess = await customerToken(staff);
      const removal = await customerApi('DELETE', '/auth/totp', { token: customerAccess });
      expect(removal.status).toBe(403);
      expect(removal.body.message).toBe(STAFF_MANAGE_IN_ADMIN_MESSAGE);
      const codes = await customerApi('POST', '/auth/recovery-codes', { token: customerAccess });
      expect(codes.status).toBe(403);
      expect(codes.body.message).toBe(STAFF_MANAGE_IN_ADMIN_MESSAGE);
    });
  });

  describe('an authenticator app, when passkeys are required', () => {
    // SUPER_ADMIN_PASSKEY_REQUIRED for the callback only, as in the cases above.
    const whileRequired = async (run: () => Promise<void>) => {
      const config = admin.app.get(ConfigService);
      const realGet = config.get.bind(config);
      const required = jest
        .spyOn(config, 'get')
        .mockImplementation(((path: string, ...rest: unknown[]) =>
          path === 'webauthn.superAdminPasskeyRequired' ? true : (realGet as any)(path, ...rest)) as never);
      try {
        await run();
      } finally {
        required.mockRestore();
      }
    };
    const enrolTotp = async (token: string) => {
      const setup = await staffApi('POST', '/totp/setup', { token, body: {} });
      expect(setup.status).toBe(200);
      const secret = base32Decode(setup.body.data.secret);
      const confirmed = await staffApi('POST', '/totp/confirm', { token, body: { code: codeAt(secret, -1) } });
      expect(confirmed.status).toBe(200);
      return secret;
    };

    it('cannot sign in, re-authenticate or vouch for a new passkey', async () => {
      const { user, key, token } = await signedInStaff('required-totp');
      const options = await staffApi('POST', '/reauth/passkey/options', { token, body: {} });
      const reauthed = await staffApi('POST', '/reauth/passkey/verify', {
        token,
        body: { response: key.assert(options.body.data.options.challenge) },
      });
      const secret = await enrolTotp(reauthed.body.data.accessToken);
      // A session that showed only the password and a code, from before the requirement.
      const step = await login(user.email);
      const codeOnly = await staffApi('POST', '/login/totp', { body: { handle: step.body.data.handle, code: codeAt(secret) } });
      expect(codeOnly.status).toBe(200);
      const codeToken = codeOnly.body.data.accessToken as string;

      await whileRequired(async () => {
        const reauth = await staffApi('POST', '/reauth/totp', { token: codeToken, body: { code: codeAt(secret, 1) } });
        expect(reauth.status).toBe(403);
        expect(reauth.body.message).toBe(STAFF_PASSKEY_NEEDED_MESSAGE);
        const plant = await staffApi('POST', '/passkeys/options', { token: codeToken, body: {} });
        expect(plant.status).toBe(403);
        expect(plant.body.message).toBe(STAFF_PASSKEY_NEEDED_MESSAGE);

        const again = await login(user.email);
        expect(again.body.data).toMatchObject({ step: 'second_factor', methods: ['webauthn'] });
        const byCode = await staffApi('POST', '/login/totp', { body: { handle: again.body.data.handle, code: codeAt(secret, 1) } });
        expect(byCode.status).toBe(401);
        expect(byCode.body.message).toBe(STAFF_PASSKEY_NEEDED_MESSAGE);
      });
      const added = (await auditActions(user.id)).filter((r) => r.action === 'staff.factor_added');
      expect(added).toHaveLength(2);
    });

    it('sends someone whose only staff factor is the app to an operator code, which can add a passkey', async () => {
      const staff = await makeUser('required-totp-only');
      await enrolTotp((await login(staff.email)).body.data.accessToken);

      await whileRequired(async () => {
        const refused = await login(staff.email);
        expect(refused.status).toBe(403);
        expect(refused.body.message).toBe(STAFF_ENROLMENT_BLOCKED_MESSAGE);
        const { code } = await staffEnrolment(ds, staff.email);
        const enrol = await login(staff.email, PASSWORD, code);
        expect(enrol.body.data.step).toBe('enrol');
        const token = enrol.body.data.accessToken as string;
        const factors = await staffApi('GET', '/factors', { token });
        expect(factors.body.data.totp).toEqual({ enabled: true, available: false });
        expect((await staffApi('POST', '/totp/setup', { token, body: {} })).status).toBe(403);
        expect((await enrolPasskey(token, authenticator())).body.data).toEqual({ enrolled: true, signInAgain: true });
      });
    });
  });

  describe('tokens are not interchangeable', () => {
    it('refuses each API the other\'s tokens and cookie', async () => {
      const { user, token, refresh } = await signedInStaff('cross');
      expect((await customerApi('GET', '/auth/me', { token })).status).toBe(401);

      const customerAccess = await customerToken(user);
      expect((await customerApi('GET', '/auth/me', { token: customerAccess })).status).toBe(200);
      expect((await adminApi('GET', '/overview', { token: customerAccess })).status).toBe(401);
      expect((await staffApi('GET', '/me', { token: customerAccess })).status).toBe(401);

      const asCustomerCookie = await customerApi('POST', '/auth/refresh', { cookie: `chumbaq_refresh=${refresh}` });
      expect(asCustomerCookie.status).toBe(401);

      // The customer list never shows a staff key.
      const keys = await customerApi('GET', '/auth/passkeys', { token: customerAccess });
      expect(keys.status).toBe(200);
      expect(keys.body.data.passkeys).toEqual([]);
    });
  });

  describe('a token must say what its session is', () => {
    it('refuses a full token for an enrolment session', async () => {
      const staff = await makeUser('enr-row');
      const enrol = await login(staff.email);
      expect(enrol.body.data.step).toBe('enrol');
      const sid = enrol.body.data.session.id as string;
      expect((await staffApi('GET', '/me', { token: enrol.body.data.accessToken })).status).toBe(200);

      const forged = await staffToken(staff, sid);
      const reply = await staffApi('GET', '/me', { token: forged });
      expect(reply.status).toBe(401);
      expect(reply.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
    });

    it('refuses an enrolment token for a full session', async () => {
      const { user, sessionId } = await signedInStaff('enr-claim');
      const forged = await staffToken(user, sessionId, { enr: true });
      const reply = await staffApi('GET', '/me', { token: forged });
      expect(reply.status).toBe(401);
      expect(reply.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
    });
  });

  describe('the session', () => {
    it('rotates on refresh, honours the old token for 30 seconds, and ends on a later replay', async () => {
      const { user, refresh, sessionId } = await signedInStaff('rotate');
      const first = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(first.status).toBe(200);
      const next = refreshCookieOf(first) as string;
      expect(next).toBeTruthy();
      expect(next).not.toBe(refresh);

      // Another tab with the old cookie, at once: an access token, and the cookie left alone.
      const retried = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(retried.status).toBe(200);
      expect(retried.cookie).toBeNull();

      await ds.query(`UPDATE staff_sessions SET rotated_at = now() - interval '31 seconds' WHERE id = $1`, [sessionId]);
      const replay = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(replay.status).toBe(401);
      expect(replay.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
      const [row] = await ds.query(`SELECT revoked_reason FROM staff_sessions WHERE id = $1`, [sessionId]);
      expect(row.revoked_reason).toBe('replay');
      expect((await auditActions(user.id)).map((r) => r.action)).toContain('staff.session_revoked');
      expect((await staffApi('POST', '/session/refresh', { cookie: asCookie(next) })).status).toBe(401);
    });

    it('needs the client header to refresh', async () => {
      const { refresh } = await signedInStaff('header');
      expect((await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh), client: false })).status).toBe(403);
    });

    it('ends after 30 minutes with no request, however often the app refreshes', async () => {
      const { token, refresh, sessionId } = await signedInStaff('idle');
      await ds.query(`UPDATE staff_sessions SET last_active_at = now() - interval '31 minutes' WHERE id = $1`, [sessionId]);
      const access = await staffApi('GET', '/me', { token });
      expect(access.status).toBe(401);
      expect(access.body.message).toBe(STAFF_SESSION_IDLE_MESSAGE);
      const refreshed = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.message).toBe(STAFF_SESSION_IDLE_MESSAGE);
      expect(refreshed.cookie).toMatch(/chumbaq_staff_refresh=;.*Expires=Thu, 01 Jan 1970/);
    });

    it('counts real requests as activity, at most once a minute, and refreshes not at all', async () => {
      const { token, refresh, sessionId } = await signedInStaff('touch');
      const lastActive = async () =>
        Number((await ds.query(`SELECT extract(epoch FROM now() - last_active_at) AS age FROM staff_sessions WHERE id = $1`, [sessionId]))[0].age);

      await ds.query(`UPDATE staff_sessions SET last_active_at = now() - interval '59 seconds' WHERE id = $1`, [sessionId]);
      expect((await staffApi('GET', '/me', { token })).status).toBe(200);
      expect(await lastActive()).toBeGreaterThan(58);

      await ds.query(`UPDATE staff_sessions SET last_active_at = now() - interval '20 minutes' WHERE id = $1`, [sessionId]);
      expect((await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) })).status).toBe(200);
      expect(await lastActive()).toBeGreaterThan(1199);

      expect((await staffApi('GET', '/me', { token })).status).toBe(200);
      expect(await lastActive()).toBeLessThan(5);
    });

    it('ends 8 hours after sign-in, whatever else', async () => {
      const { token, refresh, sessionId } = await signedInStaff('maxage');
      await ds.query(`UPDATE staff_sessions SET created_at = now() - interval '8 hours 1 minute' WHERE id = $1`, [sessionId]);
      const access = await staffApi('GET', '/me', { token });
      expect(access.status).toBe(401);
      expect(access.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
      const refreshed = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
    });

    it('signs out', async () => {
      const { user, token, refresh } = await signedInStaff('logout');
      const out = await staffApi('POST', '/session/logout', { token });
      expect(out.status).toBe(204);
      expect(out.cookie).toMatch(/chumbaq_staff_refresh=;/);
      expect((await staffApi('GET', '/me', { token })).status).toBe(401);
      expect((await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) })).status).toBe(401);
      expect((await auditActions(user.id)).map((r) => r.action)).toContain('staff.signed_out');
    });
  });

  describe('what ends staff sessions', () => {
    it('admin:revoke', async () => {
      const { user, token, refresh, sessionId } = await signedInStaff('revoked');
      await setSuperAdmin(ds, user.email, false);
      expect((await staffApi('GET', '/me', { token })).status).toBe(401);
      expect((await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) })).status).toBe(401);
      const [row] = await ds.query(`SELECT revoked_reason FROM staff_sessions WHERE id = $1`, [sessionId]);
      expect(row.revoked_reason).toBe('staff_revoked');
    });

    it('admin:passkeys-reset, after which a password starts enrolment again', async () => {
      const { user, token } = await signedInStaff('keysreset');
      await resetSuperAdminPasskeys(ds, user.email, null, () => undefined);
      expect((await staffApi('GET', '/me', { token })).status).toBe(401);
      expect((await login(user.email)).body.data.step).toBe('enrol');
    });

    // This bumps session_version and leaves the staff_sessions row alone, so the version
    // check on refresh is all that stops the cookie minting a fresh access token.
    it('the customer app\'s sign out everywhere', async () => {
      const { user, token, refresh, sessionId } = await signedInStaff('everywhere');
      expect((await customerApi('POST', '/auth/logout-all', { token: await customerToken(user) })).status).toBe(204);
      expect((await staffApi('GET', '/me', { token })).status).toBe(401);
      const refreshed = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
      const [row] = await ds.query(`SELECT revoked_reason FROM staff_sessions WHERE id = $1`, [sessionId]);
      expect(row.revoked_reason).toBe('session_version');
    });

    // A reset also revokes the rows: whoever reset it may hold only the mailbox.
    it('a password reset', async () => {
      const { user, token, refresh, sessionId } = await signedInStaff('pwreset');
      const resetToken = await customer.app.get(AccountTokensService).issue(user.id, 'reset_password');
      expect(resetToken).toBeTruthy();
      const reset = await customerApi('POST', '/auth/reset-password', {
        body: { token: resetToken, newPassword: 'a different long passphrase 42' },
      });
      expect(reset.status).toBe(200);
      expect((await staffApi('GET', '/me', { token })).status).toBe(401);
      const refreshed = await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.message).toBe(STAFF_SESSION_ENDED_MESSAGE);
      const [row] = await ds.query(`SELECT revoked_reason FROM staff_sessions WHERE id = $1`, [sessionId]);
      expect(row.revoked_reason).toBe('password_reset');
    });
  });

  describe('re-authentication and factor changes', () => {
    it('asks for a recent sign-in for a dangerous action, then lets it through', async () => {
      const { key, refresh, sessionId } = await signedInStaff('reauth');
      const tenant = await makeUser('suspendme', { staff: false });
      await ds.query(`UPDATE staff_sessions SET authenticated_at = now() - interval '16 minutes' WHERE id = $1`, [sessionId]);
      const stale = (await staffApi('POST', '/session/refresh', { cookie: asCookie(refresh) })).body.data.accessToken;

      const refused = await adminApi('POST', `/tenants/${tenant.id}/suspend`, { token: stale, body: { reason: 'abuse reports here' } });
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe('Confirm it is you to continue.');

      const options = await staffApi('POST', '/reauth/passkey/options', { token: stale, body: {} });
      const confirmed = await staffApi('POST', '/reauth/passkey/verify', {
        token: stale,
        body: { response: key.assert(options.body.data.options.challenge) },
      });
      expect(confirmed.status).toBe(200);
      const fresh = confirmed.body.data.accessToken;
      const suspended = await adminApi('POST', `/tenants/${tenant.id}/suspend`, { token: fresh, body: { reason: 'abuse reports here' } });
      expect(suspended.status).toBe(200);
    });

    it('refuses to remove the last staff factor', async () => {
      const { key, token } = await signedInStaff('lastfactor');
      const factors = await staffApi('GET', '/factors', { token });
      expect(factors.body.data.canRemove).toBe(false);
      const options = await staffApi('POST', '/reauth/passkey/options', { token, body: {} });
      const fresh = (
        await staffApi('POST', '/reauth/passkey/verify', { token, body: { response: key.assert(options.body.data.options.challenge) } })
      ).body.data.accessToken;
      const removal = await staffApi('DELETE', `/passkeys/${factors.body.data.passkeys[0].id}`, { token: fresh });
      expect(removal.status).toBe(409);
      expect(removal.body.message).toBe(STAFF_LAST_FACTOR_MESSAGE);
    });

    it('adds and removes keys in a full session after re-authenticating, keeping two when required', async () => {
      const { user, key, token } = await signedInStaff('twokeys');
      const reauth = async (bearer: string) => {
        const options = await staffApi('POST', '/reauth/passkey/options', { token: bearer, body: {} });
        const reply = await staffApi('POST', '/reauth/passkey/verify', {
          token: bearer,
          body: { response: key.assert(options.body.data.options.challenge) },
        });
        expect(reply.status).toBe(200);
        return reply.body.data.accessToken as string;
      };
      // Another staff session of theirs, which adding a factor must end.
      const other = (await passkeySignIn(key)).body.data.accessToken;

      let current = await reauth(token);
      const added = await enrolPasskey(current, authenticator());
      expect(added.body.data).toEqual({ enrolled: true, signInAgain: false });
      expect((await staffApi('GET', '/me', { token: current })).status).toBe(200);
      expect((await staffApi('GET', '/me', { token: other })).status).toBe(401);
      // The proof was spent: a second key needs another re-authentication.
      expect((await staffApi('POST', '/passkeys/options', { token: current, body: {} })).status).toBe(403);

      const keys = (await staffApi('GET', '/factors', { token: current })).body.data.passkeys as { id: string }[];
      expect(keys).toHaveLength(2);
      // SUPER_ADMIN_PASSKEY_REQUIRED, for this part only. Not `ConfigService.set`, which
      // writes the string into process.env, where 'false' would read as on.
      const config = admin.app.get(ConfigService);
      const realGet = config.get.bind(config);
      const required = jest
        .spyOn(config, 'get')
        .mockImplementation(((path: string, ...rest: unknown[]) =>
          path === 'webauthn.superAdminPasskeyRequired' ? true : (realGet as any)(path, ...rest)) as never);
      try {
        current = await reauth(current);
        const kept = await staffApi('DELETE', `/passkeys/${keys[1].id}`, { token: current });
        expect(kept.status).toBe(409);
        expect(kept.body.message).toContain('must keep 2 passkeys');
      } finally {
        required.mockRestore();
      }
      current = await reauth(current);
      expect((await staffApi('DELETE', `/passkeys/${keys[1].id}`, { token: current })).status).toBe(204);
      const actions = (await auditActions(user.id)).map((r) => r.action);
      expect(actions.filter((a) => a === 'staff.factor_added')).toHaveLength(2);
      expect(actions).toContain('staff.factor_removed');
    });

    it('needs a real re-authentication to add a factor in a full session', async () => {
      const { token } = await signedInStaff('addneedsproof');
      const options = await staffApi('POST', '/passkeys/options', { token, body: {} });
      expect(options.status).toBe(403);
      expect(options.body.message).toBe('Confirm it is you to continue.');
    });
  });
});
