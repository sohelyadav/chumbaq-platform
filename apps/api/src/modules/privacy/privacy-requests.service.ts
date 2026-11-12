import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type {
  PrivacyRequestKind,
  PrivacyRequestLog,
  PrivacySubject,
} from '@chumbaq/shared';
import { PrivacyRequestLogEntity } from './entities/privacy-request-log.entity';
import { PrivacyHashService } from './privacy-hash.service';
import type { PrivacyActor } from './privacy-actor';
import type { PersonKeys } from './person-scope';

export const PRIVACY_LOG_PAGE_LIMIT = 100;

/**
 * The privacy request log: the only writer of `privacy_request_logs`.
 * Stores keyed hashes of identifiers, never the identifiers.
 */
@Injectable()
export class PrivacyRequestsService {
  constructor(
    @InjectRepository(PrivacyRequestLogEntity)
    private readonly repository: Repository<PrivacyRequestLogEntity>,
    private readonly hashes: PrivacyHashService,
  ) {}

  /** Pass the erasure's `manager` so the record commits with the erasure or not at all. */
  async record(
    manager: EntityManager | null,
    entry: {
      projectId: string;
      kind: PrivacyRequestKind;
      subject: PrivacySubject;
      keys: PersonKeys;
      actor: PrivacyActor;
      result: string;
      counts: Record<string, number>;
    },
  ): Promise<string> {
    const { projectId } = entry;
    const hashes = new Set<string>([
      this.hashes.subjectHash(projectId, entry.subject.type, entry.subject.value),
      ...entry.keys.externalUserIds.map((id) => this.hashes.subjectHash(projectId, 'externalUserId', id)),
    ]);
    const repository = manager ? manager.getRepository(PrivacyRequestLogEntity) : this.repository;
    const saved = await repository.save(
      repository.create({
        projectId,
        kind: entry.kind,
        subjectType: entry.subject.type,
        identifierHashes: [...hashes],
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        result: entry.result,
        counts: entry.counts,
      }),
    );
    return saved.id;
  }

  /**
   * Newest first. With `externalUserId`, only requests that named that user
   * (directly, or as the user behind a person or device that was named).
   */
  async list(
    projectId: string,
    options: { externalUserId?: string; limit?: number } = {},
  ): Promise<PrivacyRequestLog[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), PRIVACY_LOG_PAGE_LIMIT);
    const qb = this.repository
      .createQueryBuilder('log')
      .where('log.project_id = :projectId', { projectId })
      .orderBy('log.created_at', 'DESC')
      .limit(limit);
    if (options.externalUserId) {
      qb.andWhere(':hash = ANY(log.identifier_hashes)', {
        hash: this.hashes.subjectHash(projectId, 'externalUserId', options.externalUserId),
      });
    }
    const rows = await qb.getMany();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      actorType: row.actorType,
      actorId: row.actorId,
      result: row.result,
      counts: row.counts ?? {},
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
