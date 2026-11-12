import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import {
  QUEUE_SEGMENT_MATERIALIZE,
  JOB_MATERIALIZE_SEGMENT,
  SEGMENT_MATERIALIZE_LOCK_MS,
  SEGMENT_REFRESH_GRACE_SECONDS,
  SegmentMaterializeJobData,
} from '../queue.constants';

@Injectable()
export class SegmentRefreshScheduler {
  private readonly logger = new Logger(SegmentRefreshScheduler.name);

  constructor(
    @InjectRepository(SegmentEntity)
    private readonly segmentRepository: Repository<SegmentEntity>,
    @InjectQueue(QUEUE_SEGMENT_MATERIALIZE)
    private readonly queue: Queue<SegmentMaterializeJobData>,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleRefresh(): Promise<void> {
    const count = await this.enqueueDueSegments();
    if (count > 0) this.logger.log(`Enqueued ${count} segment materialisation job(s)`);
  }

  /** Split out from the cron so it can be tested and triggered manually. */
  async enqueueDueSegments(): Promise<number> {
    const lockCutoff = new Date(Date.now() - SEGMENT_MATERIALIZE_LOCK_MS);

    const due = await this.segmentRepository
      .createQueryBuilder('s')
      .where('s.evaluation_mode = :mode', { mode: 'materialized' })
      // 'error' belongs here alongside 'active'. The processor marks a failed
      // run 'error' — useful operator signal — but selecting 'active' alone
      // meant that once BullMQ's attempts were exhausted the segment was never
      // scheduled again: one transient statement timeout retired the audience
      // permanently while enumerate() went on serving the last-good
      // segment_members. The staleness predicate below still governs cadence,
      // so an errored segment simply retries at its own
      // refresh_interval_minutes rather than hammering.
      .andWhere('s.status IN (:...statuses)', { statuses: ['active', 'error'] })
      // The grace is what makes an interval equal to the cron period actually
      // mean that interval; see SEGMENT_REFRESH_GRACE_SECONDS.
      .andWhere(
        `(s.last_materialized_at IS NULL
          OR s.last_materialized_at < NOW()
             - (s.refresh_interval_minutes * INTERVAL '1 minute')
             + (:graceSeconds * INTERVAL '1 second'))`,
        { graceSeconds: SEGMENT_REFRESH_GRACE_SECONDS },
      )
      // A run already in flight is not due again. Without this the predicate
      // above stays true for the whole run and the queue grows without bound.
      .andWhere('(s.materializing_at IS NULL OR s.materializing_at < :lockCutoff)', {
        lockCutoff,
      })
      .select(['s.id', 's.projectId'])
      .getMany();

    for (const segment of due) {
      // Claim the run here, not in the processor. Claiming on pick-up left a
      // window the whole length of the queue wait: neither materializing_at
      // nor last_materialized_at was set while the job sat queued, so the next
      // tick saw the same segment as due and enqueued it again. That is the
      // normal case whenever several segments come due at once, not a tail
      // one. The processor refreshes this timestamp when it starts, which
      // extends the lock across a long run.
      await this.segmentRepository.update(segment.id, { materializingAt: new Date() });

      // Deliberately no jobId. A deterministic one survives inside
      // removeOnComplete and permanently drops every later enqueue.
      await this.queue.add(JOB_MATERIALIZE_SEGMENT, {
        segmentId: segment.id,
        projectId: segment.projectId,
      });
    }

    return due.length;
  }
}
