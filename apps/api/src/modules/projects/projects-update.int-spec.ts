import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SeatsService } from '../project-access/seats.service';
import { ProjectAccessService } from '../project-access/project-access.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { addOwnerMember, closeIntDb, openIntDb } from '../../test-support/int-db';
import { ProjectEntity } from './entities/project.entity';
import { ProjectsService } from './projects.service';
import { AccountLimitsService } from '../billing/account-limits.service';

/**
 * `PATCH /projects/:id` gets the row the access guard read, without a lock. A billing
 * accept, leave, removal or offer cancel can commit between that read and the write;
 * the rename must not put the old owner or offer back.
 */
const CTX = { ipAddress: null, userAgent: null };

describe('Project settings update against a stale row (integration)', () => {
  const DOMAIN = '@project-update-int.test';
  let ds: DataSource;
  let service: ProjectsService;
  const users: string[] = [];

  const account = async (): Promise<string> => {
    const id = randomUUID();
    users.push(id);
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'update')`, [
      id,
      `${id}${DOMAIN}`,
    ]);
    return id;
  };

  const project = async (ownerId: string, pendingId: string | null): Promise<string> => {
    const [{ id }] = await ds.query(
      `INSERT INTO projects (name, owner_id, pending_billing_owner_id, pending_billing_offered_at)
       VALUES ('before', $1, $2, CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [ownerId, pendingId],
    );
    await addOwnerMember(ds, id, ownerId);
    return id;
  };

  /** As the guard reads it: a plain unlocked find. */
  const guardRead = (id: string) => ds.getRepository(ProjectEntity).findOneOrFail({ where: { id } });

  const row = async (id: string) =>
    (
      await ds.query(
        `SELECT name, domain, owner_id, pending_billing_owner_id, pending_billing_offered_at FROM projects WHERE id = $1`,
        [id],
      )
    )[0];

  beforeAll(async () => {
    ds = await openIntDb();
    service = new ProjectsService(
      ds.getRepository(ProjectEntity),
      new AccountLimitsService(new ConfigService({})),
      new ProjectAccessService(null as never, null as never, null as never, null as never),
      new SeatsService(ds, new AccountLimitsService(new ConfigService({}))),
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
  });

  afterAll(async () => {
    if (users.length) await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
    await closeIntDb(ds);
  });

  it('keeps a billing transfer accepted after the guard read the row', async () => {
    const oldOwner = await account();
    const newOwner = await account();
    const id = await project(oldOwner, newOwner);
    const stale = await guardRead(id);

    // The accept commits in another transaction.
    await ds.query(
      `UPDATE projects SET owner_id = $2, pending_billing_owner_id = NULL, pending_billing_offered_at = NULL WHERE id = $1`,
      [id, newOwner],
    );

    const result = await service.update(stale.ownerId, stale, { name: 'renamed', domain: 'new.example.com' }, CTX);

    const after = await row(id);
    expect(after.name).toBe('renamed');
    expect(after.domain).toBe('new.example.com');
    expect(after.owner_id).toBe(newOwner);
    expect(after.pending_billing_owner_id).toBeNull();
    expect(after.pending_billing_offered_at).toBeNull();
    expect(result.ownerId).toBe(newOwner);
    expect(result.name).toBe('renamed');
  });

  it('does not restore an offer cancelled after the guard read the row', async () => {
    const owner = await account();
    const offered = await account();
    const id = await project(owner, offered);
    const stale = await guardRead(id);

    await ds.query(
      `UPDATE projects SET pending_billing_owner_id = NULL, pending_billing_offered_at = NULL WHERE id = $1`,
      [id],
    );

    await service.update(stale.ownerId, stale, { name: 'renamed' }, CTX);

    const after = await row(id);
    expect(after.owner_id).toBe(owner);
    expect(after.pending_billing_owner_id).toBeNull();
    expect(after.pending_billing_offered_at).toBeNull();
  });

  it('does not wipe an offer made after the guard read the row', async () => {
    const owner = await account();
    const offered = await account();
    const id = await project(owner, null);
    const stale = await guardRead(id);

    await ds.query(
      `UPDATE projects SET pending_billing_owner_id = $2, pending_billing_offered_at = now() WHERE id = $1`,
      [id, offered],
    );

    await service.update(stale.ownerId, stale, { name: 'renamed' }, CTX);

    const after = await row(id);
    expect(after.pending_billing_owner_id).toBe(offered);
    expect(after.pending_billing_offered_at).not.toBeNull();
  });
});
