import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThan } from 'typeorm';
import { SegmentCompilerService } from './segment-compiler.service';
import { SegmentEntity } from './entities/segment.entity';
import { SegmentMemberEntity } from './entities/segment-member.entity';
import { SegmentNode } from './segment-ast';

/** A send-time walk may legitimately take a while; a preview may not. */
export const SEGMENT_QUERY_TIMEOUT_MS = 30000;
export const SEGMENT_PREVIEW_TIMEOUT_MS = 5000;

/**
 * Segment sends resolve person keys to device ids at enqueue time and store
 * them on the log row, so the campaign processor stays untouched. That bounds
 * the audience: beyond this the jsonb array is unreasonable and the request is
 * rejected rather than silently truncated.
 */
export const SEGMENT_SEND_MAX_PEOPLE = 25000;

const DEVICE_KEY_PREFIX = 'device:';

/**
 * A materialised segment reads its membership from segment_members, and that
 * table is only meaningful once a run has written it. Until then — a segment
 * created materialised, one just flipped from live, or one whose definition was
 * edited (which drops the rows and clears the timestamp) — there is no
 * membership to read.
 *
 * The tempting behaviour is to return an empty set. That is worse than an
 * error: a campaign would report success having reached nobody, and nothing in
 * the send path could tell that apart from a genuinely empty audience. So the
 * caller is told, by name, and fails loudly. Callers for whom withholding is
 * the right answer already catch — MessageDeliveryService withholds the
 * message rather than delivering it.
 */
function assertMaterialized(segment: SegmentEntity): void {
  if (segment.lastMaterializedAt === null || segment.lastMaterializedAt === undefined) {
    throw new BadRequestException(
      `Segment ${segment.id} ("${segment.name}") has not been materialized yet, ` +
        `so it has no membership to read. Wait for the next refresh run, or ` +
        `switch it to live evaluation.`,
    );
  }
}

@Injectable()
export class SegmentEvaluationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly compiler: SegmentCompilerService,
    @InjectRepository(SegmentMemberEntity)
    private readonly memberRepository: Repository<SegmentMemberEntity>,
  ) {}

  /**
   * Runs a segment query with a statement timeout.
   *
   * The timeout is the guardrail against an author writing an arbitrarily
   * expensive segment. SET LOCAL only applies inside a transaction, hence the
   * explicit runner. timeoutMs is coerced with Number() before interpolation
   * because SET LOCAL does not accept a bound parameter.
   */
  private async runScoped<T>(
    sql: string,
    params: unknown[],
    timeoutMs: number,
  ): Promise<T[]> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
      const rows = await runner.query(sql, params);
      await runner.commitTransaction();
      return rows as T[];
    } catch (error) {
      try {
        await runner.rollbackTransaction();
      } catch {
        // The original error is what the caller needs; a failed rollback
        // (e.g. the connection is already gone) must not mask it.
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  /** One page of person keys, ordered so the last key is the next cursor. */
  async enumerate(
    segment: SegmentEntity,
    afterKey: string | null,
    limit: number,
  ): Promise<string[]> {
    if (segment.evaluationMode === 'materialized') {
      assertMaterialized(segment);
      const rows = await this.memberRepository.find({
        where: {
          segmentId: segment.id,
          ...(afterKey ? { personKey: MoreThan(afterKey) } : {}),
        },
        order: { personKey: 'ASC' },
        take: limit,
      });
      return rows.map((r) => r.personKey);
    }

    const core = this.compiler.compile(segment.definition, segment.projectId);
    const params = [...core.params];

    let cursorClause = '';
    if (afterKey) {
      params.push(afterKey);
      cursorClause = ` WHERE person_key > $${params.length}`;
    }
    params.push(limit);

    const sql = `SELECT person_key FROM (${core.sql}) s${cursorClause}
ORDER BY person_key ASC LIMIT $${params.length}`;

    const rows = await this.runScoped<{ person_key: string }>(
      sql,
      params,
      SEGMENT_QUERY_TIMEOUT_MS,
    );
    return rows.map((r) => r.person_key);
  }

  async isMember(segment: SegmentEntity, personKey: string): Promise<boolean> {
    if (segment.evaluationMode === 'materialized') {
      assertMaterialized(segment);
      const row = await this.memberRepository.findOne({
        where: { segmentId: segment.id, personKey },
      });
      return row !== null && row !== undefined;
    }

    const core = this.compiler.compile(segment.definition, segment.projectId);
    const params = [...core.params, personKey];
    const sql = `SELECT person_key FROM (${core.sql}) s
WHERE person_key = $${params.length} LIMIT 1`;

    const rows = await this.runScoped(sql, params, SEGMENT_QUERY_TIMEOUT_MS);
    return rows.length > 0;
  }

  /** Used by preview, so it runs under the tighter timeout. */
  async countFor(ast: SegmentNode, projectId: string): Promise<number> {
    const core = this.compiler.compile(ast, projectId);
    const sql = `SELECT count(*)::int AS count FROM (${core.sql}) s`;
    const rows = await this.runScoped<{ count: number | string }>(
      sql,
      core.params,
      SEGMENT_PREVIEW_TIMEOUT_MS,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Fans person keys back out to every device those people own. */
  async resolveDeviceIdentityIds(
    projectId: string,
    personKeys: string[],
  ): Promise<string[]> {
    if (personKeys.length === 0) return [];

    const externalIds = personKeys.filter((k) => !k.startsWith(DEVICE_KEY_PREFIX));
    const deviceIds = personKeys
      .filter((k) => k.startsWith(DEVICE_KEY_PREFIX))
      .map((k) => k.slice(DEVICE_KEY_PREFIX.length));

    const sql = `SELECT id FROM device_identities
WHERE project_id = $1
  AND (external_user_id = ANY($2::text[]) OR id::text = ANY($3::text[]))`;

    const rows = await this.runScoped<{ id: string }>(
      sql,
      [projectId, externalIds, deviceIds],
      SEGMENT_QUERY_TIMEOUT_MS,
    );
    return rows.map((r) => r.id);
  }
}
