import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { ApiKeyEntity } from './entities/api-key.entity';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { permissionsForNewKey } from './api-key-permissions';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepository: Repository<ApiKeyEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * `api_key.created` is written in the insert's transaction, so a failed log write
   * makes no key. It names the key and its permissions; the key itself, its hash and
   * its prefix never reach the log.
   */
  async create(
    projectId: string,
    dto: CreateApiKeyDto,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<{ apiKey: ApiKeyEntity; fullKey: string }> {
    // Before anything is generated, so a refused set leaves nothing behind.
    const permissions = permissionsForNewKey(dto.permissions);
    const rawKey = `chumbaq_${crypto.randomBytes(32).toString('hex')}`;
    const prefix = rawKey.substring(0, 12);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const apiKey = this.apiKeyRepository.create({
      projectId,
      name: dto.name,
      keyHash,
      prefix,
      permissions,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    } as Partial<ApiKeyEntity>);

    const saved = await this.apiKeyRepository.manager.transaction(async (manager) => {
      const row = await manager.getRepository(ApiKeyEntity).save(apiKey as ApiKeyEntity);
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'api_key.created',
          target: { type: 'api_key', id: row.id, label: row.name },
          details: { name: row.name, permissions: row.permissions },
        },
        ctx,
        manager,
      );
      return row;
    });
    return { apiKey: saved, fullKey: rawKey };
  }

  async findAllByProject(projectId: string): Promise<ApiKeyEntity[]> {
    return this.apiKeyRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * `api_key.revoked` is written in the revoke's transaction. Revoking a key that is
   * already revoked changes nothing, so it succeeds as before and logs nothing.
   */
  async revoke(id: string, projectId: string, actorId: string, ctx: ActivityContext): Promise<void> {
    await this.apiKeyRepository.manager.transaction(async (manager) => {
      const keys = manager.getRepository(ApiKeyEntity);
      // One UPDATE of is_active only, not a load-then-save of the whole row. Only an
      // active key matches, so the entry is written once however many revokes race.
      const result = await keys.update({ id, projectId, isActive: true }, { isActive: false });
      if (!result.affected) {
        if (!(await keys.exists({ where: { id, projectId } }))) {
          throw new NotFoundException('API key not found');
        }
        return;
      }
      const key = await keys.findOne({ where: { id, projectId }, select: { id: true, name: true } });
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'api_key.revoked',
          target: { type: 'api_key', id, label: key?.name ?? id },
        },
        ctx,
        manager,
      );
    });
  }

  async validateKey(rawKey: string): Promise<ApiKeyEntity | null> {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
      relations: ['project'],
    });

    if (!apiKey) return null;

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      return null;
    }

    // Only last_used_at, and only while the key is still active. A save() of
    // the row read above would write is_active back as it was then, so a
    // revoke committing in between would be undone and the key work again.
    // No row matched means it was revoked in that gap: refuse this call too.
    const lastUsedAt = new Date();
    const result = await this.apiKeyRepository.update(
      { id: apiKey.id, isActive: true },
      { lastUsedAt },
    );
    if (!result.affected) return null;
    apiKey.lastUsedAt = lastUsedAt;

    return apiKey;
  }
}
