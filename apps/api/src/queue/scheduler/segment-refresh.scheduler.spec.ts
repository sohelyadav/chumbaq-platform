import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SegmentRefreshScheduler } from './segment-refresh.scheduler';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { QUEUE_SEGMENT_MATERIALIZE } from '../queue.constants';

describe('SegmentRefreshScheduler', () => {
  let scheduler: SegmentRefreshScheduler;

  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };
  const segmentRepo = { createQueryBuilder: jest.fn(() => qb), update: jest.fn() };
  const queue = { add: jest.fn() };

  /** Records the interleaving of claim writes and enqueues, in order. */
  const order: string[] = [];

  beforeEach(async () => {
    jest.clearAllMocks();
    order.length = 0;
    segmentRepo.update.mockImplementation(async (id: string) => order.push(`claim:${id}`));
    queue.add.mockImplementation(async (_name: string, data: { segmentId: string }) =>
      order.push(`add:${data.segmentId}`),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SegmentRefreshScheduler,
        { provide: getRepositoryToken(SegmentEntity), useValue: segmentRepo },
        { provide: getQueueToken(QUEUE_SEGMENT_MATERIALIZE), useValue: queue },
      ],
    }).compile();
    scheduler = module.get(SegmentRefreshScheduler);
  });

  it('enqueues one job per due segment WITHOUT a deterministic jobId', async () => {
    qb.getMany.mockResolvedValueOnce([
      { id: 'seg-1', projectId: 'proj-1' },
      { id: 'seg-2', projectId: 'proj-1' },
    ]);

    await expect(scheduler.enqueueDueSegments()).resolves.toBe(2);

    expect(queue.add).toHaveBeenCalledTimes(2);
    // Phase 0 Critical: a deterministic jobId survives inside removeOnComplete
    // and silently drops every later enqueue, permanently.
    expect(queue.add).toHaveBeenCalledWith(
      'materialize-segment',
      { segmentId: 'seg-1', projectId: 'proj-1' },
    );
    for (const call of queue.add.mock.calls) {
      expect(call[2]?.jobId).toBeUndefined();
    }
  });

  it('two consecutive runs both enqueue', async () => {
    qb.getMany.mockResolvedValue([{ id: 'seg-1', projectId: 'proj-1' }]);
    await scheduler.enqueueDueSegments();
    await scheduler.enqueueDueSegments();
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('selects materialized segments past their interval', async () => {
    qb.getMany.mockResolvedValueOnce([]);
    await scheduler.enqueueDueSegments();

    const predicates = qb.andWhere.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(qb.where).toHaveBeenCalledWith(
      's.evaluation_mode = :mode', { mode: 'materialized' },
    );
    expect(predicates).toContain('status');
    expect(predicates).toContain('last_materialized_at');
    // Excludes a run already in flight — otherwise a slow segment is
    // re-enqueued every tick and the queue grows without bound.
    expect(predicates).toContain('materializing_at');
  });

  it('keeps scheduling a segment whose last run errored', async () => {
    qb.getMany.mockResolvedValueOnce([]);
    await scheduler.enqueueDueSegments();

    // The processor marks a failed run 'error'. Selecting 'active' alone
    // retired that audience permanently once BullMQ's attempts ran out: a
    // transient statement timeout, and the segment is never refreshed again
    // while enumerate() keeps serving the last-good membership.
    const statusCall = qb.andWhere.mock.calls.find((c) =>
      String(c[0]).includes('status'),
    );
    expect(statusCall?.[1]).toEqual({ statuses: ['active', 'error'] });
  });

  it('enqueues an errored, stale segment', async () => {
    qb.getMany.mockResolvedValueOnce([{ id: 'seg-err', projectId: 'proj-1' }]);

    await expect(scheduler.enqueueDueSegments()).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledWith(
      'materialize-segment',
      { segmentId: 'seg-err', projectId: 'proj-1' },
    );
  });

  it('claims the run before the job is added, not after it is picked up', async () => {
    qb.getMany.mockResolvedValueOnce([
      { id: 'seg-1', projectId: 'proj-1' },
      { id: 'seg-2', projectId: 'proj-1' },
    ]);

    await scheduler.enqueueDueSegments();

    // Claiming inside process() left materializing_at and last_materialized_at
    // both unset for the whole queue wait, so the next tick re-enqueued a job
    // that had not started yet — routine whenever several segments come due
    // together.
    expect(order).toEqual(['claim:seg-1', 'add:seg-1', 'claim:seg-2', 'add:seg-2']);
    expect(segmentRepo.update).toHaveBeenNthCalledWith(1, 'seg-1', {
      materializingAt: expect.any(Date),
    });
  });

  it('enqueues nothing when none are due', async () => {
    qb.getMany.mockResolvedValueOnce([]);
    await expect(scheduler.enqueueDueSegments()).resolves.toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
