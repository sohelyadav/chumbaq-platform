import { DataSource } from 'typeorm';
import { closeIntDb, INT_PROJECT_ID, openIntDb, resetFixtures } from '../../test-support/int-db';
import { ConversionEventEntity } from '../conversions/entities/conversion-event.entity';
import type { LinksService } from '../links/links.service';
import { AnalyticsService } from './analytics.service';
import type { ProjectAccessService } from '../project-access/project-access.service';
import { ClickEventEntity } from './entities/click-event.entity';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { TrackingConsentService } from '../consent/tracking-consent.service';

const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SHORT_CODE = 'clickdevicelink';
const DEVICE = '6f1c2a54-9b3e-4d7a-8c21-0e5f7a9b1c33';

/** Real Postgres, because what is under test is the project-scoped identity lookup. */
describe('Linking a click to its device (integration)', () => {
  let ds: DataSource;
  let service: AnalyticsService;
  let linkId: string;

  const click = (deviceFingerprint?: string) =>
    service.recordClick({
      linkId,
      platform: 'web',
      deviceType: 'desktop',
      redirectType: 'web_fallback',
      deviceFingerprint,
    });
  const identity = (projectId: string, distinctId: string | null) =>
    ds.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, distinct_id, platform, last_seen_at)
       VALUES ($1, $2, $3, 'web', now()) RETURNING id`,
      [projectId, DEVICE, distinctId],
    );

  beforeAll(async () => {
    ds = await openIntDb();
    service = new AnalyticsService(
      ds.getRepository(ClickEventEntity),
      ds.getRepository(ConversionEventEntity),
      { findOne: async () => ({ projectId: INT_PROJECT_ID }) } as unknown as LinksService,
      new TrackingConsentService(ds.getRepository(DeviceIdentityEntity)),
      {} as unknown as ProjectAccessService,
    );
  });

  beforeEach(async () => {
    await resetFixtures(ds);
    await ds.query(`DELETE FROM links WHERE short_code = $1`, [SHORT_CODE]);
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, 'click-link@test.local', 'x', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_PROJECT_ID],
    );
    await ds.query(
      `INSERT INTO projects (id, name, owner_id) VALUES ($1, 'other', $1) ON CONFLICT (id) DO NOTHING`,
      [OTHER_PROJECT_ID],
    );
    [{ id: linkId }] = await ds.query(
      `INSERT INTO links (project_id, short_code, long_url) VALUES ($1, $2, 'https://example.com') RETURNING id`,
      [INT_PROJECT_ID, SHORT_CODE],
    );
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM links WHERE short_code = $1`, [SHORT_CODE]);
    await ds.query(`DELETE FROM device_identities WHERE device_fingerprint = $1`, [DEVICE]);
    await ds.query(`DELETE FROM projects WHERE id = $1`, [OTHER_PROJECT_ID]);
    await ds.query(`DELETE FROM users WHERE id = $1`, [OTHER_PROJECT_ID]);
    await closeIntDb(ds);
  });

  it('links the click to the device and its person', async () => {
    const [{ id }] = await identity(INT_PROJECT_ID, 'person-1');
    const saved = await click(DEVICE);
    expect(saved.deviceIdentityId).toBe(id);
    expect(saved.distinctId).toBe('person-1');
  });

  it('records the click without the device or person when the device is do-not-track', async () => {
    const [{ id }] = await identity(INT_PROJECT_ID, 'person-1');
    await ds.query(`UPDATE device_identities SET do_not_track = true WHERE id = $1`, [id]);
    const saved = await click(DEVICE);
    expect(saved.id).toBeDefined();
    expect(saved.deviceIdentityId).toBeNull();
    expect(saved.distinctId).toBeNull();
  });

  it('still links it when only another device claiming the same id set do-not-track', async () => {
    // An SDK-set flag covers its own device only: anyone can claim an id.
    const [{ id }] = await identity(INT_PROJECT_ID, 'person-1');
    await ds.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, distinct_id, platform, do_not_track, last_seen_at)
       VALUES ($1, 'other-device', 'person-1', 'ios', true, now())`,
      [INT_PROJECT_ID],
    );
    expect((await click(DEVICE)).deviceIdentityId).toBe(id);
  });

  it('records it unlinked when the dashboard objected for the person', async () => {
    const [{ id }] = await identity(INT_PROJECT_ID, 'person-1');
    await ds.query(`UPDATE device_identities SET external_user_id = 'ext-1' WHERE id = $1`, [id]);
    await ds.query(
      `INSERT INTO tracking_objections (project_id, external_user_id) VALUES ($1, 'ext-1')`,
      [INT_PROJECT_ID],
    );
    try {
      expect((await click(DEVICE)).deviceIdentityId).toBeNull();
    } finally {
      await ds.query(`DELETE FROM tracking_objections WHERE project_id = $1`, [INT_PROJECT_ID]);
    }
  });

  it('never links across projects, however the device ID matches', async () => {
    await identity(OTHER_PROJECT_ID, 'someone-elses');
    const saved = await click(DEVICE);
    expect(saved.deviceIdentityId).toBeNull();
    expect(saved.distinctId).toBeNull();
  });

  it('records the click with no link for a device nobody has registered', async () => {
    const saved = await click(DEVICE);
    expect(saved.id).toBeDefined();
    expect(saved.deviceIdentityId).toBeNull();
  });

  it('records the click with no cookie, as before', async () => {
    expect((await click()).deviceIdentityId).toBeNull();
  });
});
