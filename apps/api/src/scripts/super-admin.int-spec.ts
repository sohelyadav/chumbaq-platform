import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../test-support/int-db';
import { AdminAuditService } from '../modules/admin/admin-audit.service';
import {
  SuperAdminCliError,
  issuePasswordResetLink,
  resetAccountFactors,
  resetSuperAdminPasskeys,
  setSuperAdmin,
  staffEnrolment,
} from './super-admin';

const EMAIL = 'super-admin-cli@test.local';
const VERIFIED = { method: 'phone_call_known_number', notes: 'Called the number on the invoice' } as const;

describe('super-admin CLI', () => {
  let ds: DataSource;

  const auditRows = () =>
    ds.query(
      `SELECT actor_id, actor_email, action, target_type, target_id, target_label
       FROM admin_audit_logs WHERE target_label = $1 ORDER BY created_at`,
      [EMAIL],
    );
  const userRow = async () =>
    (await ds.query(`SELECT id, is_super_admin FROM users WHERE email = $1`, [EMAIL]))[0];

  beforeAll(async () => {
    ds = await openIntDb();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label = $1`, [EMAIL]);
    await ds.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
    await ds.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'cli')`,
      [EMAIL],
    );
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await ds.query(`DELETE FROM admin_audit_logs WHERE target_label = $1`, [EMAIL]);
    await ds.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
    await closeIntDb(ds);
  });

  it('grants and revokes, leaving a CLI audit row for each', async () => {
    const { id } = await userRow();

    await expect(setSuperAdmin(ds, EMAIL, true)).resolves.toBe('changed');
    expect((await userRow()).is_super_admin).toBe(true);

    await expect(setSuperAdmin(ds, EMAIL, false)).resolves.toBe('changed');
    expect((await userRow()).is_super_admin).toBe(false);

    const shared = {
      actor_id: null,
      actor_email: 'cli',
      target_type: 'user',
      target_id: id,
      target_label: EMAIL,
    };
    expect(await auditRows()).toEqual([
      { ...shared, action: 'super_admin.granted' },
      { ...shared, action: 'super_admin.revoked' },
    ]);
  });

  it('a revoke ends their staff sessions and deletes their unused view-as codes', async () => {
    const { id } = await userRow();
    await setSuperAdmin(ds, EMAIL, true);
    const [tenant] = await ds.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 't') RETURNING id`,
      [`tenant-${EMAIL}`],
    );
    try {
      const [session] = await ds.query(
        `INSERT INTO staff_sessions (id, user_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
        [id],
      );
      const handoff = (used: boolean) =>
        ds.query(
          `INSERT INTO impersonation_handoffs
             (code_hash, actor_id, actor_session_version, staff_session_id, target_id, reason, expires_at, used_at)
           VALUES (md5(random()::text) || md5(random()::text), $1, 0, $2, $3, 'r', now() + interval '1 minute', $4)`,
          [id, session.id, tenant.id, used ? new Date() : null],
        );
      await handoff(false);
      await handoff(true);

      await setSuperAdmin(ds, EMAIL, false);

      const [row] = await ds.query(`SELECT revoked_at, revoked_reason FROM staff_sessions WHERE id = $1`, [session.id]);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe('staff_revoked');
      // The used one stays: it is the record of a view-as that happened.
      const left = await ds.query(`SELECT used_at IS NOT NULL AS used FROM impersonation_handoffs WHERE actor_id = $1`, [id]);
      expect(left).toEqual([{ used: true }]);
    } finally {
      await ds.query(`DELETE FROM users WHERE id = $1`, [tenant.id]);
    }
  });

  describe('staff-enrolment', () => {
    const allowances = (userId: string) =>
      ds.query(
        `SELECT id, code_hash, extract(epoch FROM expires_at - now()) AS left, used_at, voided_at, voided_reason
           FROM staff_enrolment_allowances WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );

    it('makes a one-time code for 24 hours, kept only as its hash, audited with its id', async () => {
      const { id } = await userRow();
      await setSuperAdmin(ds, EMAIL, true);
      const issued = await staffEnrolment(ds, EMAIL);
      // 32 random bytes: well over the 128 bits a guess would have to beat.
      expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Math.abs(issued.expiresAt.getTime() - Date.now() - 24 * 3_600_000)).toBeLessThan(60_000);
      const [row] = await allowances(id);
      expect(row.id).toBe(issued.id);
      expect(row.code_hash).toBe(createHash('sha256').update(issued.code).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(issued.code);
      expect(Number(row.left)).toBeGreaterThan(24 * 3600 - 60);
      expect(Number(row.left)).toBeLessThanOrEqual(24 * 3600);
      const audit = await auditRows();
      expect(audit.map((r: { action: string }) => r.action)).toEqual(['super_admin.granted', 'staff.enrolment_allowed']);
      const [allowed] = await ds.query(
        `SELECT metadata FROM admin_audit_logs WHERE target_id = $1 AND action = 'staff.enrolment_allowed'`,
        [id],
      );
      expect(allowed.metadata).toMatchObject({ allowanceId: issued.id, until: issued.expiresAt.toISOString() });
      expect(JSON.stringify(allowed)).not.toContain(issued.code);
    });

    it('voids the earlier code when run again, so only the newest one works', async () => {
      const { id } = await userRow();
      await setSuperAdmin(ds, EMAIL, true);
      const first = await staffEnrolment(ds, EMAIL);
      const second = await staffEnrolment(ds, EMAIL);
      expect(second.code).not.toBe(first.code);
      const rows = await allowances(id);
      expect(rows.map((r: { id: string; voided_reason: string | null }) => [r.id, r.voided_reason])).toEqual([
        [first.id, 'replaced'],
        [second.id, null],
      ]);
    });

    it('refuses someone who is not a super admin, changing nothing', async () => {
      const { id } = await userRow();
      await expect(staffEnrolment(ds, EMAIL)).rejects.toThrow(SuperAdminCliError);
      expect(await allowances(id)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('refuses an unknown address', async () => {
      await expect(staffEnrolment(ds, 'nobody-staff-enrolment@test.local')).rejects.toThrow('No user');
    });
  });

  it('refuses an unknown email and writes nothing', async () => {
    await expect(setSuperAdmin(ds, 'nobody@test.local', true)).rejects.toThrow(SuperAdminCliError);
    expect(await auditRows()).toEqual([]);
  });

  it('a repeated grant changes nothing and is not audited twice', async () => {
    await setSuperAdmin(ds, EMAIL, true);
    await expect(setSuperAdmin(ds, EMAIL, true)).resolves.toBe('unchanged');
    expect(await auditRows()).toHaveLength(1);
  });

  it('refuses to grant to a suspended account', async () => {
    await ds.query(`UPDATE users SET suspended_at = now() WHERE email = $1`, [EMAIL]);

    await expect(setSuperAdmin(ds, EMAIL, true)).rejects.toThrow('suspended');
    expect((await userRow()).is_super_admin).toBe(false);
  });

  it('rolls the flag back when the audit row cannot be written', async () => {
    jest.spyOn(AdminAuditService.prototype, 'record').mockRejectedValueOnce(new Error('disk full'));

    await expect(setSuperAdmin(ds, EMAIL, true)).rejects.toThrow('disk full');

    expect((await userRow()).is_super_admin).toBe(false);
  });

  describe('factors-reset', () => {
    const countOf = async (table: string, id: string) =>
      (await ds.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [id]))[0].n;

    it('removes every factor, ends every session, and leaves an audit row', async () => {
      const { id } = await userRow();
      await ds.query(`INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', now())`, [id]);
      await ds.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, 'x')`, [id]);
      await ds.query(
        `INSERT INTO auth_sessions (id, user_id, current_jti) VALUES (gen_random_uuid(), $1, gen_random_uuid())`,
        [id],
      );

      await resetAccountFactors(ds, EMAIL, VERIFIED);

      expect(await countOf('totp_secrets', id)).toBe(0);
      expect(await countOf('recovery_codes', id)).toBe(0);
      const [{ live }] = await ds.query(`SELECT count(*)::int AS live FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      expect(live).toBe(0);
      const [{ session_version }] = await ds.query(`SELECT session_version FROM users WHERE id = $1`, [id]);
      expect(session_version).toBe(1);
      expect((await auditRows())[0]).toMatchObject({ actor_email: 'cli', action: 'account.factors_reset', target_id: id });
      const [{ metadata }] = await ds.query(`SELECT metadata FROM admin_audit_logs WHERE target_id = $1`, [id]);
      expect(metadata).toEqual({
        verificationMethod: VERIFIED.method,
        verificationNotes: VERIFIED.notes,
        lastPasswordResetAt: null,
        passwordResetOverride: null,
      });
      // Password resets by email and team admins are refused on this for 14 days.
      const [{ recent }] = await ds.query(
        `SELECT factors_reset_at > now() - interval '1 minute' AS recent FROM users WHERE id = $1`,
        [id],
      );
      expect(recent).toBe(true);
    });

    it.each([
      ['no method', { method: '', notes: VERIFIED.notes }],
      ['email as the method', { method: 'email', notes: VERIFIED.notes }],
      ['notes too short', { method: 'video_call', notes: 'ok' }],
    ])('refuses %s, removing nothing', async (_, verification) => {
      const { id } = await userRow();
      await ds.query(`INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', now())`, [id]);

      await expect(resetAccountFactors(ds, EMAIL, verification as never)).rejects.toThrow(SuperAdminCliError);
      expect(await countOf('totp_secrets', id)).toBe(1);
      expect(await auditRows()).toEqual([]);
    });

    it('refuses a super admin, removing nothing', async () => {
      await setSuperAdmin(ds, EMAIL, true);
      const { id } = await userRow();
      await ds.query(`INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', now())`, [id]);

      await expect(resetAccountFactors(ds, EMAIL, VERIFIED)).rejects.toThrow(SuperAdminCliError);
      expect(await countOf('totp_secrets', id)).toBe(1);
    });

    it('refuses an address nobody has', async () => {
      await expect(resetAccountFactors(ds, 'nobody@super-admin-int.test', VERIFIED)).rejects.toThrow(SuperAdminCliError);
    });

    describe('soon after a password reset', () => {
      const JUSTIFIED = 'Owner on a video call with ID; the reset was theirs';
      const addTotp = (id: string) =>
        ds.query(`INSERT INTO totp_secrets (user_id, secret_ciphertext, confirmed_at) VALUES ($1, 'x', now())`, [id]);
      const passwordResetDaysAgo = async (id: string, days: number) =>
        (
          await ds.query(
            `UPDATE users SET password_reset_at = now() - make_interval(days => $2) WHERE id = $1
             RETURNING password_reset_at AS at`,
            [id, days],
          )
        )[0][0].at as Date;

      // The mailbox holder resets the password, the panel refuses, and staff reach for
      // the CLI: it must not hand over the account any more readily than the panel.
      it('refuses within 14 days, saying when, and removes nothing', async () => {
        const { id } = await userRow();
        await addTotp(id);
        const at = await passwordResetDaysAgo(id, 13);
        const said: string[] = [];

        const refusal = resetAccountFactors(ds, EMAIL, VERIFIED, (line) => said.push(line));
        await expect(refusal).rejects.toThrow(SuperAdminCliError);
        await expect(refusal).rejects.toThrow(new Date(at).toISOString());
        await expect(refusal).rejects.toThrow('--recent-reset-justification');

        expect(await countOf('totp_secrets', id)).toBe(1);
        expect(await auditRows()).toEqual([]);
        const [{ factors_reset_at }] = await ds.query(`SELECT factors_reset_at FROM users WHERE id = $1`, [id]);
        expect(factors_reset_at).toBeNull();
      });

      it('goes ahead with a justification, keeping it and the reset time in the audit entry', async () => {
        const { id } = await userRow();
        await addTotp(id);
        const at = await passwordResetDaysAgo(id, 3);
        const said: string[] = [];

        await resetAccountFactors(ds, EMAIL, { ...VERIFIED, recentResetJustification: JUSTIFIED }, (line) =>
          said.push(line),
        );

        expect(await countOf('totp_secrets', id)).toBe(0);
        const [{ metadata }] = await ds.query(`SELECT metadata FROM admin_audit_logs WHERE target_id = $1`, [id]);
        expect(metadata).toMatchObject({
          lastPasswordResetAt: new Date(at).toISOString(),
          passwordResetOverride: JUSTIFIED,
        });
        expect(said.join('\n')).toContain(new Date(at).toISOString());
      });

      it('is not stopped by a reset more than 14 days old, which it still shows', async () => {
        const { id } = await userRow();
        await addTotp(id);
        const at = await passwordResetDaysAgo(id, 15);
        const said: string[] = [];

        await resetAccountFactors(ds, EMAIL, VERIFIED, (line) => said.push(line));

        expect(await countOf('totp_secrets', id)).toBe(0);
        expect(said.join('\n')).toContain(new Date(at).toISOString());
        const [{ metadata }] = await ds.query(`SELECT metadata FROM admin_audit_logs WHERE target_id = $1`, [id]);
        expect(metadata).toMatchObject({ lastPasswordResetAt: new Date(at).toISOString(), passwordResetOverride: null });
      });

      it('says when there has never been a reset', async () => {
        const said: string[] = [];
        await resetAccountFactors(ds, EMAIL, VERIFIED, (line) => said.push(line));
        expect(said.join('\n')).toMatch(/last password reset of .*: never/i);
      });

      it('refuses a justification too short to say anything', async () => {
        const { id } = await userRow();
        await addTotp(id);
        await passwordResetDaysAgo(id, 1);

        await expect(
          resetAccountFactors(ds, EMAIL, { ...VERIFIED, recentResetJustification: 'ok' }, () => undefined),
        ).rejects.toThrow(SuperAdminCliError);
        expect(await countOf('totp_secrets', id)).toBe(1);
      });
    });
  });

  describe('password-reset-link', () => {
    const APP_URL = 'https://app.chumbaq.test';
    const HOUR_MS = 60 * 60 * 1000;
    const JUSTIFIED = 'Lost both keys and the password manager with the laptop';
    const tokensOf = async (id: string) =>
      ds.query(
        `SELECT staff_issued, used_at, usable_after, expires_at FROM account_tokens WHERE user_id = $1 ORDER BY created_at`,
        [id],
      );
    const metadataOf = async (id: string) =>
      (
        await ds.query(
          `SELECT metadata FROM admin_audit_logs WHERE target_id = $1 AND action = 'account.password_reset_link_issued'`,
          [id],
        )
      ).map((row: { metadata: unknown }) => row.metadata);
    /** The owner's notices, as the fake records them, and whether sending works. */
    let told: string[] = [];
    let email = { configured: true, delivers: true };
    /** Unused staff links another connection could see when each notice went out. */
    let committedAtNotice: number[] = [];
    const notices = {
      canSend: () => email.configured,
      sendStaffResetLinkIssued: async (owner: { email: string }, usableAt: Date) => {
        told.push(`${owner.email} ${usableAt.toISOString()}`);
        const [{ n }] = await ds.query(
          `SELECT count(*)::int AS n FROM account_tokens t JOIN users u ON u.id = t.user_id
            WHERE u.email = $1 AND t.staff_issued AND t.used_at IS NULL`,
          [owner.email],
        );
        committedAtNotice.push(n);
        // Brevo takes a while; long enough here for a second run to reach step 1.
        if (noticeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, noticeDelayMs));
        return email.delivers;
      },
    };
    let noticeDelayMs = 0;
    const issue = (
      address: string,
      request: Parameters<typeof issuePasswordResetLink>[2] = VERIFIED,
      delayMs?: number,
    ) => issuePasswordResetLink(ds, address, request, APP_URL, notices, () => undefined, delayMs);

    beforeEach(() => {
      told = [];
      committedAtNotice = [];
      email = { configured: true, delivers: true };
      noticeDelayMs = 0;
    });

    /**
     * Two operators, or a retried CLI, issuing for the same person at once. Both used to
     * commit a row and email the owner; the first to finish then spent the other's row
     * and the other reported, falsely, that the owner had signed in.
     */
    describe('two runs at once', () => {
      it('lets one through and refuses the other before it tells the owner anything', async () => {
        const { id } = await userRow();
        noticeDelayMs = 300;

        const results = await Promise.allSettled([issue(EMAIL), issue(EMAIL)]);

        const issued = results.filter((r) => r.status === 'fulfilled');
        const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(issued).toHaveLength(1);
        expect(refused).toHaveLength(1);
        const [first] = await tokensOf(id);
        const [{ created_at: startedAt }] = await ds.query(
          `SELECT created_at FROM account_tokens WHERE user_id = $1`,
          [id],
        );
        expect(refused[0].reason).toBeInstanceOf(SuperAdminCliError);
        expect(refused[0].reason.message).toContain(`already being issued for ${EMAIL}`);
        expect(refused[0].reason.message).toContain(startedAt.toISOString());
        expect(refused[0].reason.message).not.toMatch(/signed in/);
        // One notice, one row, and that row is the live link that was printed.
        expect(told).toHaveLength(1);
        expect(await tokensOf(id)).toHaveLength(1);
        expect(first.used_at).toBeNull();
        expect(await metadataOf(id)).toHaveLength(1);
      });

      // A run that died between committing its row and writing the audit entry holds
      // others off only for a few minutes, after which a new run replaces its row.
      it('holds off a new run only while the other could still be sending its notice', async () => {
        const { id } = await userRow();
        await ds.query(
          `INSERT INTO account_tokens (user_id, purpose, token_hash, staff_issued, usable_after, expires_at, created_at)
           VALUES ($1, 'reset_password', 'stalled', true, now() + interval '1 day', now() + interval '2 days',
                   now() - interval '2 minutes')`,
          [id],
        );

        await expect(issue(EMAIL)).rejects.toThrow(/already being issued/);
        expect(told).toEqual([]);

        await ds.query(`UPDATE account_tokens SET created_at = now() - interval '11 minutes' WHERE user_id = $1`, [id]);
        await expect(issue(EMAIL)).resolves.toBeDefined();
        const [stalled, fresh] = await tokensOf(id);
        expect(stalled.used_at).not.toBeNull();
        expect(fresh.used_at).toBeNull();
      });

      it('does not count a link whose issue was finished as one still being issued', async () => {
        const { id } = await userRow();
        await issue(EMAIL);
        await expect(issue(EMAIL)).resolves.toBeDefined();
        expect(await metadataOf(id)).toHaveLength(2);
      });
    });

    it('issues one staff link, replacing an unused one, and audits how they were verified', async () => {
      const { id } = await userRow();
      await ds.query(
        `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at)
         VALUES ($1, 'reset_password', 'emailed', now() + interval '30 minutes')`,
        [id],
      );

      const { link } = await issue(EMAIL);

      expect(link).toMatch(/^https:\/\/app\.chumbaq\.test\/reset-password#token=[\w-]{43}$/);
      const [emailed, staff] = await tokensOf(id);
      expect(emailed.used_at).not.toBeNull();
      expect(staff).toMatchObject({ staff_issued: true, used_at: null });
      expect((await auditRows())[0]).toMatchObject({ actor_email: 'cli', action: 'account.password_reset_link_issued' });
    });

    // The owner's time to notice: the link does nothing until the wait is over, then
    // lasts a day, and the notice and the audit entry both give that time.
    it('waits the delay before the link works, then keeps it for 24 hours', async () => {
      const { id } = await userRow();
      const before = Date.now();

      const issued = await issue(EMAIL, VERIFIED, 3 * HOUR_MS);

      const [row] = await tokensOf(id);
      expect(row.usable_after.getTime()).toBeGreaterThanOrEqual(before + 3 * HOUR_MS - 1000);
      expect(row.usable_after.getTime()).toBeLessThanOrEqual(Date.now() + 3 * HOUR_MS + 1000);
      expect(row.expires_at.getTime() - row.usable_after.getTime()).toBe(24 * HOUR_MS);
      expect(issued.usableAt.getTime()).toBe(row.usable_after.getTime());
      expect(issued.expiresAt.getTime()).toBe(row.expires_at.getTime());
      expect((await metadataOf(id))[0]).toMatchObject({
        usableAfter: row.usable_after.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      });
    });

    it('reads the delay from STAFF_LINK_DELAY_HOURS, 24 hours by default', async () => {
      const { id } = await userRow();
      const saved = process.env.STAFF_LINK_DELAY_HOURS;
      try {
        delete process.env.STAFF_LINK_DELAY_HOURS;
        const before = Date.now();
        await issue(EMAIL);
        const [row] = await tokensOf(id);
        expect(row.usable_after.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR_MS - 1000);

        process.env.STAFF_LINK_DELAY_HOURS = '0';
        await expect(issue(EMAIL)).rejects.toThrow('STAFF_LINK_DELAY_HOURS');
      } finally {
        if (saved === undefined) delete process.env.STAFF_LINK_DELAY_HOURS;
        else process.env.STAFF_LINK_DELAY_HOURS = saved;
      }
    });

    it('emails the owner that support issued a link, and records that in the audit entry', async () => {
      const { id } = await userRow();

      const issued = await issue(EMAIL);

      expect(told).toEqual([`${EMAIL} ${issued.usableAt.toISOString()}`]);
      expect((await metadataOf(id))[0]).toMatchObject({ ownerNotified: true });
    });

    it('issues nothing when account email is not set up, since the owner would not hear of it', async () => {
      email = { configured: false, delivers: false };
      const { id } = await userRow();
      await expect(issue(EMAIL)).rejects.toThrow(SuperAdminCliError);
      expect(await tokensOf(id)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    // The link is committed before the notice goes, so a sign-in the notice prompts can
    // see it and void it. Held uncommitted under the user lock, as it once was, a sign-in
    // in that window found nothing to void and the link went live anyway.
    it('sends the notice only once the link is committed', async () => {
      await issue(EMAIL);
      expect(committedAtNotice).toEqual([1]);
    });

    it('spends the link and prints nothing when the notice is not accepted, keeping other links', async () => {
      email = { configured: true, delivers: false };
      const { id } = await userRow();
      await ds.query(
        `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at)
         VALUES ($1, 'reset_password', 'emailed', now() + interval '30 minutes')`,
        [id],
      );

      await expect(issue(EMAIL)).rejects.toThrow(/notice .* was not sent/);

      const [emailed, staff] = await tokensOf(id);
      expect(emailed).toMatchObject({ staff_issued: false, used_at: null });
      expect(staff.staff_issued).toBe(true);
      expect(staff.used_at).not.toBeNull();
      const actions = (await auditRows()).map((row: { action: string }) => row.action);
      expect(actions).not.toContain('account.password_reset_link_issued');
      expect(actions).toContain('account.password_reset_link_cancelled');
    });

    describe('soon after staff removed the factors', () => {
      beforeEach(async () => {
        await ds.query(`UPDATE users SET factors_reset_at = now() - interval '2 days' WHERE email = $1`, [EMAIL]);
      });

      it('refuses without its own justification, issuing nothing and telling nobody', async () => {
        const { id } = await userRow();
        await expect(issue(EMAIL)).rejects.toThrow('--recent-factor-reset-justification');
        expect(await tokensOf(id)).toEqual([]);
        expect(told).toEqual([]);
      });

      it('goes ahead with one, keeping it and the reset time in the audit entry', async () => {
        const { id } = await userRow();
        await issue(EMAIL, { ...VERIFIED, recentFactorResetJustification: JUSTIFIED });

        const [{ at }] = await ds.query(`SELECT factors_reset_at AS at FROM users WHERE id = $1`, [id]);
        expect((await metadataOf(id))[0]).toMatchObject({
          recentFactorResetJustification: JUSTIFIED,
          factorsResetAt: at.toISOString(),
        });
      });

      it('refuses a justification too short to say anything', async () => {
        await expect(issue(EMAIL, { ...VERIFIED, recentFactorResetJustification: 'lost it' })).rejects.toThrow(
          '--recent-factor-reset-justification',
        );
      });
    });

    it('needs no factor-reset justification once the window has passed', async () => {
      await ds.query(`UPDATE users SET factors_reset_at = now() - interval '15 days' WHERE email = $1`, [EMAIL]);
      await expect(issue(EMAIL)).resolves.toBeDefined();
    });

    it('refuses a super admin unless the operator confirms it is one', async () => {
      await ds.query(`UPDATE users SET is_super_admin = true WHERE email = $1`, [EMAIL]);
      const { id } = await userRow();

      await expect(issue(EMAIL)).rejects.toThrow('--confirm-super-admin');
      expect(await tokensOf(id)).toEqual([]);

      await issue(EMAIL, { ...VERIFIED, confirmSuperAdmin: true });
      expect((await metadataOf(id))[0]).toMatchObject({ superAdmin: true });
    });

    it.each([
      ['an unknown address', 'nobody@test.local', async () => undefined],
      ['a suspended account', EMAIL, () => ds.query(`UPDATE users SET suspended_at = now() WHERE email = $1`, [EMAIL])],
    ])('refuses %s, issuing nothing', async (_, address, prepare) => {
      await prepare();
      const { id } = await userRow();
      await expect(issue(address)).rejects.toThrow(SuperAdminCliError);
      expect(await tokensOf(id)).toEqual([]);
      expect(await auditRows()).toEqual([]);
      expect(told).toEqual([]);
    });

    it('refuses without an address for the link', async () => {
      await expect(issuePasswordResetLink(ds, EMAIL, VERIFIED, undefined, notices)).rejects.toThrow('APP_URL');
    });
  });

  describe('passkeys-reset', () => {
    const addKey = (userId: string) =>
      ds.query(
        `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_type, backed_up, name)
         VALUES ($1, $2, '\\x00', 'singleDevice', false, 'k')`,
        [userId, `${userId}-${Math.random()}`],
      );
    const makeAdmin = async () => {
      await setSuperAdmin(ds, EMAIL, true);
      await ds.query(`DELETE FROM admin_audit_logs WHERE target_label = $1`, [EMAIL]);
      return (await userRow()).id as string;
    };

    it('removes the keys, ends every session, and leaves an audit row', async () => {
      const id = await makeAdmin();
      await addKey(id);
      await addKey(id);
      await ds.query(
        `INSERT INTO auth_sessions (id, user_id, current_jti) VALUES (gen_random_uuid(), $1, gen_random_uuid())`,
        [id],
      );
      await ds.query(`INSERT INTO staff_sessions (id, user_id) VALUES (gen_random_uuid(), $1)`, [id]);

      expect(await resetSuperAdminPasskeys(ds, EMAIL)).toBe(2);
      const [staffSession] = await ds.query(`SELECT revoked_reason FROM staff_sessions WHERE user_id = $1`, [id]);
      expect(staffSession.revoked_reason).toBe('factors_reset');

      const [{ keys }] = await ds.query(`SELECT count(*)::int AS keys FROM webauthn_credentials WHERE user_id = $1`, [id]);
      const [{ live }] = await ds.query(`SELECT count(*)::int AS live FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      const [{ session_version }] = await ds.query(`SELECT session_version FROM users WHERE id = $1`, [id]);
      expect({ keys, live, session_version }).toEqual({ keys: 0, live: 0, session_version: 1 });
      const [row] = await auditRows();
      expect(row).toMatchObject({ actor_id: null, actor_email: 'cli', action: 'super_admin.passkeys_reset', target_id: id });
    });

    it('refuses anyone who is not a super admin, removing nothing', async () => {
      const { id } = await userRow();
      await addKey(id);

      await expect(resetSuperAdminPasskeys(ds, EMAIL)).rejects.toThrow(SuperAdminCliError);

      const [{ keys }] = await ds.query(`SELECT count(*)::int AS keys FROM webauthn_credentials WHERE user_id = $1`, [id]);
      expect(keys).toBe(1);
      expect(await auditRows()).toHaveLength(0);
    });

    it('refuses an unknown address', async () => {
      await expect(resetSuperAdminPasskeys(ds, 'nobody@test.local')).rejects.toThrow(SuperAdminCliError);
    });

    // Without this, someone holding the admin's mailbox who talks an operator into a
    // passkey reset could then reset the password by email and enrol their own keys.
    it('blocks password resets by email and team for 14 days, as the tenant reset does', async () => {
      const id = await makeAdmin();
      await addKey(id);

      await resetSuperAdminPasskeys(ds, EMAIL, null, () => undefined);

      const [{ recent }] = await ds.query(
        `SELECT factors_reset_at > now() - interval '1 minute' AS recent FROM users WHERE id = $1`,
        [id],
      );
      expect(recent).toBe(true);
    });

    it('refuses within 14 days of a password reset unless justified, saying when', async () => {
      const id = await makeAdmin();
      await addKey(id);
      const [[{ at }]] = await ds.query(
        `UPDATE users SET password_reset_at = now() - interval '2 days' WHERE id = $1 RETURNING password_reset_at AS at`,
        [id],
      );

      const refusal = resetSuperAdminPasskeys(ds, EMAIL, null, () => undefined);
      await expect(refusal).rejects.toThrow(SuperAdminCliError);
      await expect(refusal).rejects.toThrow(new Date(at).toISOString());
      const [{ keys }] = await ds.query(`SELECT count(*)::int AS keys FROM webauthn_credentials WHERE user_id = $1`, [id]);
      expect(keys).toBe(1);
      expect(await auditRows()).toHaveLength(0);

      const said: string[] = [];
      const justification = 'Called them on their known number; they reset it';
      await expect(resetSuperAdminPasskeys(ds, EMAIL, justification, (line) => said.push(line))).resolves.toBe(1);
      expect(said.join('\n')).toContain(new Date(at).toISOString());
      const [{ metadata }] = await ds.query(
        `SELECT metadata FROM admin_audit_logs WHERE target_id = $1 AND action = 'super_admin.passkeys_reset'`,
        [id],
      );
      expect(metadata).toEqual({
        removed: 1,
        lastPasswordResetAt: new Date(at).toISOString(),
        passwordResetOverride: justification,
      });
    });
  });
});
