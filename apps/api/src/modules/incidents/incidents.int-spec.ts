import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { BootedApp, bootIntApp } from '../../test-support/int-apps';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import type { PlatformEmail, PlatformEmailService } from '../platform-email/platform-email.service';
import { IncidentRemindersScheduler } from './incident-reminders.scheduler';

const DOMAIN = '@incidents-int.test';
const HOUR = 3600_000;

/** The incident register: recording, the 6-hour deadline, reporting, notes, closing, reminders. */
describe('incidents (integration)', () => {
  let ds: DataSource;
  let admin: BootedApp;
  let token: string;
  let staffId: string;

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${admin.base}/api/admin${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-chumbaq-client': 'admin',
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: ((await res.json().catch(() => null)) as { data?: any } | null)?.data };
  };

  const record = (overrides: Record<string, unknown> = {}) =>
    call('POST', '/incidents', { types: ['iii'], title: `Incident ${randomUUID().slice(0, 6)}`, ...overrides });

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
    const [staff] = await ds.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin) VALUES ($1, 'x', 'Staff', true)
       RETURNING id, email, session_version`,
      [`staff${DOMAIN}`],
    );
    staffId = staff.id;
    token = (await issueStaffSessionForTest(ds, { id: staff.id, email: staff.email, sessionVersion: staff.session_version }))
      .accessToken;
    admin = await bootIntApp('admin');
  }, 120000);

  afterAll(async () => {
    await admin?.app.close();
    await closeIntDb(ds);
  });

  describe('recording', () => {
    it('records an incident with its deadline and the log command, and audits it', async () => {
      const noticedAt = new Date(Date.now() - HOUR).toISOString();
      const res = await record({ noticedAt, howNoticed: 'Trap key alarm', types: ['iii', 'xii'], systems: 'Customer API' });

      expect(res.status).toBe(201);
      expect(res.data).toEqual(
        expect.objectContaining({
          status: 'open',
          types: ['iii', 'xii'],
          noticedAt,
          deadline: new Date(Date.parse(noticedAt) + 6 * HOUR).toISOString(),
          howNoticed: 'Trap key alarm',
          systems: 'Customer API',
          recordedBy: staffId,
          notes: [],
          logCommand: expect.stringMatching(/^sudo \/usr\/local\/sbin\/chumbaq-collect-logs --from \S+ --to \S+$/),
        }),
      );
      const [audit] = await ds.query(
        `SELECT action FROM admin_audit_logs WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [res.data.id],
      );
      expect(audit).toEqual({ action: 'incident.recorded' });
      expect((await call('GET', '/incidents')).data.map((i: { id: string }) => i.id)).toContain(res.data.id);
    });

    it('defaults noticed-at to now', async () => {
      const before = Date.now();
      const res = await record();
      expect(Date.parse(res.data.noticedAt)).toBeGreaterThanOrEqual(before - 1000);
    });

    it('refuses a future time, no type, an unknown type, and no title', async () => {
      expect((await record({ noticedAt: new Date(Date.now() + 5 * 60_000).toISOString() })).status).toBe(400);
      expect((await record({ types: [] })).status).toBe(400);
      expect((await record({ types: ['xxi'] })).status).toBe(400);
      expect((await record({ title: '' })).status).toBe(400);
    });

    it('says when its first email to staff could not be sent', async () => {
      // Integration runs have no platform email configured.
      const res = await record();
      expect((await call('GET', `/incidents/${res.data.id}`)).data.reminderEmailFailed).toBe(true);
    });

    it('is staff only', async () => {
      expect((await call('GET', '/incidents', undefined, false)).status).toBe(401);
    });
  });

  describe('after recording', () => {
    it('marks it reported once, adds notes, then closes it', async () => {
      const { data: created } = await record();
      const reported = await call('POST', `/incidents/${created.id}/report`, { method: 'email', certinReference: 'CERTIn-123' });
      expect(reported.status).toBe(201);
      expect(reported.data).toEqual(
        expect.objectContaining({ status: 'reported', reportMethod: 'email', certinReference: 'CERTIn-123', reportedBy: staffId }),
      );
      expect((await call('POST', `/incidents/${created.id}/report`, { method: 'phone' })).status).toBe(409);

      const noted = await call('POST', `/incidents/${created.id}/notes`, { note: 'Rotated every key' });
      expect(noted.data.notes).toEqual([expect.objectContaining({ note: 'Rotated every key', createdBy: staffId })]);

      const closed = await call('POST', `/incidents/${created.id}/close`, { note: 'Contained' });
      expect(closed.data.status).toBe('closed');
      expect(closed.data.notes.map((n: { note: string }) => n.note)).toEqual(['Rotated every key', 'Contained']);
      expect((await call('POST', `/incidents/${created.id}/close`, { note: 'again' })).status).toBe(409);
    });

    it('can be closed without being reported (not reportable after all)', async () => {
      const { data } = await record();
      expect((await call('POST', `/incidents/${data.id}/close`, { note: 'False alarm' })).data.status).toBe('closed');
      expect((await call('POST', `/incidents/${data.id}/report`, { method: 'email' })).status).toBe(409);
    });

    it('drafts the CERT-In report from the incident and the saved contact', async () => {
      const put = await call('PUT', '/security-contact', {
        orgName: 'Qleverlabs',
        orgAddress: 'Bengaluru',
        sector: 'IT services',
        pocName: 'Founder',
        pocRole: 'Director',
        pocEmail: 'security@chumbaq.com',
        pocPhone: '+91 00000 00000',
      });
      expect(put.status).toBe(200);
      expect((await call('GET', '/security-contact')).data).toEqual(expect.objectContaining({ orgName: 'Qleverlabs' }));

      const { data } = await record({ title: 'Key leak', types: ['xii'] });
      const draft = await call('GET', `/incidents/${data.id}/report-draft`);
      expect(draft.data.subject).toBe('Cyber security incident report: Key leak');
      expect(draft.data.body).toContain('Organisation: Qleverlabs');
      expect(draft.data.body).toContain('(xii) Data Leak');
    });

    it('a missing incident is 404', async () => {
      expect((await call('GET', `/incidents/${randomUUID()}`)).status).toBe(404);
    });
  });

  describe('the tables keep their history', () => {
    it('refuses deleting an incident, rewriting its facts, or editing a note', async () => {
      const { data } = await record();
      await call('POST', `/incidents/${data.id}/notes`, { note: 'first' });
      await expect(ds.query(`DELETE FROM security_incidents WHERE id = $1`, [data.id])).rejects.toThrow(/append-only/);
      await expect(ds.query(`UPDATE security_incidents SET title = 'x' WHERE id = $1`, [data.id])).rejects.toThrow(/append-only/);
      await expect(ds.query(`UPDATE security_incidents SET status = 'open' WHERE id = $1 AND status = 'open'`, [data.id])).resolves.toBeDefined();
      await expect(
        ds.query(`UPDATE security_incident_notes SET note = 'x' WHERE incident_id = $1`, [data.id]),
      ).rejects.toThrow(/append-only/);
      await expect(ds.query(`TRUNCATE security_incidents CASCADE`)).rejects.toThrow(/append-only/);
    });

    it('refuses moving a closed incident back', async () => {
      const { data } = await record();
      await call('POST', `/incidents/${data.id}/close`, { note: 'done' });
      await expect(ds.query(`UPDATE security_incidents SET status = 'open' WHERE id = $1`, [data.id])).rejects.toThrow(/append-only/);
    });
  });

  describe('reminders', () => {
    let sent: PlatformEmail[];
    let ok = true;
    const email = {
      send: jest.fn(async (m: PlatformEmail) => {
        sent.push(m);
        return ok ? { sent: true as const } : { sent: false as const, reason: 'unreachable' as const };
      }),
    } as unknown as PlatformEmailService;
    const scheduler = () => new IncidentRemindersScheduler(ds, email, new ConfigService({ ADMIN_APP_URL: 'https://admin.example.com' }));

    beforeEach(() => {
      sent = [];
      ok = true;
    });

    const insertIncident = async (hoursAgo: number, recordedHoursAgo = hoursAgo) => {
      const [row] = await ds.query(
        `INSERT INTO security_incidents (noticed_at, recorded_at, recorded_by, types, title)
         VALUES (now() - make_interval(secs => $1), now() - make_interval(secs => $2), $3, '{iii}', $4) RETURNING id`,
        [hoursAgo * 3600, recordedHoursAgo * 3600, staffId, `Reminder ${randomUUID().slice(0, 6)}`],
      );
      return row.id as string;
    };
    const stamps = async (id: string) =>
      (await ds.query(`SELECT reminder_4h_at, reminder_5h_at, reminder_email_failed FROM security_incidents WHERE id = $1`, [id]))[0];

    it('emails staff at 4 hours, once', async () => {
      const id = await insertIncident(4.2);
      await scheduler().sendDue();
      const mine = sent.filter((m) => m.text.includes(id));
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine[0].subject).toMatch(/2 hours left to report/);
      expect(await stamps(id)).toEqual(expect.objectContaining({ reminder_4h_at: expect.any(Date), reminder_5h_at: null }));

      sent = [];
      await scheduler().sendDue();
      expect(sent.filter((m) => m.text.includes(id))).toEqual([]);
    });

    it('sends nothing for a reported incident', async () => {
      const id = await insertIncident(4.5);
      await ds.query(
        `UPDATE security_incidents SET status = 'reported', reported_at = now(), reported_by = $2, report_method = 'email' WHERE id = $1`,
        [id, staffId],
      );
      await scheduler().sendDue();
      expect(sent.filter((m) => m.text.includes(id))).toEqual([]);
    });

    it('marks a reminder whose email failed', async () => {
      ok = false;
      const id = await insertIncident(5.2, 4.9);
      await scheduler().sendDue();
      expect(await stamps(id)).toEqual(
        expect.objectContaining({ reminder_5h_at: expect.any(Date), reminder_email_failed: true }),
      );
    });
  });

  it('lists recent alarms for the page', async () => {
    const res = await call('GET', '/security-alerts?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});
