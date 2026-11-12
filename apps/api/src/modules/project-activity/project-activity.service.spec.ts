import * as geoip from 'geoip-lite';
import { ConfigService } from '@nestjs/config';
import { EntityManager, Repository } from 'typeorm';
import { ProjectActivityService, ActivityInput } from './project-activity.service';
import { ProjectActivityEntity } from './entities/project-activity.entity';
import { ACTIVITY_DETAIL_KEYS } from './activity-details';
import type { ActivityContext } from './activity-context';

jest.mock('geoip-lite', () => ({ lookup: jest.fn() }));

const PROJECT = '0f0e7f8a-1111-4c4c-9d9d-000000000001';
const USER = '0f0e7f8a-2222-4c4c-9d9d-000000000002';
const ctx: ActivityContext = { ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0' };

/** A manager whose `users` lookup returns `user`, and whose activity repository records inserts. */
const fakeManager = (user: { name: string | null; email: string } | null = { name: 'Priya', email: 'priya@acme.com' }) => {
  const insert = jest.fn(async () => undefined);
  const manager = {
    findOne: jest.fn(async () => user),
    getRepository: jest.fn(() => ({ insert })),
  } as unknown as EntityManager;
  return { manager, insert };
};

const service = (
  own = fakeManager(),
  geoipEnabled = false,
): ProjectActivityService =>
  new ProjectActivityService(
    { manager: own.manager } as unknown as Repository<ProjectActivityEntity>,
    new ConfigService({ app: { geoipEnabled } }),
  );

const input = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  projectId: PROJECT,
  actor: { kind: 'user', userId: USER },
  action: 'project.renamed',
  target: { type: 'project', id: PROJECT, label: 'Acme' },
  details: { from: 'Old', to: 'Acme' },
  ...overrides,
});

