import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import { PushTokensService } from '../push-tokens/push-tokens.service';
import { SegmentCompilerService } from '../segments/segment-compiler.service';
import { SegmentEvaluationService } from '../segments/segment-evaluation.service';
import { SegmentMemberEntity } from '../segments/entities/segment-member.entity';
import { SegmentEntity } from '../segments/entities/segment.entity';
import { saveCampaign } from './save-campaign';
import { Recipients, STAGED, stageRecipients, storedRecipients } from './recipients';

/**
 * A campaign's recipients are rows in campaign_recipients, written by one
 * INSERT ... SELECT from the segment, never a list held in memory or on the campaign
 * row. Anyone with an app's key can add device rows to a segment, so a size limit on
 * an audience was a way to stop a tenant's campaigns to it: there must be none.
 */
describe('Campaign recipients (integration)', () => {
  let ds: DataSource;
  let evaluation: SegmentEvaluationService;
  let tokens: PushTokensService;
  const owner = randomUUID();
  let projectId: string;

  beforeAll(async () => {
    ds = await openIntDb();
    evaluation = new SegmentEvaluationService(ds, new SegmentCompilerService(), ds.getRepository(SegmentMemberEntity));
    tokens = new PushTokensService(ds.getRepository(PushTokenEntity), null as never);
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'r')`, [
      owner,
      `${owner}@campaign-recipients-int.test`,
    ]);
  });

  beforeEach(async () => {
    projectId = await newProject();
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  const newProject = async (): Promise<string> =>
    (await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('r', $1) RETURNING id`, [owner]))[0].id;

  const device = async (row: { project?: string; externalUserId?: string; platform?: string } = {}) => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO device_identities (id, project_id, external_user_id, device_fingerprint, platform)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, row.project ?? projectId, row.externalUserId ?? null, `fp-${id}`, row.platform ?? 'ios'],
    );
    return id;
  };

  const liveSegment = (definition: object): SegmentEntity =>
    ({ id: randomUUID(), projectId, definition, evaluationMode: 'live' }) as unknown as SegmentEntity;
  const IOS = { type: 'attribute', field: 'platform', op: 'eq', value: 'ios' };

  const campaignFor = async (recipients: Recipients | null, targetType = 'segment') => {
    const repo = ds.getRepository(PushNotificationLogEntity);
    return saveCampaign(
      repo,
      null as never,
      repo.create({
        projectId,
        title: 't',
        body: 'b',
        targetType,
        totalTokens: 0,
        processedTokens: 0,
        successCount: 0,
        failureCount: 0,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 86_400_000),
      } as Partial<PushNotificationLogEntity>) as PushNotificationLogEntity,
      null,
      recipients,
    );
  };

  const storedIds = async (campaignId: string, role = 'target'): Promise<string[]> =>
    (
      await ds.query(
        `SELECT device_identity_id AS id FROM campaign_recipients WHERE campaign_id = $1 AND role = $2 ORDER BY 1`,
        [campaignId, role],
      )
    ).map((row: { id: string }) => row.id);

  it('stores a segment of 30,000 people as one campaign\'s recipients: an audience has no size limit', async () => {
    await ds.query(
      `INSERT INTO device_identities (project_id, device_fingerprint, platform)
       SELECT $1, 'bulk-' || g, CASE WHEN g <= 30000 THEN 'ios' ELSE 'android' END
         FROM generate_series(1, 30010) g`,
      [projectId],
    );
    // Every row carries a token, so the counts below read the token table too.
    await ds.query(
      `INSERT INTO push_tokens (project_id, device_identity_id, token, platform, provider, is_active)
       SELECT $1, id, 'bulk-tok-' || id, 'ios', 'apns', true FROM device_identities WHERE project_id = $1`,
      [projectId],
    );
    // What autovacuum does within a minute of 5,000 changed rows on these tables (the
    // migration sets that). With statistics that have never seen the project, Postgres
    // can take it for one row and scan it once per recipient: that window is what the
    // setting keeps short, and it is not specific to stored recipients.
    await ds.query(`ANALYZE device_identities`);
    await ds.query(`ANALYZE push_tokens`);
    const started = Date.now();
    const recipients: Recipients = { kind: 'query', ...evaluation.devicesQuery(liveSegment(IOS)) };

    const counted = await ds.transaction(async (manager) => ({
      devices: await stageRecipients(manager, projectId, recipients),
      tokens: await tokens.countTokensByDeviceIdentityIds(projectId, STAGED, null, manager),
    }));
    expect(counted).toEqual({ devices: 30000, tokens: 30000 });

    const campaign = await campaignFor(recipients);
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND role = 'target'`,
      [campaign.id],
    );
    expect(n).toBe(30000);
    await ds.query(`ANALYZE campaign_recipients`);

    // The worker's walk over the stored recipients, a page at a time.
    let sent = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: PushTokenEntity[] = await tokens.getTokensByDeviceIdentityIdsPage(
        projectId,
        storedRecipients(campaign.id),
        cursor,
        5000,
      );
      if (page.length === 0) break;
      sent += page.length;
      cursor = page[page.length - 1].id;
    }
    expect(sent).toBe(30000);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("names the same devices as walking the segment and fanning its people out, and none of another project's", async () => {
    const phone = await device({ externalUserId: 'u1' });
    const tablet = await device({ externalUserId: 'u1', platform: 'android' });
    const anonymous = await device();
    await device({ externalUserId: 'u2', platform: 'android' });
    const elsewhere = await newProject();
    await device({ project: elsewhere, externalUserId: 'u1' });
    const segment = liveSegment(IOS);

    const walked = await evaluation.resolveDeviceIdentityIds(projectId, await evaluation.enumerate(segment, null, 1000));
    const campaign = await campaignFor({ kind: 'query', ...evaluation.devicesQuery(segment) });

    // u1 is in the segment through the phone, so every device of u1 is a recipient.
    expect(await storedIds(campaign.id)).toEqual([phone, tablet, anonymous].sort());
    expect(await storedIds(campaign.id)).toEqual([...walked].sort());
  });

  it('reads a materialised segment from its stored members', async () => {
    const member = await device({ externalUserId: 'm1' });
    const anonymous = await device();
    await device({ externalUserId: 'not-a-member' });
    const [{ id: segmentId }] = await ds.query(
      `INSERT INTO segments (project_id, name, definition, evaluation_mode, last_materialized_at)
       VALUES ($1, 's', $2, 'materialized', now()) RETURNING id`,
      [projectId, JSON.stringify(IOS)],
    );
    await ds.query(
      `INSERT INTO segment_members (segment_id, project_id, person_key) VALUES ($1, $2, 'm1'), ($1, $2, $3)`,
      [segmentId, projectId, `device:${anonymous}`],
    );
    const segment = (await ds.getRepository(SegmentEntity).findOneByOrFail({ id: segmentId }))!;

    const campaign = await campaignFor({ kind: 'query', ...evaluation.devicesQuery(segment) });

    expect(await storedIds(campaign.id)).toEqual([member, anonymous].sort());
  });

  it('stores a list from a request only for devices of the campaign\'s own project', async () => {
    const mine = await device();
    const theirs = await device({ project: await newProject() });

    const campaign = await campaignFor({ kind: 'devices', ids: [mine, theirs] }, 'devices');

    expect(await storedIds(campaign.id)).toEqual([mine]);
  });

  it('sends a stored campaign to its targets only, never its held-back control', async () => {
    const target = await device();
    const control = await device();
    const campaign = await campaignFor({ kind: 'devices', ids: [target] }, 'devices');
    await ds.query(`INSERT INTO campaign_recipients (campaign_id, role, device_identity_id) VALUES ($1, 'control', $2)`, [
      campaign.id,
      control,
    ]);
    for (const id of [target, control]) {
      await ds.query(
        `INSERT INTO push_tokens (project_id, device_identity_id, token, platform, provider, is_active)
         VALUES ($1, $2, $3, 'android', 'fcm', true)`,
        [projectId, id, `tok-${id}`],
      );
    }

    const page = await tokens.getTokensByDeviceIdentityIdsPage(projectId, storedRecipients(campaign.id), null, 100);

    expect(page.map((t) => t.deviceIdentityId)).toEqual([target]);
    expect(await tokens.countTokensByDeviceIdentityIds(projectId, storedRecipients(campaign.id))).toBe(1);
  });

  it('loses an erased device from every campaign it was for', async () => {
    const erased = await device();
    const kept = await device();
    const campaign = await campaignFor({ kind: 'devices', ids: [erased, kept] }, 'devices');

    await ds.query(`DELETE FROM device_identities WHERE id = $1`, [erased]);

    expect(await storedIds(campaign.id)).toEqual([kept]);
  });

  it('refuses a narrowed campaign with no recipients, and a project-wide one with some', async () => {
    await expect(campaignFor(null, 'segment')).rejects.toThrow(/does not match/);
    await expect(campaignFor({ kind: 'devices', ids: [] }, 'project')).rejects.toThrow(/does not match/);
  });
});
