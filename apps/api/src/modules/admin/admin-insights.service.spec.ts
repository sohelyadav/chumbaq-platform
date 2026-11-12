import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EntityManager } from 'typeorm';
import { AdminInsightsService, HEALTH_CHECK_TIMEOUT_MS } from './admin-insights.service';

const SECRET = 'connect ECONNREFUSED redis://admin:hunter2@10.0.0.7:6379';
const never = () => new Promise<never>(() => undefined);
const counts = { waiting: 1, active: 2, delayed: 3, failed: 4 };

function stubQueue(name: string, client: unknown, getJobCounts: () => Promise<unknown> = async () => counts) {
  return { name, client, getJobCounts: jest.fn(getJobCounts) } as unknown as Queue;
}

function readyClient(ping: () => Promise<string> = async () => 'PONG') {
  return Promise.resolve({ status: 'ready', ping: jest.fn(ping) });
}

function build(query: () => Promise<unknown>, queues: Queue[]) {
  return new AdminInsightsService(
    { query: jest.fn(query) } as unknown as EntityManager,
    queues[0],
    queues[1],
    queues[2],
    { isConfigured: false, sender: null } as never,
  );
}

const healthyDb = async () => [{ '?column?': 1 }];
const healthyQueues = () => ['push', 'cohort', 'segment'].map((name) => stubQueue(name, readyClient()));

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const startedAt = Date.now();
  const result = await work();
  return { result, ms: Date.now() - startedAt };
}

describe('AdminInsightsService.health', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports ok with latencies and per-queue counts when everything answers', async () => {
    const health = await build(healthyDb, healthyQueues()).health();

    expect(health.status).toBe('ok');
    expect(health.database).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(health.redis).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(health.queues.map((queue) => queue.name)).toEqual(['push', 'cohort', 'segment']);
    expect(health.queues[0]).toEqual({ name: 'push', ...counts });
    expect(new Date(health.checkedAt).toISOString()).toBe(health.checkedAt);
  });

  it('times out to degraded when the Redis ping never resolves', async () => {
    const queues = ['push', 'cohort', 'segment'].map((name) => stubQueue(name, readyClient(never)));

    const { result, ms } = await timed(() => build(healthyDb, queues).health());

    expect(result.status).toBe('degraded');
    expect(result.redis).toEqual({ ok: false, latencyMs: null });
    expect(result.database.ok).toBe(true);
    expect(result.queues).toEqual([]);
    expect(ms).toBeGreaterThanOrEqual(HEALTH_CHECK_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 1000);
  });

  it('times out when the client promise itself never resolves, as with Redis down at boot', async () => {
    const queues = ['push', 'cohort', 'segment'].map((name) => stubQueue(name, never()));

    const { result, ms } = await timed(() => build(healthyDb, queues).health());

    expect(result.redis.ok).toBe(false);
    expect(ms).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 1000);
  });

  it('times out when the database never answers, with Redis still reported', async () => {
    const { result, ms } = await timed(() => build(never, healthyQueues()).health());

    expect(result.status).toBe('degraded');
    expect(result.database).toEqual({ ok: false, latencyMs: null });
    expect(result.redis.ok).toBe(true);
    expect(result.queues).toHaveLength(3);
    expect(ms).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 1000);
  });

  it('omits a queue whose counts never arrive rather than reporting zeros', async () => {
    const queues = [
      stubQueue('push', readyClient()),
      stubQueue('cohort', readyClient(), never),
      stubQueue('segment', readyClient()),
    ];

    const { result, ms } = await timed(() => build(healthyDb, queues).health());

    expect(result.status).toBe('degraded');
    expect(result.redis.ok).toBe(true);
    expect(result.queues.map((queue) => queue.name)).toEqual(['push', 'segment']);
    expect(ms).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 1000);
  });

  it.each([
    ['rejected', async () => { throw new Error(SECRET); }],
    ['thrown synchronously', () => { throw new Error(SECRET); }],
  ])('keeps a %s driver error out of the response and logs it', async (_how, fail) => {
    const queues = ['push', 'cohort', 'segment'].map((name) =>
      stubQueue(name, readyClient(fail as () => Promise<string>)),
    );

    const health = await build(fail as () => Promise<unknown>, queues).health();

    expect(health.status).toBe('degraded');
    expect(health.database).toEqual({ ok: false, latencyMs: null });
    expect(health.redis).toEqual({ ok: false, latencyMs: null });
    const body = JSON.stringify(health);
    for (const fragment of ['ECONNREFUSED', 'hunter2', '10.0.0.7', '6379']) {
      expect(body).not.toContain(fragment);
    }
    expect(warn.mock.calls.flat().join(' ')).toContain('ECONNREFUSED');
  });

  it('does not add a ping to the offline queue while the client is disconnected', async () => {
    const ping = jest.fn(async () => 'PONG');
    const client = Promise.resolve({ status: 'reconnecting', ping });
    const queues = ['push', 'cohort', 'segment'].map((name) => stubQueue(name, client));

    const health = await build(healthyDb, queues).health();

    expect(health.redis.ok).toBe(false);
    expect(ping).not.toHaveBeenCalled();
    for (const queue of queues) expect(queue.getJobCounts).not.toHaveBeenCalled();
  });

  // The stubs above model what ioredis would do. This is the real thing: BullMQ and
  // ioredis pointed at a port nothing listens on, where commands queue forever.
  it('stays bounded with real BullMQ queues and no Redis listening', async () => {
    const connection = { host: '127.0.0.1', port: 1 };
    const queues = ['a', 'b', 'c'].map((name) => {
      const queue = new Queue(`admin-insights-spec-${name}`, { connection });
      queue.on('error', () => undefined);
      return queue;
    });

    try {
      const { result, ms } = await timed(() => build(healthyDb, queues).health());

      expect(result.status).toBe('degraded');
      expect(result.redis).toEqual({ ok: false, latencyMs: null });
      expect(result.queues).toEqual([]);
      expect(ms).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 1000);
      expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    } finally {
      await Promise.all(queues.map((queue) => queue.close()));
    }
  });
});
