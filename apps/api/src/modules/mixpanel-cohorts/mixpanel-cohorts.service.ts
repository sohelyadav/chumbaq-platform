import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as crypto from 'crypto';
import { MixpanelConfigEntity } from './entities/mixpanel-config.entity';
import { MixpanelCohortEntity } from './entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from './entities/mixpanel-cohort-member.entity';
import { MixpanelApiService, MixpanelCohortInfo } from './mixpanel-api.service';
import { ConfigureMixpanelDto } from './dto/configure-mixpanel.dto';
import { PushTokenEntity } from '../push-tokens/entities/push-token.entity';
import type { ActivityContext } from '../project-activity/activity-context';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.MIXPANEL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('Missing required environment variable: MIXPANEL_ENCRYPTION_KEY');
  }
  if (raw.length < 32) {
    throw new Error('MIXPANEL_ENCRYPTION_KEY must be at least 32 bytes');
  }
  cachedKey = Buffer.from(raw, 'utf8').slice(0, 32);
  return cachedKey;
}

function encrypt(text: string): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

function decrypt(encrypted: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

@Injectable()
export class MixpanelCohortsService {
  private readonly logger = new Logger(MixpanelCohortsService.name);

  constructor(
    @InjectRepository(MixpanelConfigEntity)
    private readonly configRepo: Repository<MixpanelConfigEntity>,
    @InjectRepository(MixpanelCohortEntity)
    private readonly cohortRepo: Repository<MixpanelCohortEntity>,
    @InjectRepository(MixpanelCohortMemberEntity)
    private readonly memberRepo: Repository<MixpanelCohortMemberEntity>,
    private readonly mixpanelApiService: MixpanelApiService,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * Stores the service account and logs `mixpanel.configured` in the same transaction,
   * with no details: neither the username nor the password reaches the log. Saving the
   * account already stored (password compared decrypted) on an active integration
   * changes nothing, and writes and logs nothing.
   */
  async configure(
    projectId: string,
    dto: ConfigureMixpanelDto,
    actorId: string,
    ctx: ActivityContext,
  ): Promise<{ id: string; projectId: string; isActive: boolean }> {
    const config = await this.configRepo.manager.transaction(async (manager) => {
      const configs = manager.getRepository(MixpanelConfigEntity);
      let row = await configs.findOne({ where: { projectId }, lock: { mode: 'pessimistic_write' } });
      if (row && this.holds(row, dto)) return row;

      const { encrypted, iv, tag } = encrypt(dto.serviceAccountPassword);
      if (row) {
        row.serviceAccountUsername = dto.serviceAccountUsername;
        row.serviceAccountPasswordEncrypted = encrypted;
        row.encryptionIv = iv;
        row.encryptionTag = tag;
        row.mixpanelProjectId = dto.mixpanelProjectId;
        row.isActive = true;
        row = await configs.save(row);
      } else {
        row = await configs.save(
          configs.create({
            projectId,
            serviceAccountUsername: dto.serviceAccountUsername,
            serviceAccountPasswordEncrypted: encrypted,
            encryptionIv: iv,
            encryptionTag: tag,
            mixpanelProjectId: dto.mixpanelProjectId,
            isActive: true,
          }),
        );
      }
      await this.activity.record(
        {
          projectId,
          actor: { kind: 'user', userId: actorId },
          action: 'mixpanel.configured',
          target: { type: 'integration', id: 'mixpanel', label: 'Mixpanel' },
        },
        ctx,
        manager,
      );
      return row;
    });

    return { id: config.id, projectId: config.projectId, isActive: config.isActive };
  }

  /** Whether an active row already holds this account. One that will not decrypt does not. */
  private holds(row: MixpanelConfigEntity, dto: ConfigureMixpanelDto): boolean {
    if (!row.isActive) return false;
    if (row.serviceAccountUsername !== dto.serviceAccountUsername) return false;
    if (row.mixpanelProjectId !== dto.mixpanelProjectId) return false;
    try {
      return (
        decrypt(row.serviceAccountPasswordEncrypted, row.encryptionIv, row.encryptionTag) ===
        dto.serviceAccountPassword
      );
    } catch {
      return false;
    }
  }

  async testConnection(projectId: string): Promise<{ connected: boolean; error?: string }> {
    const creds = await this.getDecryptedConfig(projectId);
    if (!creds) {
      return { connected: false, error: 'Mixpanel not configured for this project' };
    }

    try {
      const connected = await this.mixpanelApiService.testConnection(
        creds.username,
        creds.password,
        creds.mixpanelProjectId,
      );

      // Update lastTestAt
      await this.configRepo.update({ projectId }, { lastTestAt: new Date() });

      if (!connected) {
        return { connected: false, error: 'Connection test failed — check credentials' };
      }
      return { connected: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`testConnection error for project ${projectId}: ${errMsg}`);
      return { connected: false, error: errMsg };
    }
  }

  async getStatus(
    projectId: string,
  ): Promise<{ configured: boolean; isActive: boolean; lastTestAt: Date | null; mixpanelProjectId: string | null; serviceAccountUsername: string | null }> {
    const config = await this.configRepo.findOne({ where: { projectId } });
    if (!config) {
      return { configured: false, isActive: false, lastTestAt: null, mixpanelProjectId: null, serviceAccountUsername: null };
    }
    return {
      configured: true,
      isActive: config.isActive,
      lastTestAt: config.lastTestAt,
      mixpanelProjectId: config.mixpanelProjectId,
      serviceAccountUsername: config.serviceAccountUsername,
    };
  }

  async getDecryptedConfig(
    projectId: string,
  ): Promise<{ username: string; password: string; mixpanelProjectId: string } | null> {
    const config = await this.configRepo.findOne({ where: { projectId } });
    if (!config) {
      return null;
    }

    const password = decrypt(
      config.serviceAccountPasswordEncrypted,
      config.encryptionIv,
      config.encryptionTag,
    );

    return {
      username: config.serviceAccountUsername,
      password,
      mixpanelProjectId: config.mixpanelProjectId,
    };
  }

  async listAvailableCohorts(projectId: string): Promise<MixpanelCohortInfo[]> {
    const creds = await this.getDecryptedConfig(projectId);
    if (!creds) {
      throw new BadRequestException('Mixpanel is not configured for this project');
    }
    return this.mixpanelApiService.listCohorts(creds);
  }

  async listImportedCohorts(projectId: string): Promise<MixpanelCohortEntity[]> {
    return this.cohortRepo.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async findImportedCohort(projectId: string, cohortId: string): Promise<MixpanelCohortEntity> {
    const cohort = await this.cohortRepo.findOne({ where: { id: cohortId, projectId } });
    if (!cohort) {
      throw new NotFoundException('Cohort not found');
    }
    return cohort;
  }

  async deleteImportedCohort(projectId: string, cohortId: string, requester: ActivityRequester): Promise<void> {
    const cohort = await this.findImportedCohort(projectId, cohortId);
    const entry = contentDeleted(projectId, 'cohort', { id: cohort.id, name: cohort.name });
    // Members will cascade-delete via the FK onDelete: 'CASCADE'
    await this.cohortRepo.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(MixpanelCohortEntity).delete({ id: cohortId, projectId });
      if (!result.affected) throw new NotFoundException('Cohort not found');
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  async listCohortMembers(
    projectId: string,
    cohortId: string,
    opts: { page?: number; limit?: number; resolved?: boolean },
  ): Promise<{
    data: MixpanelCohortMemberEntity[];
    total: number;
    resolved: number;
    unresolved: number;
  }> {
    // Verify cohort exists and belongs to project
    await this.findImportedCohort(projectId, cohortId);

    const page = opts.page ?? 1;
    const limit = Math.min(opts.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where: Record<string, any> = { cohortId, projectId };
    if (opts.resolved !== undefined) {
      where.isResolved = opts.resolved;
    }

    const [data, total] = await this.memberRepo.findAndCount({
      where,
      order: { addedAt: 'DESC' },
      skip,
      take: limit,
    });

    const [resolvedCount, unresolvedCount] = await Promise.all([
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: true } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: false } }),
    ]);

    return { data, total, resolved: resolvedCount, unresolved: unresolvedCount };
  }

  async getCohortPushEligible(
    projectId: string,
    cohortId: string,
    pushTokenRepo: Repository<PushTokenEntity>,
  ): Promise<{
    total: number;
    resolved: number;
    pushEnabled: number;
    unresolved: number;
  }> {
    await this.findImportedCohort(projectId, cohortId);

    const [total, resolved, unresolved] = await Promise.all([
      this.memberRepo.count({ where: { cohortId, projectId } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: true } }),
      this.memberRepo.count({ where: { cohortId, projectId, isResolved: false } }),
    ]);

    // Get resolved member device identity IDs
    const resolvedMembers = await this.memberRepo.find({
      where: { cohortId, projectId, isResolved: true },
      select: ['deviceIdentityId'],
    });

    const deviceIdentityIds = resolvedMembers
      .map((m) => m.deviceIdentityId)
      .filter((id): id is string => id !== null);

    let pushEnabled = 0;
    if (deviceIdentityIds.length > 0) {
      pushEnabled = await pushTokenRepo.count({
        where: {
          projectId,
          deviceIdentityId: In(deviceIdentityIds),
          isActive: true,
        },
      });
      // Cap at number of unique identities with at least one active token
      // The count above may count multiple tokens per identity; get unique identity count instead
      const uniqueWithTokens = await pushTokenRepo
        .createQueryBuilder('pt')
        .select('DISTINCT pt.deviceIdentityId')
        .where('pt.projectId = :projectId', { projectId })
        .andWhere('pt.deviceIdentityId IN (:...ids)', { ids: deviceIdentityIds })
        .andWhere('pt.isActive = true')
        .getCount();
      pushEnabled = uniqueWithTokens;
    }

    return { total, resolved, pushEnabled, unresolved };
  }
}
