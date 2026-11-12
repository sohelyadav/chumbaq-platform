import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { REAUTH_REQUIRED_MESSAGE } from '../auth/guards/recent-auth.guard';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL, type ProjectRole } from './project-permissions';
import { SEAT_LIMIT_MESSAGE } from './seats.service';
import { IMPERSONATION_READ_ONLY } from './view-as';

/**
 * Invitations over HTTP against the real app and database. The anti-goal is invite
 * takeover: an invite accepted by anyone but the person it was sent to. So: the token
 * is stored only as a hash and never logged, accepting needs the invited address (and
 * a verified one where platform email exists), a token works once even when two
 * accepts arrive together, and the seat limit holds against invites racing on two
 * projects of one account.
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@invitations-int.test';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const GONE = 'This invite has expired or was already used.';
const ALREADY_MEMBER = 'They are already a member of this project.';
const VERIFY_FIRST = 'Verify your email address first, then open the invite again.';
const SUSPENDED = "This project's account is suspended.";

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Invitations (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  let seq = 0;

  const savedEnv = {
    key: process.env.PLATFORM_BREVO_API_KEY,
    from: process.env.PLATFORM_EMAIL_FROM,
    seats: process.env.MAX_SEATS_PER_ACCOUNT,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  /** As account-recovery.int-spec.ts: a key and sender, with Brevo answered here. */
  const platformEmailOn = () => {
    process.env.PLATFORM_BREVO_API_KEY = 'xkeysib-test';
    process.env.PLATFORM_EMAIL_FROM = 'Chumbaq <no-reply@chumbaq.test>';
  };
  /** Empty rather than deleted: an unset variable would fall through to the .env file. */
  const platformEmailOff = () => {
    process.env.PLATFORM_BREVO_API_KEY = '';
  };

  let emails: Array<{ to: string; subject: string; html: string; text: string }> = [];
  let brevo: 'ok' | 'refuses' = 'ok';
  const realFetch = global.fetch;

  /** Every line any Nest logger wrote during the suite, and every raw token or URL it saw. */
  const logged: string[] = [];
  const secretsSeen: string[] = [];

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  interface Person {
    id: string;
    email: string;
    token: string;
    /** Signed in an hour ago: past RecentAuthGuard's window. */
    staleToken: string;
  }

  const person = async (label: string, opts: { verified?: boolean } = {}): Promise<Person> => {
    const email = `${label}-${++seq}${DOMAIN}`;
    const id = (
      await ds.getRepository(UserEntity).save({
        email,
        name: `Name ${label}`,
        passwordHash: 'x',
        emailVerifiedAt: opts.verified ? new Date() : null,
      })
    ).id;
    const now = Math.floor(Date.now() / 1000);
    const sign = (authTime: number) => jwt.signAsync({ sub: id, email, type: 'access', auth_time: authTime });
    return { id, email, token: await sign(now), staleToken: await sign(now - 3600) };
  };

  /** An address with no account yet. */
  const newAddress = (label: string) => `${label}-${++seq}${DOMAIN}`;

  const project = async (billing: Person, others: Array<[Person, ProjectRole]> = [], name = 'Acme'): Promise<string> => {
    const id = (await ds.getRepository(ProjectEntity).save({ name, ownerId: billing.id })).id;
    await addOwnerMember(ds, id, billing.id);
    for (const [p, role] of others) await addOwnerMember(ds, id, p.id, role);
    return id;
  };

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await realFetch(`${base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };

  /** The raw token from an invite URL, remembered so the log check can look for it. */
  const tokenOf = (inviteUrl: string): string => {
    const match = /#token=([A-Za-z0-9_-]{43})$/.exec(inviteUrl);
    if (!match) throw new Error(`not an invite URL: ${inviteUrl}`);
    secretsSeen.push(inviteUrl, match[1]);
    return match[1];
  };

  const invite = async (inviter: Person, projectId: string, email: string, role: ProjectRole = 'member') => {
    const res = await call('POST', `/projects/${projectId}/invitations`, inviter.token, { email, role });
    if (res.status === 201) tokenOf(res.json.data.inviteUrl);
    return res;
  };

  const invited = async (inviter: Person, projectId: string, email: string, role: ProjectRole = 'member') => {
    const res = await invite(inviter, projectId, email, role);
    expect(res.status).toBe(201);
    return { id: res.json.data.invitation.id as string, token: tokenOf(res.json.data.inviteUrl) };
  };

  const accept = (who: Person, token: string) => call('POST', '/invitations/accept', who.token, { token });

  const memberRole = async (projectId: string, userId: string): Promise<ProjectRole | undefined> => {
    const [row] = await ds.query(`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
    return row?.role;
  };

  const invitationRow = async (id: string) => {
    const [row] = await ds.query(`SELECT * FROM project_invitations WHERE id = $1`, [id]);
    return row;
  };

  const setSeatLimit = (userId: string, limit: number | null) =>
    ds.query(`UPDATE users SET seat_limit = $2 WHERE id = $1`, [userId, limit]);

  beforeAll(async () => {
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      const capture = (...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      };
      jest.spyOn(Logger.prototype, method).mockImplementation(capture);
      jest.spyOn(Logger, method).mockImplementation(capture);
    }
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) !== BREVO_URL) return realFetch(url, init);
      if (brevo === 'refuses') {
        return new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 });
      }
      const body = JSON.parse(init?.body as string);
      emails.push({ to: body.to[0].email, subject: body.subject, html: body.htmlContent, text: body.textContent });
      return new Response('{}', { status: 201 });
    });

    // No seat limit unless a test sets `users.seat_limit`; empty, so the .env file cannot set one.
    process.env.MAX_SEATS_PER_ACCOUNT = '';
    platformEmailOff();
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
  }, 120000);

  beforeEach(() => {
    platformEmailOff();
    emails = [];
    brevo = 'ok';
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
    restore('PLATFORM_BREVO_API_KEY', savedEnv.key);
    restore('PLATFORM_EMAIL_FROM', savedEnv.from);
    restore('MAX_SEATS_PER_ACCOUNT', savedEnv.seats);
    jest.restoreAllMocks();
  });

  describe('creating', () => {
    it('returns the link once, with the token in the fragment, and stores only its hash', async () => {
      const x = await person('x');
      const p = await project(x);
      const email = newAddress('new');

      const res = await invite(x, p, email, 'admin');

      expect(res.status).toBe(201);
      const { invitation, inviteUrl, emailSent } = res.json.data;
      expect(emailSent).toBe(false);
      expect(inviteUrl).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);
      expect(inviteUrl).not.toContain('?');
      expect(invitation).toEqual({
        id: expect.any(String),
        email,
        role: 'admin',
        invitedBy: { id: x.id, name: 'Name x' },
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
        expired: false,
      });
      const days = (new Date(invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThanOrEqual(7);

      const token = tokenOf(inviteUrl);
      const [row] = await ds.query(`SELECT i.*, row_to_json(i)::text AS whole FROM project_invitations i WHERE id = $1`, [invitation.id]);
      expect(row.whole).not.toContain(token);
      expect(row.token_hash).toBe(sha256(token));

      // The list never carries a token or its hash.
      const list = await call('GET', `/projects/${p}/invitations`, x.token);
      expect(list.status).toBe(200);
      expect(list.json.data).toEqual([invitation]);
      expect(list.text).not.toContain(row.token_hash);
    });

    it('emails the invite when platform email is set up, and says so when Brevo refuses', async () => {
      platformEmailOn();
      const x = await person('x');
      const p = await project(x, [], '<script>alert(1)</script>');
      const email = newAddress('mailed');

      const sent = await invite(x, p, email);
      expect(sent.json.data.emailSent).toBe(true);
      expect(emails).toHaveLength(1);
      expect(emails[0].to).toBe(email);
      expect(emails[0].text).toContain(sent.json.data.inviteUrl);
      expect(emails[0].html).toContain(sent.json.data.inviteUrl);
      expect(emails[0].html).not.toContain('<script');
      expect(emails[0].text).toContain('Name x');

      brevo = 'refuses';
      const refused = await invite(x, p, newAddress('refused'));
      expect(refused.status).toBe(201);
      expect(refused.json.data.emailSent).toBe(false);
      // The invite exists all the same, and can be resent.
      const list = await call('GET', `/projects/${p}/invitations`, x.token);
      expect(list.json.data).toHaveLength(2);
    });

    it('refuses an address that is already a member', async () => {
      const [x, m] = [await person('x'), await person('m')];
      const p = await project(x, [[m, 'member']]);

      const res = await invite(x, p, `  ${m.email.toUpperCase()} `);
      expect(res.status).toBe(409);
      expect(res.json.message).toBe(ALREADY_MEMBER);
    });

    it('lets only owners invite owners, and only with a recent sign-in', async () => {
      const [x, a] = [await person('x'), await person('a')];
      const p = await project(x, [[a, 'admin']]);

      const byAdmin = await invite(a, p, newAddress('o'), 'owner');
      expect(byAdmin.status).toBe(403);
      expect(byAdmin.json.message).toBe(ROLE_REFUSAL);
      expect((await invite(a, p, newAddress('m'), 'member')).status).toBe(201);
      expect((await invite(a, p, newAddress('ad'), 'admin')).status).toBe(201);

      const stale = await call('POST', `/projects/${p}/invitations`, x.staleToken, { email: newAddress('o'), role: 'owner' });
      expect(stale.status).toBe(403);
      expect(stale.json.message).toBe(REAUTH_REQUIRED_MESSAGE);
      expect((await invite(x, p, newAddress('o'), 'owner')).status).toBe(201);
    });

    it('does not let an admin replace a pending owner invite by inviting the address again', async () => {
      const [x, a] = [await person('x'), await person('a')];
      const p = await project(x, [[a, 'admin']]);
      const sam = await person('sam');
      const ownerInvite = await invited(x, p, sam.email, 'owner');

      for (const role of ['member', 'admin', 'owner'] as ProjectRole[]) {
        const res = await invite(a, p, sam.email, role);
        expect({ role, status: res.status, message: res.json.message }).toEqual({ role, status: 403, message: ROLE_REFUSAL });
      }
      const row = await invitationRow(ownerInvite.id);
      expect(row.role).toBe('owner');
      expect(row.token_hash).toBe(sha256(ownerInvite.token));
      // The owner's link still works, as an owner.
      expect((await accept(sam, ownerInvite.token)).json.data).toEqual({ projectId: p, role: 'owner' });
    });

    it('refuses a member and a stranger, and a bad role or address', async () => {
      const [x, m, o] = [await person('x'), await person('m'), await person('o')];
      const p = await project(x, [[m, 'member']]);

      const byMember = await invite(m, p, newAddress('n'));
      expect(byMember.status).toBe(403);
      expect(byMember.json.message).toBe(ROLE_REFUSAL);
      const byStranger = await invite(o, p, newAddress('n'));
      expect(byStranger.status).toBe(404);
      expect(byStranger.json.message).toBe(PROJECT_NOT_FOUND);
      expect((await invite(x, p, newAddress('n'), 'boss' as ProjectRole)).status).toBe(400);
      expect((await invite(x, p, 'not-an-address')).status).toBe(400);
    });

    it('replaces an expired invite in place: same row, new token, and the old token stops working', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const first = await invited(x, p, sam.email);
      await ds.query(`UPDATE project_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, [first.id]);

      const listed = await call('GET', `/projects/${p}/invitations`, x.token);
      expect(listed.json.data).toEqual([expect.objectContaining({ id: first.id, expired: true })]);

      const second = await invited(x, p, sam.email, 'admin');
      expect(second.id).toBe(first.id);
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM project_invitations WHERE project_id = $1`, [p]);
      expect(n).toBe(1);
      expect((await invitationRow(first.id)).role).toBe('admin');

      const old = await accept(sam, first.token);
      expect(old.status).toBe(400);
      expect(old.json.message).toBe(GONE);
      expect((await accept(sam, second.token)).status).toBe(201);
      expect(await memberRole(p, sam.id)).toBe('admin');
    });
  });

  describe('accepting', () => {
    it('makes the invited person a member, the address matched however the inviter typed it', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const { id, token } = await invited(x, p, `  ${sam.email.toUpperCase()} `, 'admin');
      expect((await invitationRow(id)).email).toBe(sam.email);

      const res = await accept(sam, token);
      expect(res.status).toBe(201);
      expect(res.json.data).toEqual({ projectId: p, role: 'admin' });
      expect(await memberRole(p, sam.id)).toBe('admin');
      const row = await invitationRow(id);
      expect(row.accepted_by).toBe(sam.id);
      expect(row.accepted_at).not.toBeNull();
      const [{ added_by: addedBy }] = await ds.query(
        `SELECT added_by FROM project_members WHERE project_id = $1 AND user_id = $2`,
        [p, sam.id],
      );
      expect(addedBy).toBe(x.id);
      // Gone from the pending list, and the project now opens for them.
      expect((await call('GET', `/projects/${p}/invitations`, x.token)).json.data).toEqual([]);
      expect((await call('GET', `/projects/${p}/members`, sam.token)).status).toBe(200);
    });

    it('refuses another account, naming the invited address masked, and leaves the token unspent', async () => {
      const x = await person('x');
      const p = await project(x);
      const [sam, mallory] = [await person('sam'), await person('mallory')];
      const { id, token } = await invited(x, p, sam.email);

      const res = await accept(mallory, token);
      expect(res.status).toBe(400);
      const masked = `s***${DOMAIN}`;
      expect(res.json.message).toBe(`This invite was sent to ${masked}. Sign in with that address to accept it.`);
      expect(res.text).not.toContain(sam.email);
      expect(await memberRole(p, mallory.id)).toBeUndefined();
      expect((await invitationRow(id)).accepted_at).toBeNull();

      expect((await accept(sam, token)).status).toBe(201);
    });

    it('needs a verified address where platform email is set up, and not where it is not', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const { id, token } = await invited(x, p, sam.email);

      platformEmailOn();
      const refused = await accept(sam, token);
      expect(refused.status).toBe(400);
      expect(refused.json.message).toBe(VERIFY_FIRST);
      expect((await invitationRow(id)).accepted_at).toBeNull();
      const preview = await call('POST', '/invitations/preview', sam.token, { token });
      expect(preview.json.data.emailVerificationRequired).toBe(true);

      platformEmailOff();
      expect((await accept(sam, token)).status).toBe(201);

      // Verified, with platform email set up: accepted.
      const ver = await person('ver', { verified: true });
      const second = await invited(x, p, ver.email);
      platformEmailOn();
      expect((await accept(ver, second.token)).status).toBe(201);
    });

    it('gives an expired, revoked or used invite, or a made-up token, one generic 400', async () => {
      const x = await person('x');
      const p = await project(x);
      const [e, r, u] = [await person('e'), await person('r'), await person('u')];
      const expired = await invited(x, p, e.email);
      await ds.query(`UPDATE project_invitations SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
      const revoked = await invited(x, p, r.email);
      expect((await call('DELETE', `/projects/${p}/invitations/${revoked.id}`, x.token)).status).toBe(200);
      const used = await invited(x, p, u.email);
      expect((await accept(u, used.token)).status).toBe(201);

      for (const [who, token] of [
        [e, expired.token],
        [r, revoked.token],
        [u, used.token],
        [u, 'A'.repeat(43)],
      ] as const) {
        for (const route of ['accept', 'preview']) {
          const res = await call('POST', `/invitations/${route}`, who.token, { token });
          expect({ route, status: res.status, message: res.json.message }).toEqual({ route, status: 400, message: GONE });
        }
      }
      expect(await memberRole(p, e.id)).toBeUndefined();
      expect(await memberRole(p, r.id)).toBeUndefined();
    });

    it('spends a token once when the same person accepts twice at the same moment', async () => {
      for (let round = 0; round < 5; round++) {
        const x = await person('x');
        const p = await project(x);
        const sam = await person('sam');
        const { token } = await invited(x, p, sam.email);

        const results = await Promise.all([accept(sam, token), accept(sam, token)]);
        const statuses = results.map((r) => r.status).sort();
        expect({ round, statuses }).toEqual({ round, statuses: [201, 400] });
        expect(results.find((r) => r.status === 400)!.json.message).toBe(GONE);
        const [{ n }] = await ds.query(
          `SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND user_id = $2`,
          [p, sam.id],
        );
        expect(n).toBe(1);
      }
    }, 60000);

    it('spends nothing with a token that was replaced while the accept waited for the project lock', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const { id, token: t1 } = await invited(x, p, sam.email, 'owner');

      // Hold the project row, as a re-invite does, while the accept with T1 arrives.
      const holder = ds.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query(`SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE`, [p]);
        const pending = accept(sam, t1);
        // Until the accept is waiting on that lock.
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          [{ n: waiting }] = await ds.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
          );
        }
        expect(waiting).toBeGreaterThan(0);
        // The re-invite the lock holder makes: a new token (T2) and a lower role, same row.
        await holder.query(`UPDATE project_invitations SET token_hash = $2, role = 'member' WHERE id = $1`, [
          id,
          sha256('t2-never-handed-to-anyone'),
        ]);
        await holder.commitTransaction();

        const res = await pending;
        expect(res.status).toBe(400);
        expect(res.json.message).toBe(GONE);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
      }
      expect(await memberRole(p, sam.id)).toBeUndefined();
      const row = await invitationRow(id);
      expect(row.accepted_at).toBeNull();
      expect(row.role).toBe('member');
    }, 30000);

    it('refuses an invite whose inviter no longer holds the access it needs, checked at accept', async () => {
      // Membership changed behind the services' backs, so only accept's own check stands.
      const [x, a, o2] = [await person('x'), await person('a'), await person('o2')];
      const p = await project(x, [[a, 'admin'], [o2, 'owner']]);
      const [s1, s2, s3, s4] = [await person('s1'), await person('s2'), await person('s3'), await person('s4')];
      const byAdmin = await invited(a, p, s1.email);
      const byOwner = await invited(o2, p, s2.email, 'owner');
      const byOwnerMember = await invited(o2, p, s3.email, 'member');
      const orphan = await invited(x, p, s4.email);

      await ds.query(`UPDATE project_members SET role = 'member' WHERE project_id = $1 AND user_id = $2`, [p, a.id]);
      await ds.query(`UPDATE project_members SET role = 'admin' WHERE project_id = $1 AND user_id = $2`, [p, o2.id]);
      await ds.query(`UPDATE project_invitations SET invited_by = NULL WHERE id = $1`, [orphan.id]);

      for (const [who, inv] of [[s1, byAdmin], [s2, byOwner], [s4, orphan]] as const) {
        const res = await accept(who, inv.token);
        expect({ who: who.email, status: res.status, message: res.json.message }).toEqual({ who: who.email, status: 400, message: GONE });
        expect(await memberRole(p, who.id)).toBeUndefined();
        expect((await invitationRow(inv.id)).accepted_at).toBeNull();
      }
      // An admin may still bring in a member.
      expect((await accept(s3, byOwnerMember.token)).json.data).toEqual({ projectId: p, role: 'member' });
    });

    it('revokes an invite at accept when its inviter is gone, and answers the generic 400 each time', async () => {
      const [x, a, sam] = [await person('x'), await person('a'), await person('sam')];
      const p = await project(x, [[a, 'admin']]);
      const inv = await invited(a, p, sam.email);
      // A direct delete, bypassing the service's revoke hook: the race accept must close.
      await ds.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [p, a.id]);

      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await accept(sam, inv.token);
        expect({ status: res.status, message: res.json.message }).toEqual({ status: 400, message: GONE });
      }
      const row = await invitationRow(inv.id);
      expect(row.revoked_at).not.toBeNull();
      expect(row.accepted_at).toBeNull();
      expect(await memberRole(p, sam.id)).toBeUndefined();
      const pending = (await call('GET', `/projects/${p}/invitations`, x.token)).json.data.map((i: { id: string }) => i.id);
      expect(pending).not.toContain(inv.id);
    });

    it('revokes the invites a person sent when they are removed, leave, or lose what the invite needs', async () => {
      const [x, a, l, o2] = [await person('x'), await person('a'), await person('l'), await person('o2')];
      const p = await project(x, [[a, 'admin'], [l, 'admin'], [o2, 'owner']]);
      const fromRemoved = await invited(a, p, newAddress('r'));
      const fromLeaver = await invited(l, p, newAddress('l'));
      const ownerInvite = await invited(o2, p, newAddress('oi'), 'owner');
      const memberInvite = await invited(o2, p, newAddress('mi'), 'member');
      const kept = await invited(x, p, newAddress('k'));

      expect((await call('DELETE', `/projects/${p}/members/${a.id}`, x.token)).status).toBe(200);
      expect((await call('POST', `/projects/${p}/leave`, l.token)).status).toBe(200);
      expect((await call('PATCH', `/projects/${p}/members/${o2.id}`, x.token, { role: 'admin' })).status).toBe(200);

      const revokedAt = async (id: string) => (await invitationRow(id)).revoked_at;
      expect(await revokedAt(fromRemoved.id)).not.toBeNull();
      expect(await revokedAt(fromLeaver.id)).not.toBeNull();
      expect(await revokedAt(ownerInvite.id)).not.toBeNull();
      expect(await revokedAt(memberInvite.id)).toBeNull();
      expect(await revokedAt(kept.id)).toBeNull();
      const pending = (await call('GET', `/projects/${p}/invitations`, x.token)).json.data.map((i: { id: string }) => i.id);
      expect(pending.sort()).toEqual([memberInvite.id, kept.id].sort());

      // Demoted to member: the rest of their invites go too.
      expect((await call('PATCH', `/projects/${p}/members/${o2.id}`, x.token, { role: 'member' })).status).toBe(200);
      expect(await revokedAt(memberInvite.id)).not.toBeNull();
    });

    it('answers 409 for someone who became a member meanwhile, and leaves the token unspent', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const { id, token } = await invited(x, p, sam.email, 'admin');
      await addOwnerMember(ds, p, sam.id, 'member');

      const res = await accept(sam, token);
      expect(res.status).toBe(409);
      expect(res.json.message).toBe(ALREADY_MEMBER);
      const row = await invitationRow(id);
      expect(row.accepted_at).toBeNull();
      expect(row.accepted_by).toBeNull();
      expect(await memberRole(p, sam.id)).toBe('member');
    });

    it('previews the invite for whoever holds the token, saying whether it matches their account', async () => {
      const x = await person('x');
      const p = await project(x, [], 'Preview project');
      const [sam, other] = [await person('sam'), await person('other')];
      const { token } = await invited(x, p, sam.email, 'admin');

      const mine = await call('POST', '/invitations/preview', sam.token, { token });
      expect(mine.status).toBe(200);
      expect(mine.json.data).toEqual({
        projectName: 'Preview project',
        role: 'admin',
        inviterName: 'Name x',
        invitedEmailMasked: `s***${DOMAIN}`,
        matchesAccount: true,
        emailVerificationRequired: false,
      });
      const theirs = await call('POST', '/invitations/preview', other.token, { token });
      expect(theirs.json.data.matchesAccount).toBe(false);
      expect(theirs.text).not.toContain(sam.email);
      // Previewing spends nothing.
      expect((await accept(sam, token)).status).toBe(201);
    });

    it('refuses staff viewing as the invitee', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const { token } = await invited(x, p, sam.email);
      const staff = await ds.getRepository(UserEntity).save({
        email: `staff-${++seq}${DOMAIN}`,
        name: 'Staff',
        passwordHash: 'x',
        isSuperAdmin: true,
      });
      const { sessionId } = await issueStaffSessionForTest(ds, { id: staff.id, email: staff.email, sessionVersion: 0 });
      const viewAs = await jwt.signAsync({ sub: sam.id, email: sam.email, type: 'access', imp: staff.id, impSv: 0, impSid: sessionId });

      for (const route of ['preview', 'accept']) {
        const res = await call('POST', `/invitations/${route}`, viewAs, { token });
        expect(res.status).toBe(403);
        expect(res.json.message).toBe(IMPERSONATION_READ_ONLY);
      }
      expect(await memberRole(p, sam.id)).toBeUndefined();
    });
  });

  describe('resending and revoking', () => {
    it('resends with a new token and a new 7-day expiry; the old token stops working', async () => {
      const x = await person('x');
      const p = await project(x);
      const sam = await person('sam');
      const first = await invited(x, p, sam.email);
      await ds.query(`UPDATE project_invitations SET expires_at = now() + interval '1 hour' WHERE id = $1`, [first.id]);

      platformEmailOn();
      const res = await call('POST', `/projects/${p}/invitations/${first.id}/resend`, x.token);
      expect(res.status).toBe(201);
      expect(res.json.data.emailSent).toBe(true);
      expect(res.json.data.invitation.id).toBe(first.id);
      const token = tokenOf(res.json.data.inviteUrl);
      expect(token).not.toBe(first.token);
      expect(emails.map((e) => e.to)).toEqual([sam.email]);
      const days = (new Date(res.json.data.invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);

      platformEmailOff();
      expect((await accept(sam, first.token)).json.message).toBe(GONE);
      expect((await accept(sam, token)).status).toBe(201);
      // Accepted: nothing left to resend.
      const again = await call('POST', `/projects/${p}/invitations/${first.id}/resend`, x.token);
      expect(again.status).toBe(404);
    });

    it('keeps admins off owner invites, and keeps one project\'s invites out of another\'s routes', async () => {
      const [x, a] = [await person('x'), await person('a')];
      const p = await project(x, [[a, 'admin']]);
      const ownerInvite = await invited(x, p, newAddress('o'), 'owner');

      for (const [method, path] of [
        ['POST', `/projects/${p}/invitations/${ownerInvite.id}/resend`],
        ['DELETE', `/projects/${p}/invitations/${ownerInvite.id}`],
      ]) {
        const res = await call(method, path, a.token);
        expect(res.status).toBe(403);
        expect(res.json.message).toBe(ROLE_REFUSAL);
      }
      expect((await invitationRow(ownerInvite.id)).revoked_at).toBeNull();

      // Another account's project, naming this invite: not found there.
      const y = await person('y');
      const q = await project(y);
      expect((await call('POST', `/projects/${q}/invitations/${ownerInvite.id}/resend`, y.token)).status).toBe(404);
      expect((await call('DELETE', `/projects/${q}/invitations/${ownerInvite.id}`, y.token)).status).toBe(404);
      expect((await invitationRow(ownerInvite.id)).revoked_at).toBeNull();

      const revoked = await call('DELETE', `/projects/${p}/invitations/${ownerInvite.id}`, x.token);
      expect(revoked.status).toBe(200);
      expect(revoked.json.data).toEqual([]);
      expect((await invitationRow(ownerInvite.id)).revoked_at).not.toBeNull();
      expect((await accept(await person('o'), ownerInvite.token)).json.message).toBe(GONE);
    });
  });

  describe('daily email allowance', () => {
    const sends = async (ownerId: string) => {
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM invitation_email_sends WHERE billing_owner_id = $1`, [ownerId]);
      return n as number;
    };
    /** Earlier sends of this account, as `planEmail` writes them, `hoursAgo` old. */
    const priorSends = (ownerId: string, projectId: string, count: number, hoursAgo = 1) =>
      ds.query(
        `INSERT INTO invitation_email_sends (billing_owner_id, project_id, created_at)
         SELECT $1, $2, now() - make_interval(hours => $4) FROM generate_series(1, $3)`,
        [ownerId, projectId, count, hoursAgo],
      );

    it('stops emailing at 50 a day per billing account, across its projects, and still returns the link', async () => {
      platformEmailOn();
      const x = await person('x');
      const [p1, p2] = [await project(x), await project(x)];
      await priorSends(x.id, p1, 49);
      // Older than a day: not counted. Older than a week: deleted on the next send.
      await priorSends(x.id, p1, 5, 30);
      await priorSends(x.id, p1, 3, 24 * 8);

      const fiftieth = await invite(x, p2, newAddress('fiftieth'));
      expect(fiftieth.json.data).toMatchObject({ emailSent: true });
      expect(fiftieth.json.data.emailSkipped).toBeUndefined();
      expect(emails).toHaveLength(1);
      expect(await sends(x.id)).toBe(49 + 5 + 1);

      const over = await invite(x, p1, newAddress('over'));
      expect(over.status).toBe(201);
      expect(over.json.data).toMatchObject({ emailSent: false, emailSkipped: 'daily_limit' });
      expect(over.json.data.inviteUrl).toMatch(/#token=/);
      const resent = await call('POST', `/projects/${p2}/invitations/${fiftieth.json.data.invitation.id}/resend`, x.token);
      expect(resent.status).toBe(201);
      tokenOf(resent.json.data.inviteUrl);
      expect(resent.json.data).toMatchObject({ emailSent: false, emailSkipped: 'daily_limit' });
      expect(emails).toHaveLength(1);
      expect(await sends(x.id)).toBe(55);

      // Another account is not affected.
      const y = await person('y');
      expect((await invite(y, await project(y), newAddress('y'))).json.data.emailSent).toBe(true);
    });

    it('counts nothing when platform email is not set up', async () => {
      const x = await person('x');
      const p = await project(x);
      expect((await invite(x, p, newAddress('n'))).json.data).toMatchObject({ emailSent: false });
      expect(await sends(x.id)).toBe(0);
    });
  });

  // The billing owner is suspended; a co-owner, not suspended, still signs in and acts.
  describe('suspended billing owner', () => {
    const sends = async (ownerId: string) => {
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM invitation_email_sends WHERE billing_owner_id = $1`, [ownerId]);
      return n as number;
    };
    const suspend = (userId: string) => ds.query(`UPDATE users SET suspended_at = now() WHERE id = $1`, [userId]);
    const reactivate = (userId: string) => ds.query(`UPDATE users SET suspended_at = NULL WHERE id = $1`, [userId]);

    it('refuses a new invite with 403, sends no email and counts none', async () => {
      platformEmailOn();
      const [x, o] = [await person('x'), await person('o')];
      const p = await project(x, [[o, 'owner']]);
      await suspend(x.id);

      const address = newAddress('s');
      const res = await invite(o, p, address);
      expect(res.status).toBe(403);
      expect(res.json.message).toBe(SUSPENDED);
      expect(emails).toEqual([]);
      expect(await sends(x.id)).toBe(0);
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM project_invitations WHERE project_id = $1`, [p]);
      expect(n).toBe(0);

      await reactivate(x.id);
      expect((await invite(o, p, address)).status).toBe(201);
    });

    it('refuses a resend with 403, keeps the old token, sends no email and counts none', async () => {
      const [x, o] = [await person('x'), await person('o')];
      const p = await project(x, [[o, 'owner']]);
      const sam = await person('sam');
      const first = await invited(o, p, sam.email);
      const before = await invitationRow(first.id);
      await suspend(x.id);

      platformEmailOn();
      const res = await call('POST', `/projects/${p}/invitations/${first.id}/resend`, o.token);
      expect(res.status).toBe(403);
      expect(res.json.message).toBe(SUSPENDED);
      expect(emails).toEqual([]);
      expect(await sends(x.id)).toBe(0);
      const after = await invitationRow(first.id);
      expect(after.token_hash).toBe(before.token_hash);
      expect(after.expires_at).toEqual(before.expires_at);
    });

    it('answers accept with the generic 400 and leaves the token unspent until reactivation', async () => {
      const [x, o] = [await person('x'), await person('o')];
      const p = await project(x, [[o, 'owner']]);
      const sam = await person('sam');
      const { id, token } = await invited(o, p, sam.email);
      await suspend(x.id);

      const res = await accept(sam, token);
      expect(res.status).toBe(400);
      expect(res.json.message).toBe(GONE);
      expect(await memberRole(p, sam.id)).toBeUndefined();
      const row = await invitationRow(id);
      expect(row.accepted_at).toBeNull();
      expect(row.revoked_at).toBeNull();

      await reactivate(x.id);
      expect((await accept(sam, token)).status).toBe(201);
      expect(await memberRole(p, sam.id)).toBe('member');
    });
  });

  describe('seat limit', () => {
    it('counts a pending invite as a seat, and the same address on a second project as the same seat', async () => {
      const x = await person('x');
      await setSeatLimit(x.id, 2);
      const [p1, p2] = [await project(x), await project(x)];
      const pending = newAddress('pending');

      expect((await invite(x, p1, pending)).status).toBe(201);
      const over = await invite(x, p1, newAddress('second'));
      expect(over.status).toBe(403);
      expect(over.json.message).toBe(SEAT_LIMIT_MESSAGE);
      expect((await invite(x, p2, pending)).status).toBe(201);
    });

    it('lets only one of two invites racing for the last seat through, on two projects of one account', async () => {
      for (let round = 0; round < 4; round++) {
        const x = await person('x');
        await setSeatLimit(x.id, 2);
        const [p1, p2] = [await project(x), await project(x)];

        const results = await Promise.all([invite(x, p1, newAddress('r1')), invite(x, p2, newAddress('r2'))]);
        const statuses = results.map((r) => r.status).sort();
        expect({ round, statuses }).toEqual({ round, statuses: [201, 403] });
        const [{ n }] = await ds.query(
          `SELECT count(*)::int AS n FROM project_invitations WHERE project_id IN ($1, $2)`,
          [p1, p2],
        );
        expect(n).toBe(1);
      }
    }, 60000);

    it('refuses accepting once the limit was lowered below the people already counted', async () => {
      const x = await person('x');
      await setSeatLimit(x.id, 3);
      const p = await project(x);
      const [s1, s2] = [await person('s1'), await person('s2')];
      const first = await invited(x, p, s1.email);
      await invited(x, p, s2.email);

      await setSeatLimit(x.id, 2);
      const refused = await accept(s1, first.token);
      expect(refused.status).toBe(403);
      expect(refused.json.message).toBe(SEAT_LIMIT_MESSAGE);
      expect((await invitationRow(first.id)).accepted_at).toBeNull();

      await setSeatLimit(x.id, 3);
      expect((await accept(s1, first.token)).status).toBe(201);
    });

    it('has no limit when neither the setting nor the override is set', async () => {
      const x = await person('x');
      await setSeatLimit(x.id, null);
      const p = await project(x);
      for (let i = 0; i < 8; i++) expect((await invite(x, p, newAddress(`many${i}`))).status).toBe(201);
    });
  });

  // Last: every raw token and URL the suite saw is now in `secretsSeen`.
  it('never wrote an invite URL or token to the log', () => {
    expect(secretsSeen.length).toBeGreaterThan(20);
    // The capture works: platform email being off is logged on every unsent invite.
    expect(logged.some((line) => line.includes('Account email not sent'))).toBe(true);
    const leaks = secretsSeen.filter((secret) => logged.some((line) => line.includes(secret)));
    expect(leaks).toEqual([]);
  });
});
