import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { ProjectActivityAction, ProjectActivityEntry, ProjectActivityPage } from '@chumbaq/shared';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { issueStaffSessionForTest } from '../../test-support/staff-session';
import { PROJECT_NOT_FOUND, ROLE_REFUSAL } from '../project-access/project-permissions';
import { IMPERSONATION_READ_ONLY } from '../project-access/view-as';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';
import { ACTIVITY_ACTION_GROUPS, PRIVACY_ACTIONS } from './activity-groups';
import {
  ACTIVITY_EXPORT_CAP,
  ACTIVITY_EXPORT_ROW_CAP,
  INVALID_ACTIVITY_FILTER,
  TOO_MANY_TO_EXPORT,
} from './project-activity-query.service';

/**
 * The Activity page's reads over HTTP against the real app and database: paging by
 * keyset, the filters, the refusals, the privacy group hidden from roles without
 * `privacy`, and the CSV export.
 *
 * `project_activity` is append-only and the int database is shared, so rows from other
 * runs stay: every assertion is scoped to the fresh projects made here. Rows are put in
 * with a plain INSERT and an explicit `occurred_at` (the trigger guards only UPDATE and
 * DELETE).
 */

const SECRET = process.env.JWT_SECRET as string;
const DOMAIN = '@activity-read-int.test';
const HOSTILE = '=HYPERLINK("https://evil.example","click")';

interface Seeded {
  id: string;
  /** Postgres text form, microseconds, UTC: sorts like the column. */
  at: string;
  action: ProjectActivityAction;
  actorUserId: string | null;
  actorLabel: string;
}

/** Newest first, as the page orders: occurred_at DESC, id DESC. */
const newestFirst = (rows: Seeded[]) =>
  [...rows].sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1));

