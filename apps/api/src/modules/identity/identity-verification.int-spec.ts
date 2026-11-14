import { randomUUID } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { ProjectActivityEntity } from '../project-activity/entities/project-activity.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { IdentityController } from './identity.controller';
import { IdentityVerificationService, userHashFor } from './identity-verification.service';

/**
 * An external user id from the SDK is a claim anyone with the app's key could make.
 * It is accepted only with a userHash from the tenant's server, made with the
 * project's identity secret, which never ships in an app.
 */
describe('Verified identity (integration)', () => {
  let ds: DataSource;
  let verification: IdentityVerificationService;
  let controller: IdentityController;
  let identified: Array<Record<string, unknown>>;
  const owner = randomUUID();
  let projectId: string;
  let otherProjectId: string;

  const req = (project: string) => ({ projectId: project, headers: {}, socket: {}, ip: "203.0.113.1" }) as never;

  beforeAll(async () => {
    ds = await openIntDb();
    await ds.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'x', 'v')`, [
      owner,
      `${owner}@verified-identity-int.test`,
    ]);
    [{ id: projectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('a', $1) RETURNING id`, [owner]);
    [{ id: otherProjectId }] = await ds.query(`INSERT INTO projects (name, owner_id) VALUES ('b', $1) RETURNING id`, [owner]);
    const crypto = new CredentialsCryptoService({ get: () => 'cd'.repeat(32) } as unknown as ConfigService);
    verification = new IdentityVerificationService(
      ds.getRepository(ProjectEntity),
      crypto,
      new ProjectActivityService(ds.getRepository(ProjectActivityEntity), new ConfigService({})),
    );
    const identityService = {
      identify: async (dto: Record<string, unknown>) => {
        identified.push(dto);
        return dto;
      },
      linkDevice: async (dto: Record<string, unknown>) => {
        identified.push(dto);
        return dto;
      },
    };
    controller = new IdentityController(identityService as never, {} as never, verification);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM users WHERE id = $1`, [owner]);
    await closeIntDb(ds);
  });

  beforeEach(() => {
    identified = [];
  });

  const identify = (body: Record<string, unknown>, project = projectId) =>
    controller.identify({ projectId: project, deviceFingerprint: 'fp', platform: 'ios', ...body } as never, req(project));
  const hashFor = async (id: string, project = projectId) =>
    userHashFor((await verification.currentSecret(project)).secret, id);

  it('takes an anonymous identify without any proof', async () => {
    await identify({});
    expect(identified).toHaveLength(1);
  });

  it('refuses an external id with no userHash, or a wrong one, before storing anything', async () => {
    await expect(identify({ externalUserId: 'user-42' })).rejects.toThrow(UnauthorizedException);
    await expect(identify({ externalUserId: 'user-42', userHash: await hashFor('user-43') })).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      identify({ externalUserId: 'user-42', userHash: await hashFor('user-42', otherProjectId) }),
    ).rejects.toThrow(UnauthorizedException);
    expect(identified).toEqual([]);
  });

  it('takes the external id with the userHash the tenant\'s server made, and never stores the hash', async () => {
    await identify({ externalUserId: 'user-42', userHash: await hashFor('user-42') });
    expect(identified[0]).toMatchObject({ externalUserId: 'user-42' });
    expect(identified[0]).not.toHaveProperty('userHash');
  });

  it('holds link-device to the same rule', async () => {
    const link = (userHash?: string) =>
      controller.linkDevice(
        { projectId, deviceFingerprint: 'fp', platform: 'ios', externalUserId: 'user-7', userHash } as never,
        req(projectId),
      );
    await expect(link()).rejects.toThrow(UnauthorizedException);
    await link(await hashFor('user-7'));
    expect(identified).toHaveLength(1);
  });

  it('stops every old userHash when the secret is rotated', async () => {
    const before = await hashFor('user-42');
    await verification.rotate(projectId, owner, { ipAddress: null, userAgent: null });
    await expect(identify({ externalUserId: 'user-42', userHash: before })).rejects.toThrow(UnauthorizedException);
    await identify({ externalUserId: 'user-42', userHash: await hashFor('user-42') });
    expect(identified).toHaveLength(1);
  });
});
