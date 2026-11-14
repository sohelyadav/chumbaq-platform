import { randomUUID } from 'crypto';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { ProjectOwner, countWindow, readDay, writeApiKeySnapshot } from './usage-counting';
import { addDays, dayStart } from './usage-days';

/**
 * Every counted metric against rows written the way production writes them,
 * in two projects with two billing owners. Each test runs in a transaction
 * that is rolled back, with the session in India's time zone: plain
 * `timestamp` columns hold session-local wall clock, so a row written at
 * 01:30 on the 14th in India belongs to the 13th in UTC.
 */
describe('usage counting (integration)', () => {
  let ds: DataSource;
  let qr: QueryRunner;
  let m: EntityManager;

  const DAY = '2026-11-13';
  const window = (day: string) => [dayStart(day), dayStart(addDays(day, 1))] as const;

  let A: string;
  let B: string;
  let P1: string;
  let P2: string;
  let projects: ProjectOwner[];

  beforeAll(async () => {
    ds = await openIntDb();
  });

  afterAll(async () => {
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('REPEATABLE READ');
    await qr.query(`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
    m = qr.manager;
    A = randomUUID();
    B = randomUUID();
    P1 = randomUUID();
    P2 = randomUUID();
    for (const [user, tag] of [[A, 'a'], [B, 'b']]) {
      await m.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', $3)`, [
        user,
        `usage-${tag}-${user}@test.local`,
        tag,
      ]);
    }
    await m.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'p1', $2), ($3, 'p2', $4)`, [P1, A, P2, B]);
    projects = [
      { id: P1, ownerId: A },
      { id: P2, ownerId: B },
    ];
  });

  afterEach(async () => {
    await qr.rollbackTransaction();
    await qr.release();
  });

  /** A finished campaign row, as PushCampaignStateService.finalize leaves it. */
  const campaign = async (
    project: string,
    spec: {
      channel?: string;
      status: string;
      success: number;
      failure: number;
      completedAt: string | null;
      parent?: string;
      variantKey?: string;
      variants?: unknown;
      timezone?: boolean;
    },
  ): Promise<string> => {
    const [row] = await m.query(
      `INSERT INTO push_notification_logs
         (project_id, title, channel, status, success_count, failure_count, completed_at,
          parent_campaign_id, variant_key, variants, deliver_in_recipient_timezone)
       VALUES ($1, 't', $2, $3, $4, $5, $6::timestamptz::timestamp, $7, $8, $9, $10)
       RETURNING id`,
      [
        project,
        spec.channel ?? 'push',
        spec.status,
        spec.success,
        spec.failure,
        spec.completedAt,
        spec.parent ?? null,
        spec.variantKey ?? null,
        spec.variants ? JSON.stringify(spec.variants) : null,
        spec.timezone ?? false,
      ],
    );
    return row.id;
  };

  /**
   * A device row. `last_seen_at` is an update-date column that moves on every
   * save of the row (each identify, any dashboard edit), so a real device first
   * seen days ago usually carries a `last_seen_at` of today.
   */
  const device = async (project: string, firstSeenAt: string, lastSeenAt = firstSeenAt): Promise<string> => {
    const [row] = await m.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, platform, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'ios', $3::timestamptz::timestamp, $4::timestamptz::timestamp) RETURNING id`,
      [project, `fp-${randomUUID()}`, firstSeenAt, lastSeenAt],
    );
    return row.id;
  };

  /** An SDK event: `timestamp` is the client's, `created_at` when it was received. */
  const event = (project: string, receivedAt: string, clientTime = receivedAt, deviceId: string | null = null) =>
    m.query(
      `INSERT INTO user_events (project_id, device_identity_id, event_name, timestamp, created_at)
       VALUES ($1, $2, 'opened', $3::timestamptz::timestamp, $4::timestamptz::timestamp)`,
      [project, deviceId, clientTime, receivedAt],
    );

  const seedP1 = async () => {
    const at = (time: string) => `${DAY}T${time}Z`;
    await campaign(P1, { status: 'sent', success: 5, failure: 0, completedAt: at('01:00:00') });
    await campaign(P1, { status: 'partial', success: 7, failure: 2, completedAt: at('02:00:00') });
    await campaign(P1, { channel: 'email', status: 'sent', success: 3, failure: 0, completedAt: at('03:00:00') });
    await campaign(P1, { channel: 'sms', status: 'failed', success: 0, failure: 4, completedAt: at('04:00:00') });
    await campaign(P1, { channel: 'whatsapp', status: 'sent', success: 2, failure: 0, completedAt: at('05:00:00') });
    // An A/B parent ends expanded and sends nothing; its arms carry the counts.
    const ab = await campaign(P1, {
      status: 'expanded',
      success: 0,
      failure: 0,
      completedAt: at('06:00:00'),
      variants: [{ key: 'a' }, { key: 'b' }],
    });
    await campaign(P1, { status: 'sent', success: 10, failure: 0, completedAt: at('07:00:00'), parent: ab, variantKey: 'a' });
    await campaign(P1, { status: 'partial', success: 11, failure: 1, completedAt: at('07:30:00'), parent: ab, variantKey: 'b' });
    // A timezone parent ends expanded too; each wave is its own row.
    const tz = await campaign(P1, { status: 'expanded', success: 0, failure: 0, completedAt: at('08:00:00'), timezone: true });
    await campaign(P1, { status: 'sent', success: 6, failure: 0, completedAt: at('09:00:00'), parent: tz });
    // Still sending: not finished, so not counted, whatever its stamps say.
    await campaign(P1, { status: 'sending', success: 50, failure: 0, completedAt: null });
    await campaign(P1, { status: 'sending', success: 50, failure: 0, completedAt: at('10:00:00') });
    // Just before the day in UTC (05:29 on the 13th in India): the 12th.
    await campaign(P1, { status: 'sent', success: 9, failure: 0, completedAt: '2026-11-12T23:59:00Z' });
    // 01:30 on the 14th in India, still the 13th in UTC.
    await campaign(P1, { status: 'sent', success: 4, failure: 0, completedAt: '2026-11-13T20:00:00Z' });

    const [message] = await m.query(
      `INSERT INTO in_app_messages (project_id, name, title, message_type) VALUES ($1, 'm', 't', 'modal') RETURNING id`,
      [P1],
    );
    for (const type of ['impression', 'impression', 'impression', 'click', 'delivered']) {
      await m.query(
        `INSERT INTO in_app_message_impressions (message_id, project_id, device_fingerprint, event_type, created_at)
         VALUES ($1, $2, 'fp-x', $3, $4::timestamptz::timestamp)`,
        [message.id, P1, type, at('11:00:00')],
      );
    }

    const [link] = await m.query(
      `INSERT INTO links (project_id, short_code, long_url) VALUES ($1, $2, 'https://example.com') RETURNING id`,
      [P1, `u${randomUUID().slice(0, 8)}`],
    );
    for (const clickedAt of [at('00:10:00'), at('12:00:00'), at('18:29:00'), '2026-11-13T20:00:00Z', '2026-11-12T22:00:00Z']) {
      await m.query(
        `INSERT INTO click_events (link_id, clicked_at, platform, device_type, redirect_type)
         VALUES ($1, $2::timestamptz::timestamp, 'ios', 'mobile', 'app_store')`,
        [link.id, clickedAt],
      );
    }

    for (let i = 0; i < 4; i++) await event(P1, at(`1${i}:00:00`));
    // Flushed from an offline queue: client time last week, received today.
    await event(P1, at('15:00:00'), '2026-11-06T15:00:00Z');
    // Received the day before, client time today: the 12th.
    await event(P1, '2026-11-12T23:00:00Z', at('01:00:00'));

    await device(P1, at('02:00:00'));
    await device(P1, '2026-11-13T19:00:00Z');
    // First seen on earlier days and saved again today: not new today.
    await device(P1, '2026-11-12T12:00:00Z', at('16:00:00'));
    await device(P1, '2026-11-02T08:00:00Z', at('17:00:00'));
  };

  const seedP2 = async () => {
    await campaign(P2, { status: 'sent', success: 1, failure: 0, completedAt: `${DAY}T12:00:00Z` });
    await event(P2, `${DAY}T12:00:00Z`);
  };

  const owners = async (project: string) =>
    (await m.query(`SELECT DISTINCT owner_id FROM usage_daily WHERE project_id = $1`, [project])).map(
      (r: { owner_id: string }) => r.owner_id,
    );

  it('counts each metric once, on the UTC day, for each project and its billing owner', async () => {
    await seedP1();
    await seedP2();

    await countWindow(m, projects, DAY, ...window(DAY));
    const days = await readDay(m, [P1, P2], DAY);

    expect(days.get(P1)).toEqual({
      push_sent: 5 + 7 + 10 + 11 + 6 + 4,
      email_sent: 3,
      whatsapp_sent: 2,
      messages_failed: 2 + 4 + 1,
      in_app_impressions: 3,
      clicks: 4,
      events: 5,
      new_people: 2,
    });
    expect(days.get(P2)).toEqual({ push_sent: 1, events: 1 });
    expect(await owners(P1)).toEqual([A]);
    expect(await owners(P2)).toEqual([B]);
  });

  it('counts the day before only from its own rows', async () => {
    await seedP1();
    await countWindow(m, projects, '2026-11-12', ...window('2026-11-12'));
    expect((await readDay(m, [P1], '2026-11-12')).get(P1)).toEqual({
      push_sent: 9,
      clicks: 1,
      events: 1,
      new_people: 1,
    });
  });

  it('gives the same rows when a day is counted again', async () => {
    await seedP1();
    await seedP2();
    await countWindow(m, projects, DAY, ...window(DAY));
    const first = await m.query(
      `SELECT project_id, owner_id, metric, value FROM usage_daily WHERE project_id = ANY($1) ORDER BY 1, 3`,
      [[P1, P2]],
    );
    await countWindow(m, projects, DAY, ...window(DAY));
    const second = await m.query(
      `SELECT project_id, owner_id, metric, value FROM usage_daily WHERE project_id = ANY($1) ORDER BY 1, 3`,
      [[P1, P2]],
    );
    expect(second).toEqual(first);
  });

  it('writes nothing for a day with nothing in it', async () => {
    await seedP1();
    await seedP2();
    await countWindow(m, projects, '2026-11-10', ...window('2026-11-10'));
    const [row] = await m.query(`SELECT count(*)::int AS n FROM usage_daily WHERE project_id = ANY($1)`, [[P1, P2]]);
    expect(row.n).toBe(0);
  });

  it('never lowers a count: rows deleted after counting leave it as it was', async () => {
    await seedP1();
    await countWindow(m, projects, DAY, ...window(DAY));
    await m.query(
      `DELETE FROM user_events WHERE id = (SELECT id FROM user_events WHERE project_id = $1 AND created_at >= $2::timestamptz::timestamp LIMIT 1)`,
      [P1, dayStart(DAY)],
    );
    await countWindow(m, projects, DAY, ...window(DAY));
    expect((await readDay(m, [P1], DAY)).get(P1)?.events).toBe(5);
  });

  it('writes counts only for the day it is given', async () => {
    await seedP1();
    await countWindow(m, projects, DAY, ...window(DAY));
    const days = await m.query(
      `SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM usage_daily WHERE project_id = $1`,
      [P1],
    );
    expect(days).toEqual([{ day: DAY }]);
  });

  it('counts active API keys at a point in time', async () => {
    const now = new Date('2026-11-14T00:30:00Z');
    const key = (active: boolean, expiresAt: string | null) =>
      m.query(
        `INSERT INTO api_keys (project_id, name, key_hash, prefix, is_active, expires_at)
         VALUES ($1, 'k', $2, 'ck_live', $3, $4::timestamptz::timestamp)`,
        [P1, randomUUID(), active, expiresAt],
      );
    await key(true, null);
    await key(true, '2026-12-01T00:00:00Z');
    await key(false, null);
    await key(true, '2026-11-13T00:00:00Z');

    await writeApiKeySnapshot(m, projects, DAY, now);
    expect((await readDay(m, [P1, P2], DAY)).get(P1)).toEqual({ api_keys_active: 2 });
    // Taken, so a project with no working key is a stored 0, not a missing row.
    expect((await readDay(m, [P1, P2], DAY)).get(P2)).toEqual({ api_keys_active: 0 });
  });
});