describe('Project activity reads (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let restoreEnv: () => void = () => undefined;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });

  interface Person {
    id: string;
    email: string;
    token: string;
  }
  const people = {} as Record<'owner' | 'admin' | 'member' | 'outsider' | 'former', Person>;
  let projectA: string;
  let projectB: string;
  let rowsA: Seeded[] = [];
  let rowsB: Seeded[] = [];
  /** Someone whose only entries are privacy ones; not a user. */
  const privacyOnlyActor = randomUUID();

  const cleanup = async () => {
    if (!ds?.isInitialized) return;
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  const person = async (label: string): Promise<Person> => {
    const email = `${label}-${randomUUID().slice(0, 8)}${DOMAIN}`;
    const id = (await ds.getRepository(UserEntity).save({ email, name: label, passwordHash: 'x' })).id;
    const token = await jwt.signAsync({ sub: id, email, type: 'access', auth_time: Math.floor(Date.now() / 1000) });
    return { id, email, token };
  };

  const insert = async (
    projectId: string,
    row: Omit<Seeded, 'id'> & { targetLabel?: string | null; actorKind?: string },
  ): Promise<Seeded> => {
    const [{ id }] = await ds.query(
      `INSERT INTO project_activity
         (project_id, occurred_at, actor_kind, actor_user_id, actor_label, action, target_type, target_id, target_label,
          details, ip_address, user_agent, country)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, 'thing', 't-1', $7, '{"n":1}', '203.0.113.9', 'agent/1', 'IN')
       RETURNING id`,
      [
        projectId,
        row.at,
        row.actorKind ?? (row.actorUserId ? 'user' : 'staff'),
        row.actorUserId,
        row.actorLabel,
        row.action,
        row.targetLabel ?? 'label',
      ],
    );
    return { id, at: row.at, action: row.action, actorUserId: row.actorUserId, actorLabel: row.actorLabel };
  };

  const get = async (path: string, token: string) => {
    const res = await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    let json: { data?: unknown; message?: unknown } | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  };

  const page = async (projectId: string, token: string, query: Record<string, string> = {}) => {
    const qs = new URLSearchParams(query).toString();
    const res = await get(`/projects/${projectId}/activity${qs ? `?${qs}` : ''}`, token);
    expect({ status: res.status, text: res.status === 200 ? '' : res.text }).toEqual({ status: 200, text: '' });
    return res.json!.data as ProjectActivityPage;
  };

  /** Every entry, following nextCursor; fails on a repeat. */
  const all = async (projectId: string, token: string, query: Record<string, string> = {}) => {
    const entries: ProjectActivityEntry[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const p: ProjectActivityPage = await page(projectId, token, cursor ? { ...query, cursor } : query);
      expect(p.entries.length).toBeLessThanOrEqual(50);
      entries.push(...p.entries);
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    return entries;
  };

  const csvLines = (text: string) =>
    text
      .replace(/^﻿/, '')
      .split('\r\n')
      .filter((l) => l !== '');

  const exportedRows = async (projectId: string) =>
    ds.query(
      `SELECT id, actor_user_id, details FROM project_activity WHERE project_id = $1 AND action = 'activity.exported'`,
      [projectId],
    );

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    ({ app, base, restoreEnv } = await bootDashboardApp());
    for (const key of ['owner', 'admin', 'member', 'outsider', 'former'] as const) people[key] = await person(key);

    const projects = ds.getRepository(ProjectEntity);
    projectA = (await projects.save({ name: 'activity A', ownerId: people.owner.id })).id;
    projectB = (await projects.save({ name: 'activity B', ownerId: people.owner.id })).id;
    await addOwnerMember(ds, projectA, people.owner.id);
    await addOwnerMember(ds, projectA, people.admin.id, 'admin');
    await addOwnerMember(ds, projectA, people.member.id, 'member');
    await addOwnerMember(ds, projectA, people.former.id, 'admin');
    await addOwnerMember(ds, projectB, people.owner.id);
    // The outsider has a project of their own, so "not a member" is not "no projects".
    const own = (await projects.save({ name: 'outsider', ownerId: people.outsider.id })).id;
    await addOwnerMember(ds, own, people.outsider.id);

    // 120 rows over 12 days. Within a day: four at the same instant (the id breaks the
    // tie), four in the same millisecond a microsecond apart (a cursor kept to the
    // millisecond would skip them), one at the day's last instant and one at its first.
    const actions: ProjectActivityAction[] = [
      'member.invited',
      'project.renamed',
      'api_key.created',
      'webhook.created',
      'campaign.sent',
      'person.erased',
      'suppression.added',
      'activity.exported',
      'staff.viewed_as',
    ];
    const times = [
      '12:00:00.500000',
      '12:00:00.500000',
      '12:00:00.500000',
      '12:00:00.500000',
      '12:00:00.700100',
      '12:00:00.700200',
      '12:00:00.700300',
      '12:00:00.700400',
      '23:59:59.999500',
      '00:00:00.000000',
    ];
    for (let i = 0; i < 120; i++) {
      const day = String(1 + Math.floor(i / 10)).padStart(2, '0');
      const action = actions[i % actions.length];
      let actorUserId: string | null;
      let actorLabel: string;
      if (action === 'staff.viewed_as') [actorUserId, actorLabel] = [null, 'Chumbaq support'];
      else if (i % 3 === 0) [actorUserId, actorLabel] = [people.owner.id, 'Owner (owner@x)'];
      else if (i % 3 === 1) [actorUserId, actorLabel] = [people.admin.id, i < 60 ? 'Admin OLD' : 'Admin NEW'];
      else [actorUserId, actorLabel] = [people.former.id, 'Former (former@x)'];
      rowsA.push(
        await insert(projectA, {
          at: `2026-03-${day}T${times[i % 10]}Z`,
          action,
          actorUserId,
          actorLabel,
          targetLabel: i === 4 ? HOSTILE : `label ${i}`,
        }),
      );
    }
    rowsA.push(
      await insert(projectA, {
        at: '2026-03-05T08:00:00.000000Z',
        action: 'person.exported',
        actorUserId: privacyOnlyActor,
        actorLabel: 'Privacy only',
      }),
    );
    for (let i = 0; i < 5; i++) {
      rowsB.push(
        await insert(projectB, {
          at: `2026-02-0${i + 1}T09:00:00.000000Z`,
          action: 'project.renamed',
          actorUserId: people.owner.id,
          actorLabel: 'Owner (owner@x)',
        }),
      );
    }
    // The former admin leaves; their entries stay.
    await ds.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectA, people.former.id]);
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await closeIntDb(ds);
    restoreEnv();
  });

  it('gives the owner 50 a page, newest first, and the cursor reaches every entry once', async () => {
    const first = await page(projectA, people.owner.token);
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));

    const entries = await all(projectA, people.owner.token);
    expect(entries.map((e) => e.id)).toEqual(newestFirst(rowsA).map((r) => r.id));
    expect(entries).toHaveLength(121);
    expect(first.entries.map((e) => e.id)).toEqual(entries.slice(0, 50).map((e) => e.id));

    const sample = entries.find((e) => e.id === rowsA[4].id)!;
    expect(sample).toEqual({
      id: rowsA[4].id,
      occurredAt: '2026-03-01T12:00:00.700Z',
      actorKind: 'user',
      actorUserId: people.admin.id,
      actorLabel: 'Admin OLD',
      action: 'campaign.sent',
      group: 'messaging',
      targetType: 'thing',
      targetId: 't-1',
      targetLabel: HOSTILE,
      details: { n: 1 },
      ipAddress: '203.0.113.9',
      country: 'IN',
      userAgent: 'agent/1',
    });
    for (const e of entries) expect(e.group).toBe(ACTIVITY_ACTION_GROUPS[e.action]);
  });

  it('keeps rows a microsecond apart, and rows at the same instant, across page boundaries', async () => {
    // 60 rows in one millisecond, 1 µs apart, then 60 at a single instant: every page
    // boundary falls inside one or the other.
    const projectC = (await ds.getRepository(ProjectEntity).save({ name: 'activity C', ownerId: people.owner.id })).id;
    await addOwnerMember(ds, projectC, people.owner.id);
    const rows: Seeded[] = [];
    for (let i = 0; i < 120; i++) {
      const micro = i < 60 ? String(100 + i).padStart(3, '0') : '999';
      rows.push(
        await insert(projectC, {
          at: `2026-04-01T10:00:00.123${micro}Z`,
          action: 'project.renamed',
          actorUserId: people.owner.id,
          actorLabel: 'Owner (owner@x)',
        }),
      );
    }
    const entries = await all(projectC, people.owner.token);
    expect(entries.map((e) => e.id)).toEqual(newestFirst(rows).map((r) => r.id));
  });

  it('lists everyone in the log as a choice, former members too, by their newest label', async () => {
    const { actors } = await page(projectA, people.owner.token);
    expect(actors).toEqual(
      expect.arrayContaining([
        { userId: people.owner.id, label: 'Owner (owner@x)' },
        { userId: people.admin.id, label: 'Admin NEW' },
        { userId: people.former.id, label: 'Former (former@x)' },
        { userId: privacyOnlyActor, label: 'Privacy only' },
      ]),
    );
    // People only: staff, API keys and the system are not choices.
    expect(actors.filter((a) => a.userId === null)).toEqual([]);
    expect(actors).toHaveLength(4);
  });

  it('filters by actor, by group and by day, with `to` taking in its whole day', async () => {
    const byAdmin = await all(projectA, people.owner.token, { actor: people.admin.id });
    expect(byAdmin.map((e) => e.id)).toEqual(
      newestFirst(rowsA.filter((r) => r.actorUserId === people.admin.id)).map((r) => r.id),
    );

    const team = await all(projectA, people.owner.token, { group: 'team' });
    expect(team.map((e) => e.id)).toEqual(newestFirst(rowsA.filter((r) => r.action === 'member.invited')).map((r) => r.id));

    // 2026-03-03: rows 20..29, including 23:59:59.9995 and 00:00:00.
    const day = await all(projectA, people.owner.token, { from: '2026-03-03', to: '2026-03-03' });
    expect(day.map((e) => e.id)).toEqual(newestFirst(rowsA.slice(20, 30)).map((r) => r.id));

    const span = await all(projectA, people.owner.token, { from: '2026-03-02', to: '2026-03-04', group: 'messaging' });
    expect(span.map((e) => e.id)).toEqual(
      newestFirst(rowsA.slice(10, 40).filter((r) => r.action === 'campaign.sent')).map((r) => r.id),
    );
  });

  it('answers 400 for every malformed filter, never a 500', async () => {
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const bad: Record<string, string>[] = [
      { from: '2026-03-05', to: '2026-03-04' },
      { from: 'yesterday' },
      { to: '2026-02-30' },
      { from: '2026-3-01' },
      { from: '2026-03-01T00:00:00Z' },
      { group: 'nope' },
      { group: 'Privacy' },
      { actor: 'not-a-uuid' },
      { actor: `${people.owner.id}x` },
      { cursor: 'garbage!' },
      { cursor: enc('x|y') },
      { cursor: enc(`2026-13-01T00:00:00.000000Z|${randomUUID()}`) },
      { cursor: enc(`2026-03-01T00:00:00.000000Z|not-a-uuid`) },
      { cursor: enc(`2026-03-01T00:00:00.000000Z`) },
      { cursor: enc(`0000-03-01T00:00:00.000000Z|${randomUUID()}`) },
      { cursor: enc(`1969-12-31T23:59:59.999999Z|${randomUUID()}`) },
      { unknown: '1' },
    ];
    for (const query of bad) {
      const qs = new URLSearchParams(query).toString();
      const res = await get(`/projects/${projectA}/activity?${qs}`, people.owner.token);
      expect({ query, status: res.status, message: res.json?.message }).toEqual({
        query,
        status: 400,
        message: INVALID_ACTIVITY_FILTER,
      });
    }
    // A repeated key arrives as a list.
    const twice = await get(`/projects/${projectA}/activity?group=team&group=project`, people.owner.token);
    expect([twice.status, twice.json?.message]).toEqual([400, INVALID_ACTIVITY_FILTER]);
    // The export takes the filters but not a cursor.
    const first = await page(projectA, people.owner.token);
    const exp = await get(`/projects/${projectA}/activity/export?cursor=${first.nextCursor}`, people.owner.token);
    expect([exp.status, exp.json?.message]).toEqual([400, INVALID_ACTIVITY_FILTER]);
  });

  it("returns only B's rows for a cursor taken from A", async () => {
    const first = await page(projectA, people.owner.token);
    const onB = await page(projectB, people.owner.token, { cursor: first.nextCursor! });
    expect(onB.entries.map((e) => e.id)).toEqual(newestFirst(rowsB).map((r) => r.id));
    expect(onB.nextCursor).toBeNull();
    // And B's own first page never shows A.
    const bOwn = await all(projectB, people.owner.token);
    expect(bOwn.map((e) => e.id)).toEqual(newestFirst(rowsB).map((r) => r.id));
  });

  it('never shows an admin a privacy entry, in the list, the choices or the privacy group; the owner sees them', async () => {
    const isPrivacy = (a: string) => (PRIVACY_ACTIONS as readonly string[]).includes(a);
    const adminAll = await all(projectA, people.admin.token);
    expect(adminAll.map((e) => e.id)).toEqual(newestFirst(rowsA.filter((r) => !isPrivacy(r.action))).map((r) => r.id));
    expect(adminAll.filter((e) => isPrivacy(e.action))).toEqual([]);

    const { actors } = await page(projectA, people.admin.token);
    expect(actors.map((a) => a.userId)).not.toContain(privacyOnlyActor);
    expect(actors.filter((a) => a.userId === null)).toEqual([]);
    expect(actors).toHaveLength(3);

    const adminPrivacy = await page(projectA, people.admin.token, { group: 'privacy' });
    expect(adminPrivacy).toEqual({ entries: [], nextCursor: null, actors: expect.any(Array) });
    const adminPrivacyActor = await page(projectA, people.admin.token, { actor: privacyOnlyActor });
    expect(adminPrivacyActor.entries).toEqual([]);

    const ownerPrivacy = await all(projectA, people.owner.token, { group: 'privacy' });
    expect(ownerPrivacy.map((e) => e.id)).toEqual(newestFirst(rowsA.filter((r) => isPrivacy(r.action))).map((r) => r.id));
    expect(ownerPrivacy.length).toBeGreaterThan(0);
  });

  it('refuses a member with 403, and a non-member and a removed member with 404', async () => {
    for (const path of [`/projects/${projectA}/activity`, `/projects/${projectA}/activity/export`]) {
      const member = await get(path, people.member.token);
      expect([member.status, member.json?.message]).toEqual([403, ROLE_REFUSAL]);
      for (const who of [people.outsider, people.former]) {
        const res = await get(path, who.token);
        expect([res.status, res.json?.message]).toEqual([404, PROJECT_NOT_FOUND]);
      }
    }
  });

  describe('export', () => {
    // Exports add `activity.exported` rows at now(), so these bound the range to March.
    const march = { from: '2026-03-01', to: '2026-03-31' };

    it("downloads the owner's filtered entries as CSV, inert labels and all, and logs one activity.exported", async () => {
      const before = await exportedRows(projectA);
      const qs = new URLSearchParams(march).toString();
      const res = await get(`/projects/${projectA}/activity/export?${qs}`, people.owner.token);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
      const today = new Date().toISOString().slice(0, 10);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="activity-${projectA}-${today}.csv"`);

      const lines = csvLines(res.text);
      expect(lines[0]).toBe(
        'occurred_at,actor,action,target_type,target_id,target_label,ip_address,country,user_agent,details,id',
      );
      expect(lines.slice(1).map((l) => l.split(',').pop())).toEqual(newestFirst(rowsA).map((r) => r.id));
      const hostile = lines.find((l) => l.endsWith(rowsA[4].id))!;
      expect(hostile).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
      expect(hostile.startsWith('2026-03-01T12:00:00.700Z,')).toBe(true);
      expect(res.text).not.toContain(rowsB[0].id);

      const after = await exportedRows(projectA);
      expect(after).toHaveLength(before.length + 1);
      const added = after.filter((r: { id: string }) => !before.some((b: { id: string }) => b.id === r.id));
      expect(added).toEqual([{ id: expect.any(String), actor_user_id: people.owner.id, details: { filters: march, rows: 121 } }]);
    });

    it('leaves privacy entries out of an admin CSV', async () => {
      const qs = new URLSearchParams(march).toString();
      const res = await get(`/projects/${projectA}/activity/export?${qs}`, people.admin.token);
      expect(res.status).toBe(200);
      const actions = csvLines(res.text)
        .slice(1)
        .map((l) => l.match(/,([a-z_]+\.[a-z_]+),/)![1]);
      expect(actions.length).toBe(rowsA.filter((r) => !(PRIVACY_ACTIONS as readonly string[]).includes(r.action)).length);
      for (const a of actions) expect(PRIVACY_ACTIONS).not.toContain(a);
      const adminGroup = await get(`/projects/${projectA}/activity/export?group=privacy`, people.admin.token);
      expect(csvLines(adminGroup.text)).toHaveLength(1);
    });

    it('lets view-as read the log but not download it', async () => {
      const staff = await ds.getRepository(UserEntity).save({
        email: `staff-${randomUUID().slice(0, 8)}${DOMAIN}`,
        name: 'staff',
        passwordHash: 'x',
        isSuperAdmin: true,
      });
      const { sessionId } = await issueStaffSessionForTest(ds, { id: staff.id, email: staff.email, sessionVersion: 0 });
      const viewAs = await jwt.signAsync({
        sub: people.owner.id,
        email: people.owner.email,
        type: 'access',
        imp: staff.id,
        impSv: 0,
        impSid: sessionId,
        auth_time: Math.floor(Date.now() / 1000),
      });
      const before = await exportedRows(projectA);
      expect((await get(`/projects/${projectA}/activity`, viewAs)).status).toBe(200);
      const res = await get(`/projects/${projectA}/activity/export`, viewAs);
      expect([res.status, res.json?.message]).toEqual([403, IMPERSONATION_READ_ONLY]);
      expect(await exportedRows(projectA)).toHaveLength(before.length);
    });

    it('is capped at 50,000 rows by default', () => {
      expect(ACTIVITY_EXPORT_ROW_CAP).toBe(50_000);
    });

    it('refuses an export past the cap and logs nothing', async () => {
      const capped = await bootDashboardApp({
        override: (builder) => builder.overrideProvider(ACTIVITY_EXPORT_CAP).useValue(3),
      });
      try {
        const before = await exportedRows(projectA);
        const over = await fetch(`${capped.base}/api/projects/${projectA}/activity/export?from=2026-03-03&to=2026-03-03`, {
          headers: { authorization: `Bearer ${people.owner.token}` },
        });
        expect([over.status, ((await over.json()) as { message?: unknown }).message]).toEqual([400, TOO_MANY_TO_EXPORT]);
        expect(await exportedRows(projectA)).toHaveLength(before.length);

        // Exactly the cap is allowed: B's rows of Feb 1 to 3.
        const within = await fetch(`${capped.base}/api/projects/${projectB}/activity/export?to=2026-02-03`, {
          headers: { authorization: `Bearer ${people.owner.token}` },
        });
        expect(within.status).toBe(200);
        expect(csvLines(await within.text())).toHaveLength(4);
      } finally {
        await capped.app.close();
        capped.restoreEnv();
      }
    }, 120000);
  });
});
