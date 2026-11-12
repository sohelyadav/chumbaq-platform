import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { bootDashboardApp } from '../../test-support/sweep-fixtures';
import { ProjectEntity } from '../projects/entities/project.entity';
import { UserEntity } from '../users/entities/user.entity';

const DOMAIN = '@bulk-export-alarm-int.test';

/** An export over the hourly row limit raises `data.bulk_export`, and the file is unchanged. */
describe('bulk export alarm (integration)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let restoreEnv: () => void = () => undefined;
  const saved = process.env.BULK_EXPORT_ALERT_ROWS;

  const cleanup = async () => {
    await ds.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${DOMAIN}`]);
    await ds.query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    await cleanup();
    process.env.BULK_EXPORT_ALERT_ROWS = '3';
    ({ app, base, restoreEnv } = await bootDashboardApp());
  }, 120000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.BULK_EXPORT_ALERT_ROWS;
    else process.env.BULK_EXPORT_ALERT_ROWS = saved;
    await app?.close();
    restoreEnv();
    await cleanup();
    await closeIntDb(ds);
  });

  it('raises data.bulk_export once the account has exported more rows than the limit in an hour', async () => {
    const email = `owner-${randomUUID().slice(0, 8)}${DOMAIN}`;
    const userId = (await ds.getRepository(UserEntity).save({ email, name: 'Owner', passwordHash: 'x' })).id;
    const token = await new JwtService({ secret: process.env.JWT_SECRET as string }).signAsync(
      { sub: userId, email, type: 'access', auth_time: Math.floor(Date.now() / 1000) },
      { expiresIn: '15m' },
    );
    const projectId = (await ds.getRepository(ProjectEntity).save({ name: 'Bulk', ownerId: userId })).id;
    await addOwnerMember(ds, projectId, userId);
    for (let i = 0; i < 2; i++) {
      await ds.query(
        `INSERT INTO project_activity (project_id, actor_kind, actor_user_id, actor_label, action)
         VALUES ($1, 'user', $2, 'Owner', 'project.renamed')`,
        [projectId, userId],
      );
    }
    const download = () =>
      fetch(`${base}/api/projects/${projectId}/activity/export`, { headers: { authorization: `Bearer ${token}` } });

    const first = await download();
    expect(first.status).toBe(200);
    // 2 rows: under the limit of 3.
    expect(await alarmsFor(userId)).toEqual([]);

    // The first download wrote an `activity.exported` entry, so this one has 3 rows: 5 in all.
    const second = await download();
    expect(second.status).toBe(200);
    expect((await second.text()).trim().split('\n')).toHaveLength(4);

    let rows: unknown[] = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await alarmsFor(userId);
    }
    expect(rows).toEqual([
      { kind: 'data.bulk_export', details: { rows: 3, projectId, route: 'activity export' }, count: 1 },
    ]);
  });

  const alarmsFor = (userId: string) =>
    ds.query(`SELECT kind, details, count FROM security_alerts WHERE dedupe_key = $1`, [userId]);
});
