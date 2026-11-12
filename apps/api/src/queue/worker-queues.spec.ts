import 'reflect-metadata';
import { WORKER_QUEUES } from './queue.constants';
import { PushCampaignProcessor } from './processors/push-campaign.processor';
import { CohortSyncProcessor } from './processors/cohort-sync.processor';
import { SegmentMaterializeProcessor } from './processors/segment-materialize.processor';

/**
 * Keeps the worker's startup log honest.
 *
 * It drifted once already: `segment-materialize` was consumed for months while
 * the log named only the other two, which is the kind of wrongness that costs
 * somebody an afternoon — a worker that says it is not consuming a queue is a
 * convincing place to stop looking.
 */
describe('WORKER_QUEUES', () => {
  /**
   * The queue each processor is actually bound to.
   *
   * Read from the decorator's own metadata rather than from a second list, so
   * this compares the log against what Nest will really consume.
   */
  const queueOf = (target: unknown): string | undefined =>
    (
      Reflect.getMetadata('bullmq:processor_metadata', target as object) as
        | { name?: string }
        | undefined
    )?.name;

  const processors = [
    PushCampaignProcessor,
    CohortSyncProcessor,
    SegmentMaterializeProcessor,
  ];

  it('names every queue a processor consumes', () => {
    const consumed = processors.map(queueOf).filter(Boolean).sort();

    expect([...WORKER_QUEUES].sort()).toEqual(consumed);
  });

  it('claims no queue nothing consumes', () => {
    // The other direction matters too: a queue listed here but unprocessed
    // would have jobs pile up while the log insisted they were being handled.
    const consumed = new Set(processors.map(queueOf));

    for (const queue of WORKER_QUEUES) {
      expect(consumed.has(queue)).toBe(true);
    }
  });
});
