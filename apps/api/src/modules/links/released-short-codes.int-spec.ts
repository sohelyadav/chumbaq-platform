import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { LinkEntity } from './entities/link.entity';
import { ReleasedShortCodeEntity } from './entities/released-short-code.entity';
import { LinksService } from './links.service';

/**
 * A short URL keeps being clicked after its link is deleted, so its code must never be
 * handed to another project: that project would receive every visitor of a URL it never
 * gave out.
 */
describe('Released short codes (integration)', () => {
  const DOMAIN = '@released-codes-int.test';
  let ds: DataSource;
  let links: LinksService;
  const users: string[] = [];

  const project = async (): Promise<{ projectId: string; userId: string }> => {
    const userId = randomUUID();
    users.push(userId);
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'codes')`, [
      userId,
      `${userId}${DOMAIN}`,
    ]);
    const [{ id }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('codes', $1) RETURNING id`, [userId]);
    await addOwnerMember(ds, id, userId);
    return { projectId: id, userId };
  };

  const requester = (userId: string) => ({ userId, context: { ipAddress: null, userAgent: null } });
  const code = () => `rel-${randomUUID().slice(0, 8)}`;
  const holder = async (shortCode: string) =>
    (await ds.query(`SELECT project_id FROM links WHERE short_code = $1`, [shortCode]))[0]?.project_id ?? null;

  beforeAll(async () => {
    ds = await openIntDb();
    links = new LinksService(
      ds.getRepository(LinkEntity),
      ds.getRepository(ReleasedShortCodeEntity),
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
  });

  afterAll(async () => {
    if (users.length) await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await closeIntDb(ds);
  });

  it('refuses a custom code another project deleted, and lets that project take it back', async () => {
    const first = await project();
    const second = await project();
    const shortCode = code();
    const link = await links.create(first.projectId, { longUrl: 'https://first.example.test/', shortCode });
    await links.remove(link.id, first.projectId, requester(first.userId));

    await expect(
      links.create(second.projectId, { longUrl: 'https://second.example.test/', shortCode }),
    ).rejects.toThrow(ConflictException);
    expect(await holder(shortCode)).toBeNull();

    await links.create(first.projectId, { longUrl: 'https://first.example.test/again', shortCode });
    expect(await holder(shortCode)).toBe(first.projectId);
  });

  it('refuses a generated code once its link is gone', async () => {
    const first = await project();
    const second = await project();
    const link = await links.create(first.projectId, { longUrl: 'https://first.example.test/' });
    await links.remove(link.id, first.projectId, requester(first.userId));

    await expect(
      links.create(second.projectId, { longUrl: 'https://second.example.test/', shortCode: link.shortCode }),
    ).rejects.toThrow(ConflictException);
  });

  it('keeps every code of a deleted project retired', async () => {
    const first = await project();
    const second = await project();
    const shortCode = code();
    await links.create(first.projectId, { longUrl: 'https://first.example.test/', shortCode });
    await ds.query(`DELETE FROM projects WHERE id = $1`, [first.projectId]);

    await expect(
      links.create(second.projectId, { longUrl: 'https://second.example.test/', shortCode }),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses a code another project released after the checks ran', async () => {
    const first = await project();
    const second = await project();
    const shortCode = code();
    // As if the first project's link came and went between the second's checks and insert.
    await ds.query(`INSERT INTO released_short_codes (short_code, project_id) VALUES ($1, $2)`, [
      shortCode,
      first.projectId,
    ]);
    const releasedRepo = ds.getRepository(ReleasedShortCodeEntity);
    const blind = new LinksService(
      ds.getRepository(LinkEntity),
      { findOne: async () => null } as never,
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
    const claim = blind as unknown as { releasedToAnotherProject: (...a: unknown[]) => Promise<boolean> };
    const real = claim.releasedToAnotherProject.bind(blind);
    let calls = 0;
    claim.releasedToAnotherProject = async (...args) => (++calls === 1 ? false : real(...args));

    await expect(
      blind.create(second.projectId, { longUrl: 'https://second.example.test/', shortCode }),
    ).rejects.toThrow(ConflictException);
    expect(await holder(shortCode)).toBeNull();
    expect(await releasedRepo.count({ where: { shortCode } })).toBe(1);
  });
});
