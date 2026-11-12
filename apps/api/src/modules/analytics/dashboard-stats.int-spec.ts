import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb, resetFixtures } from '../../test-support/int-db';
import { ConversionEventEntity } from '../conversions/entities/conversion-event.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { LinksService } from '../links/links.service';
import { AnalyticsService } from './analytics.service';
import { ClickEventEntity } from './entities/click-event.entity';

const ME = '71111111-0000-4000-8000-000000000001';
const BILLED_OWNER = '71111111-0000-4000-8000-000000000002';
const STRANGER = '71111111-0000-4000-8000-000000000003';
const OWN_PROJECT = '72222222-0000-4000-8000-000000000001';
const SHARED_PROJECT = '72222222-0000-4000-8000-000000000002';
const STRANGER_PROJECT = '72222222-0000-4000-8000-000000000003';

const asUser = (userId: string, impersonatedBy?: string): AuthenticatedUser =>
  ({ userId, email: `${userId}@test.local`, isSuperAdmin: false, impersonatedBy }) as AuthenticatedUser;

/** Real Postgres: what is under test is the visible-projects SQL in all four statements. */
describe('Dashboard stats across visible projects (integration)', () => {
  let ds: DataSource;
  let service: AnalyticsService;

  const project = async (id: string, ownerId: string, memberId: string | null, role = 'owner') => {
    await ds.query(`INSERT INTO projects (id, name, owner_id) VALUES ($1, 'p', $2)`, [id, ownerId]);
    if (memberId) await addOwnerMember(ds, id, memberId, role as 'owner');
    const [{ id: linkId }] = await ds.query(
      `INSERT INTO links (project_id, short_code, long_url) VALUES ($1, $2, 'https://example.com') RETURNING id`,
      [id, `ds${id.slice(-2)}${Math.random().toString(36).slice(2, 8)}`],
    );
    await ds.query(`INSERT INTO click_events (link_id, platform, device_type, redirect_type) VALUES ($1, 'web', 'desktop', 'direct_url')`, [linkId]);
    await ds.query(`INSERT INTO conversion_events (link_id, event_type) VALUES ($1, 'purchase')`, [linkId]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    service = new AnalyticsService(
      ds.getRepository(ClickEventEntity),
      ds.getRepository(ConversionEventEntity),
      {} as unknown as LinksService,
      new TrackingConsentService(ds.getRepository(DeviceIdentityEntity)),
      new ProjectAccessService(null as never, null as never, null as never, null as never),
    );
  });
  afterAll(() => closeIntDb(ds));

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query(`DELETE FROM projects WHERE id IN ($1, $2, $3)`, [OWN_PROJECT, SHARED_PROJECT, STRANGER_PROJECT]);
    for (const id of [ME, BILLED_OWNER, STRANGER]) {
      await ds.query(
        `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'x') ON CONFLICT (id) DO NOTHING`,
        [id, `${id}@test.local`],
      );
    }
    await project(OWN_PROJECT, ME, ME);
    await project(SHARED_PROJECT, BILLED_OWNER, BILLED_OWNER); // ME is added below
    await addOwnerMember(ds, SHARED_PROJECT, ME, 'member' as never);
    await project(STRANGER_PROJECT, STRANGER, STRANGER);
  });

  it('counts a project the caller is a member of but does not own, and not a non-member project', async () => {
    const stats = await service.getDashboardStats(asUser(ME));
    expect(stats.totalLinks).toBe(2);
    expect(stats.clicks24h).toBe(2);
    expect(stats.clicks30d).toBe(2);
    expect(stats.totalConversions).toBe(2);
    expect(stats.topLinks).toHaveLength(2);
  });

  it('in a view-as session counts only projects the viewed account owns', async () => {
    const stats = await service.getDashboardStats(asUser(ME, 'staff-1'));
    expect(stats.totalLinks).toBe(1);
    expect(stats.clicks24h).toBe(1);
    expect(stats.totalConversions).toBe(1);
    expect(stats.topLinks).toHaveLength(1);
  });
});
