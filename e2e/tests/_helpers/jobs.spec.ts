import { newClientIp } from '../../support/api';
import { expect, test } from '../../support/fixtures';
import { runJobNow, WORKER_JOBS, type WorkerJob } from '../../support/jobs';
import { campaignRow, pushProject, seedLogRow } from '../../support/areas/push';
import { addDevice, attribute, createSegment, group, insertEvent, segmentRow, segProject, sql, uniqueId } from '../../support/areas/seg';

/**
 * Proves `runJobNow` (support/jobs.ts): a worker cron's work done on demand, in a process
 * of its own, while the stack's worker keeps its own schedule.
 */
test.describe('worker jobs on demand', () => {
  test('usage-rollup counts a new project\'s events and people for today', async () => {
    const ip = newClientIp();
    const p = await segProject(ip, 'jobs-usage');
    const device = await addDevice(p, ip);
    await insertEvent(p.project.id, device, 'jobs_probe', null, 0);
    await insertEvent(p.project.id, device, 'jobs_probe', null, 0);

    await runJobNow('usage-rollup');

    const rows = await sql<{ metric: string; value: string }>(
      `SELECT metric, value FROM usage_daily
        WHERE project_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date AND metric IN ('events', 'new_people')
        ORDER BY metric`,
      [p.project.id],
    );
    expect(rows.map((row) => [row.metric, Number(row.value)])).toEqual([
      ['events', 2],
      ['new_people', 1],
    ]);
  });

  test('segment-refresh enqueues a due materialised segment, and the stack\'s worker materialises it', async () => {
    const ip = newClientIp();
    const p = await segProject(ip, 'jobs-segment');
    const tag = uniqueId('jobs');
    await addDevice(p, ip, { traits: { plan: tag } });
    await addDevice(p, ip, { traits: { plan: 'other' } });
    const segment = await createSegment(p.owner, p.project.id, ip, {
      name: uniqueId('jobs-segment'),
      definition: group([attribute('traits.plan', 'eq', tag)]),
      evaluationMode: 'materialized',
      status: 'active',
    });
    expect((await segmentRow(segment.id))?.last_materialized_at).toBeNull();

    const run = await runJobNow('segment-refresh');
    // The line the scheduler logs when it enqueued something, from this run's own process.
    expect(run.output).toMatch(/Enqueued \d+ segment materialisation job\(s\)/);

    await expect
      .poll(async () => {
        const row = await segmentRow(segment.id);
        return row?.last_materialized_at ? Number(row.last_member_count) : null;
      })
      .toBe(1);
  });

  test('push-schedule-tick promotes a due campaign, and push-reconcile fails a stranded one', async () => {
    const p = await pushProject('jobs-push', { fcm: true });
    const due = await seedLogRow(p.project.id, {
      title: 'Jobs due',
      status: 'scheduled',
      scheduled_at: new Date(Date.now() - 60_000),
      total_tokens: 0,
      success_count: 0,
      processed_tokens: 0,
    });
    const stranded = await seedLogRow(p.project.id, {
      title: 'Jobs stranded',
      status: 'queued',
      total_tokens: 10,
      success_count: 0,
      processed_tokens: 0,
      updated_at: new Date(Date.now() - 20 * 60_000),
    });

    // The tick covers every project on the lane, so another test's campaign may log here.
    await runJobNow('push-schedule-tick', { allowErrors: true });
    expect((await campaignRow(due))?.status).not.toBe('scheduled');

    await runJobNow('push-reconcile', { allowErrors: true });
    const row = await campaignRow(stranded);
    expect(row?.status).toBe('failed');
    expect(row?.completed_at).not.toBeNull();
  });

  test('every job runs once', async () => {
    test.setTimeout(300_000);
    // These cover every project on the lane, where other tests' campaigns may fail on purpose.
    const sharedLogs: WorkerJob[] = ['push-schedule-tick', 'push-reconcile'];
    for (const name of Object.keys(WORKER_JOBS) as WorkerJob[]) {
      const run = await runJobNow(name, { allowErrors: sharedLogs.includes(name) });
      expect(run.result, name).toBeNull();
    }
  });
});