const written = (insert: jest.Mock) => {
  expect(insert).toHaveBeenCalledTimes(1);
  return (insert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
};

describe('ProjectActivityService.record', () => {
  beforeEach(() => jest.mocked(geoip.lookup).mockReset());

  it('writes one row with the actor, target, details and request context', async () => {
    const own = fakeManager();
    await service(own).record(input(), ctx);

    expect(written(own.insert)).toEqual({
      projectId: PROJECT,
      actorKind: 'user',
      actorUserId: USER,
      actorLabel: 'Priya (priya@acme.com)',
      action: 'project.renamed',
      targetType: 'project',
      targetId: PROJECT,
      targetLabel: 'Acme',
      details: { from: 'Old', to: 'Acme' },
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
      country: null,
    });
  });

  it('never sets the time itself: the database does', async () => {
    const own = fakeManager();
    await service(own).record(input(), ctx);
    expect(written(own.insert)).not.toHaveProperty('occurredAt');
  });

  it('writes through the passed manager, so it joins the caller’s transaction', async () => {
    const own = fakeManager();
    const transactional = fakeManager();

    await service(own).record(input(), ctx, transactional.manager);

    expect(transactional.insert).toHaveBeenCalledTimes(1);
    expect(transactional.manager.findOne).toHaveBeenCalled();
    expect(own.insert).not.toHaveBeenCalled();
    expect(own.manager.findOne).not.toHaveBeenCalled();
  });

  it('refuses a details key the action does not allow, and writes nothing', async () => {
    const own = fakeManager();
    await expect(
      service(own).record(input({ details: { from: 'a', to: 'b', password: 'hunter2' } }), ctx),
    ).rejects.toThrow('Activity detail "password" is not allowed for project.renamed');
    expect(own.insert).not.toHaveBeenCalled();
  });

  it('refuses any details on an action that allows none', async () => {
    const own = fakeManager();
    await expect(
      service(own).record(input({ action: 'api_key.revoked', details: { key: 'chq_live_secret' } }), ctx),
    ).rejects.toThrow('Activity detail "key" is not allowed for api_key.revoked');
    expect(own.insert).not.toHaveBeenCalled();
  });

  it('stores no details as null', async () => {
    const own = fakeManager();
    await service(own).record(input({ action: 'project.deleted', details: undefined }), ctx);
    expect(written(own.insert).details).toBeNull();
  });

  it('refuses an action it does not know', async () => {
    const own = fakeManager();
    await expect(
      service(own).record(input({ action: 'project.hacked' as never, details: undefined }), ctx),
    ).rejects.toThrow(/not a known activity action/);
    expect(own.insert).not.toHaveBeenCalled();
  });

  it('cuts a 500-character label with emoji to 200 code points, never splitting one', async () => {
    const own = fakeManager({ name: '🦊'.repeat(500), email: 'fox@x.com' });
    const label = '=' + '🚀'.repeat(499);
    await service(own).record(input({ target: { type: 'campaign', id: null, label } }), ctx);

    const row = written(own.insert);
    const target = row.targetLabel as string;
    expect(Array.from(target)).toHaveLength(200);
    expect(target).toBe('=' + '🚀'.repeat(199));

    const actor = row.actorLabel as string;
    expect(Array.from(actor)).toHaveLength(200);
    expect(actor).toBe('🦊'.repeat(200));
  });

  it('cuts the user agent to 512 characters', async () => {
    const own = fakeManager();
    await service(own).record(input(), { ipAddress: null, userAgent: 'x'.repeat(2000) });
    expect((written(own.insert).userAgent as string).length).toBe(512);
  });

  describe('actor label', () => {
    it('is "Name (email)" for a person with a name', async () => {
      const own = fakeManager({ name: '  Priya  ', email: 'priya@acme.com' });
      await service(own).record(input(), ctx);
      expect(written(own.insert)).toMatchObject({ actorKind: 'user', actorUserId: USER, actorLabel: 'Priya (priya@acme.com)' });
    });

    it.each([[''], ['   '], [null]])('is the email alone when the name is %p', async (name) => {
      const own = fakeManager({ name, email: 'priya@acme.com' });
      await service(own).record(input(), ctx);
      expect(written(own.insert).actorLabel).toBe('priya@acme.com');
    });

    it('refuses a person who does not exist rather than write an unnamed entry', async () => {
      const own = fakeManager(null);
      await expect(service(own).record(input(), ctx)).rejects.toThrow(/not found/);
      expect(own.insert).not.toHaveBeenCalled();
    });

    it('is "Chumbaq support" for staff, with no user id', async () => {
      const own = fakeManager();
      await service(own).record(
        input({ actor: { kind: 'staff' }, action: 'staff.viewed_as', target: undefined, details: undefined }),
        { ipAddress: null, userAgent: null },
      );
      expect(written(own.insert)).toMatchObject({
        actorKind: 'staff',
        actorUserId: null,
        actorLabel: 'Chumbaq support',
        targetType: null,
        targetId: null,
        targetLabel: null,
      });
      expect(own.manager.findOne).not.toHaveBeenCalled();
    });

    it('is API key "<name>" for a server API key, with no user id', async () => {
      const own = fakeManager();
      await service(own).record(
        input({
          actor: { kind: 'api_key', keyId: 'key-1', keyName: 'Backend' },
          action: 'person.erased',
          target: { type: 'person', id: 'person-1', label: null },
          details: undefined,
        }),
        ctx,
      );
      expect(written(own.insert)).toMatchObject({ actorKind: 'api_key', actorUserId: null, actorLabel: 'API key "Backend"' });
    });

    it('is "Chumbaq" for the platform itself', async () => {
      const own = fakeManager();
      await service(own).record(input({ actor: { kind: 'system' } }), ctx);
      expect(written(own.insert)).toMatchObject({ actorKind: 'system', actorUserId: null, actorLabel: 'Chumbaq' });
    });
  });

  describe('country', () => {
    it('is looked up when geo lookup is on', async () => {
      jest.mocked(geoip.lookup).mockReturnValue({ country: 'IN' } as never);
      const own = fakeManager();
      await service(own, true).record(input(), ctx);
      expect(geoip.lookup).toHaveBeenCalledWith('203.0.113.9');
      expect(written(own.insert).country).toBe('IN');
    });

    it('is never looked up when geo lookup is off', async () => {
      jest.mocked(geoip.lookup).mockReturnValue({ country: 'IN' } as never);
      const own = fakeManager();
      await service(own, false).record(input(), ctx);
      expect(geoip.lookup).not.toHaveBeenCalled();
      expect(written(own.insert).country).toBeNull();
    });

    it('is null for a private or missing address', async () => {
      const own = fakeManager();
      await service(own, true).record(input(), { ipAddress: '127.0.0.1', userAgent: null });
      await service(own, true).record(input(), { ipAddress: null, userAgent: null });
      expect(geoip.lookup).not.toHaveBeenCalled();
      expect(own.insert).toHaveBeenCalledTimes(2);
      for (const [row] of own.insert.mock.calls as unknown as [Record<string, unknown>][]) {
        expect(row.country).toBeNull();
      }
    });
  });
});

describe('ProjectActivityService.recordMany', () => {
  const OTHER = '0f0e7f8a-1111-4c4c-9d9d-000000000003';
  const staffInput = (projectId: string): ActivityInput => ({
    projectId,
    actor: { kind: 'staff' },
    action: 'staff.viewed_as',
  });

  it('writes every entry in one INSERT, each by the same rules as record', async () => {
    const own = fakeManager();
    await service(own).recordMany([staffInput(PROJECT), staffInput(OTHER)], { ipAddress: null, userAgent: null });

    const rows = written(own.insert) as unknown as Record<string, unknown>[];
    expect(rows).toEqual(
      [PROJECT, OTHER].map((projectId) => ({
        projectId,
        actorKind: 'staff',
        actorUserId: null,
        actorLabel: 'Chumbaq support',
        action: 'staff.viewed_as',
        targetType: null,
        targetId: null,
        targetLabel: null,
        details: null,
        ipAddress: null,
        userAgent: null,
        country: null,
      })),
    );
  });

  it('labels, cuts and checks each row', async () => {
    const own = fakeManager();
    await service(own).recordMany(
      [input(), input({ projectId: OTHER, target: { type: 'project', id: OTHER, label: '🚀'.repeat(300) } })],
      { ipAddress: '203.0.113.9', userAgent: 'x'.repeat(2000) },
    );
    const rows = written(own.insert) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ projectId: PROJECT, actorLabel: 'Priya (priya@acme.com)', targetLabel: 'Acme' });
    expect(rows[1]).toMatchObject({ projectId: OTHER, actorLabel: 'Priya (priya@acme.com)', targetLabel: '🚀'.repeat(200) });
    for (const row of rows) expect((row.userAgent as string).length).toBe(512);
  });

  it('writes nothing when any one row is refused', async () => {
    const own = fakeManager();
    await expect(
      service(own).recordMany(
        [input(), input({ projectId: OTHER, details: { from: 'a', to: 'b', password: 'hunter2' } })],
        ctx,
      ),
    ).rejects.toThrow('Activity detail "password" is not allowed for project.renamed');
    expect(own.insert).not.toHaveBeenCalled();
  });

  it('refuses details on staff.viewed_as, which allows none', async () => {
    const own = fakeManager();
    await expect(
      service(own).recordMany([{ ...staffInput(PROJECT), details: { reason: 'support ticket' } }], ctx),
    ).rejects.toThrow('Activity detail "reason" is not allowed for staff.viewed_as');
    expect(own.insert).not.toHaveBeenCalled();
  });

  it('writes nothing, and makes no query, for no entries', async () => {
    const own = fakeManager();
    await service(own).recordMany([], ctx);
    expect(own.manager.getRepository).not.toHaveBeenCalled();
  });

  it('writes through the passed manager', async () => {
    const own = fakeManager();
    const transactional = fakeManager();
    await service(own).recordMany([input()], ctx, transactional.manager);
    expect(transactional.insert).toHaveBeenCalledTimes(1);
    expect(own.insert).not.toHaveBeenCalled();
  });
});

describe('ACTIVITY_DETAIL_KEYS', () => {
  it('never allows a key that names a secret or an end user’s raw identifier', () => {
    const banned = /secret|token|password|url|host|credential|apikey|^key$|externalid|phone/i;
    for (const keys of Object.values(ACTIVITY_DETAIL_KEYS)) {
      for (const key of keys) expect(key).not.toMatch(banned);
    }
  });
});
