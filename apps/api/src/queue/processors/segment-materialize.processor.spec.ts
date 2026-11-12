import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Job } from 'bullmq';
import { SegmentMaterializeProcessor } from './segment-materialize.processor';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { SegmentEvaluationService } from '../../modules/segments/segment-evaluation.service';
import { SegmentMaterializeJobData } from '../queue.constants';

describe('SegmentMaterializeProcessor', () => {
  let processor: SegmentMaterializeProcessor;

  const segmentRepo = { findOne: jest.fn(), update: jest.fn() };
  const evaluation = { enumerate: jest.fn() };
  /** Chainable stand-in for the insert builder the processor upserts through. */
  const makeInsertBuilder = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['insert', 'into', 'values', 'orUpdate']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.execute = jest.fn();
    return qb;
  };

  let insertBuilder: ReturnType<typeof makeInsertBuilder>;
  const manager = {
    query: jest.fn(),
    insert: jest.fn(),
    createQueryBuilder: jest.fn(() => insertBuilder),
  };

  beforeEach(() => {
    insertBuilder = makeInsertBuilder();
  });
  const dataSource = {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<void>) => cb(manager)),
  };

  const segment = {
    id: 'seg-1', projectId: 'proj-1', evaluationMode: 'materialized',
    definition: { type: 'attribute', field: 'country', op: 'eq', value: 'US' },
  };

  const job = { data: { segmentId: 'seg-1', projectId: 'proj-1' } } as Job<SegmentMaterializeJobData>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SegmentMaterializeProcessor,
        { provide: getRepositoryToken(SegmentEntity), useValue: segmentRepo },
        { provide: SegmentEvaluationService, useValue: evaluation },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    processor = module.get(SegmentMaterializeProcessor);
  });

  it('throws unrecoverably when the segment is gone', async () => {
    segmentRepo.findOne.mockResolvedValueOnce(null);
    await expect(processor.process(job)).rejects.toThrow(/no longer exists/);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('marks the run in flight before doing any work', async () => {
    segmentRepo.findOne.mockResolvedValueOnce(segment);
    evaluation.enumerate.mockResolvedValueOnce([]);

    await processor.process(job);

    expect(segmentRepo.update.mock.calls[0]).toEqual([
      'seg-1',
      expect.objectContaining({ materializingAt: expect.any(Date) }),
    ]);
  });

  it('pages every member and only then writes counts', async () => {
    segmentRepo.findOne.mockResolvedValueOnce(segment);
    // Two full pages then a short one — proves it does not stop at page 1.
    evaluation.enumerate
      .mockResolvedValueOnce(Array.from({ length: 1000 }, (_, i) => `u${i}`))
      .mockResolvedValueOnce(Array.from({ length: 1000 }, (_, i) => `v${i}`))
      .mockResolvedValueOnce(['w0']);

    await processor.process(job);

    expect(evaluation.enumerate).toHaveBeenCalledTimes(3);
    // Second call must resume after the last key of the first page.
    expect(evaluation.enumerate.mock.calls[1][1]).toBe('u999');

    const final = segmentRepo.update.mock.calls.at(-1);
    expect(final?.[1]).toEqual(
      expect.objectContaining({ lastMemberCount: 2001, materializingAt: null }),
    );
  });

  it('replaces membership inside one transaction', async () => {
    segmentRepo.findOne.mockResolvedValueOnce(segment);
    evaluation.enumerate.mockResolvedValueOnce(['u1']);

    await processor.process(job);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);

    // Upsert the people who still match, then delete whatever this run did not
    // touch — a difference, not a delete-and-recreate, so `entered_at` on a
    // continuing member survives the refresh.
    expect(insertBuilder.orUpdate).toHaveBeenCalledWith(
      ['materialized_at'],
      ['segment_id', 'person_key'],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM segment_members'),
      ['seg-1', expect.any(Date)],
    );
  });

  it('never overwrites when someone first entered the segment', async () => {
    segmentRepo.findOne.mockResolvedValueOnce(segment);
    evaluation.enumerate.mockResolvedValueOnce(['u1']);

    await processor.process(job);

    // Updating entered_at here is the one mistake that would quietly undo the
    // whole point: every refresh would restamp the segment as newly joined.
    const [updatedColumns] = insertBuilder.orUpdate.mock.calls[0];
    expect(updatedColumns).not.toContain('entered_at');
  });

  it('records the failure on the segment and rethrows', async () => {
    segmentRepo.findOne.mockResolvedValueOnce(segment);
    evaluation.enumerate.mockRejectedValueOnce(new Error('statement timeout'));

    await expect(processor.process(job)).rejects.toThrow(/statement timeout/);

    const final = segmentRepo.update.mock.calls.at(-1);
    expect(final?.[1]).toEqual(
      expect.objectContaining({
        status: 'error',
        errorMessage: expect.stringContaining('statement timeout'),
        materializingAt: null,
      }),
    );
  });
});
