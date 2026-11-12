import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { SegmentMemberEntity } from '../../modules/segments/entities/segment-member.entity';
import { SegmentEvaluationService } from '../../modules/segments/segment-evaluation.service';
import {
  QUEUE_SEGMENT_MATERIALIZE,
  SEGMENT_MEMBER_BATCH_SIZE,
  SegmentMaterializeJobData,
} from '../queue.constants';

/**
 * Recomputes a materialised segment's membership.
 *
 * The job completes only once every member row is written. Phase 0's cohort
 * processor returned as soon as a row was upserted, which defeated retries,
 * the concurrency cap, and the dedup window simultaneously — the single most
 * valuable fix of that phase.
 */
@Processor(QUEUE_SEGMENT_MATERIALIZE, { concurrency: 1 })
export class SegmentMaterializeProcessor extends WorkerHost {
  private readonly logger = new Logger(SegmentMaterializeProcessor.name);

  constructor(
    @InjectRepository(SegmentEntity)
    private readonly segmentRepository: Repository<SegmentEntity>,
    private readonly evaluation: SegmentEvaluationService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<SegmentMaterializeJobData>): Promise<void> {
    const { segmentId } = job.data;

    const segment = await this.segmentRepository.findOne({ where: { id: segmentId } });
    if (!segment) {
      throw new UnrecoverableError(`Segment ${segmentId} no longer exists`);
    }

    // Refresh, not claim: the scheduler already stamped materializing_at at
    // enqueue time, which is what closes the queue-wait window. Re-stamping
    // here restarts the SEGMENT_MATERIALIZE_LOCK_MS window from the moment
    // work actually begins, so a run longer than the lock is not re-enqueued
    // underneath itself.
    await this.segmentRepository.update(segment.id, { materializingAt: new Date() });

    try {
      const personKeys = await this.collectAll(segment);
      await this.replaceMembers(segment, personKeys);

      await this.segmentRepository.update(segment.id, {
        lastMaterializedAt: new Date(),
        lastMemberCount: personKeys.length,
        materializingAt: null,
        status: 'active',
        errorMessage: null,
      });

      this.logger.log(`Segment ${segment.id} materialised: ${personKeys.length} members`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.segmentRepository.update(segment.id, {
        status: 'error',
        errorMessage: message.slice(0, 2000),
        materializingAt: null,
      });
      // Rethrow so BullMQ records the failure and retries.
      throw error;
    }
  }

  /** Walks every page. enumerate() reads the compiled SQL for a materialised
   *  segment's own definition, so this is the live query, not the stale table. */
  private async collectAll(segment: SegmentEntity): Promise<string[]> {
    const liveView = { ...segment, evaluationMode: 'live' as const };
    const all: string[] = [];
    let cursor: string | null = null;

    for (;;) {
      const page = await this.evaluation.enumerate(
        liveView as SegmentEntity,
        cursor,
        SEGMENT_MEMBER_BATCH_SIZE,
      );
      if (page.length === 0) break;
      all.push(...page);
      cursor = page[page.length - 1];
      if (page.length < SEGMENT_MEMBER_BATCH_SIZE) break;
    }

    return all;
  }

  /**
   * Brings stored membership in line with what the segment now matches.
   *
   * A difference rather than a delete-and-reinsert, because `entered_at` has
   * to survive a refresh to mean anything: recreating every row would stamp
   * the whole segment as having just joined, every hour, and a journey
   * triggered by "entered this segment" would either fire for everybody or
   * never fire twice for anybody.
   *
   * Leavers are found by timestamp instead of by comparing lists. Every person
   * still matching is touched with this run's `materialized_at`, so anything
   * left carrying an older one has dropped out — which keeps the delete a
   * single bounded statement rather than a `NOT IN` over a segment that can
   * hold hundreds of thousands of people.
   *
   * One transaction, so a reader sees the old generation or the new one.
   */
  private async replaceMembers(segment: SegmentEntity, personKeys: string[]): Promise<void> {
    const runAt = new Date();

    await this.dataSource.transaction(async (manager: EntityManager) => {
      for (let i = 0; i < personKeys.length; i += SEGMENT_MEMBER_BATCH_SIZE) {
        const chunk = personKeys.slice(i, i + SEGMENT_MEMBER_BATCH_SIZE);

        await manager
          .createQueryBuilder()
          .insert()
          .into(SegmentMemberEntity)
          .values(
            chunk.map((personKey) => ({
              segmentId: segment.id,
              projectId: segment.projectId,
              personKey,
              materializedAt: runAt,
              enteredAt: runAt,
            })),
          )
          // Only `materialized_at` is overwritten. `entered_at` is left as the
          // moment they first joined — updating it here is the one mistake
          // that would quietly undo the whole point of this.
          .orUpdate(['materialized_at'], ['segment_id', 'person_key'])
          .execute();
      }

      await manager.query(
        'DELETE FROM segment_members WHERE segment_id = $1 AND materialized_at < $2',
        [segment.id, runAt],
      );
    });
  }
}
