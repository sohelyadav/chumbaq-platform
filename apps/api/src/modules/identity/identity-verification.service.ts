import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import type { ActivityContext } from '../project-activity/activity-context';

/** HKDF purpose for the key every project's identity secret is derived from. */
export const IDENTITY_KEY_PURPOSE = 'chumbaq/identity-verification/v1';

export const USER_HASH_REQUIRED =
  'externalUserId needs a userHash: HMAC-SHA256 of the id under the project identity secret, made on your server.';

/** HMAC-SHA256 of an external user id under the project's identity secret, as hex. */
export function userHashFor(secret: string, externalUserId: string): string {
  return createHmac('sha256', secret).update(externalUserId, 'utf8').digest('hex');
}

/**
 * Verified identity. The SDK key ships inside every app, so an external user id it
 * reports proves nothing: anyone could claim another person's id and so join their
 * audiences, receive their messages, and block their erasure. So an external id is
 * accepted only with a `userHash` the tenant's own server makes with the project's
 * identity secret, which never ships in an app. The secret is derived from the server
 * key, the project and a version (`projects.identity_key_version`), so nothing secret
 * is stored, and rotating it is a version bump.
 */
@Injectable()
export class IdentityVerificationService {
  private readonly baseKey: Buffer;

  constructor(
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
    crypto: CredentialsCryptoService,
    private readonly activity: ProjectActivityService,
  ) {
    this.baseKey = crypto.deriveKey(IDENTITY_KEY_PURPOSE);
  }

  secretFor(projectId: string, version: number): string {
    return createHmac('sha256', this.baseKey).update(`${projectId}\n${version}`).digest('hex');
  }

  async currentSecret(projectId: string): Promise<{ secret: string; version: number }> {
    const project = await this.projects.findOne({ where: { id: projectId }, select: ['id', 'identityKeyVersion'] });
    if (!project) throw new NotFoundException('Project not found');
    return { secret: this.secretFor(projectId, project.identityKeyVersion), version: project.identityKeyVersion };
  }

  /** A new secret: every userHash made with the old one stops working at once. Logged. */
  async rotate(projectId: string, actorId: string, ctx: ActivityContext): Promise<{ secret: string; version: number }> {
    return this.projects.manager.transaction(async (manager) => {
      const [row] = await manager.query(
        `UPDATE projects SET identity_key_version = identity_key_version + 1 WHERE id = $1
         RETURNING identity_key_version AS version, name`,
        [projectId],
      ).then((result: unknown) => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<{ version: number; name: string }>);
      if (!row) throw new NotFoundException('Project not found');
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'identity.secret_rotated',
          target: { type: 'project', id: projectId, label: row.name },
        },
        ctx,
        manager,
      );
      return { secret: this.secretFor(projectId, row.version), version: row.version };
    });
  }

  /** Refuses (401) an external id that does not come with a valid userHash. */
  async assertVerified(projectId: string, externalUserId: string, userHash: string | undefined): Promise<void> {
    const { secret } = await this.currentSecret(projectId);
    const expected = Buffer.from(userHashFor(secret, externalUserId), 'utf8');
    const given = Buffer.from(String(userHash ?? '').toLowerCase(), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException(USER_HASH_REQUIRED);
    }
  }
}
