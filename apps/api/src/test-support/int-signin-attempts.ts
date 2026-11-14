import Redis from 'ioredis';

/**
 * Sign-in attempts and sign-up mails are counted in Redis (`PreAuthService`), which
 * outlives each test, while the specs reset the old limit by deleting `auth_events`.
 * So every integration test starts with no attempts counted. A test of the limit itself
 * makes its attempts within one test, as before.
 */
let redis: Redis | null = null;

beforeEach(async () => {
  if (!process.env.REDIS_HOST) return;
  redis ??= new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const keys = [...(await redis.keys('chumbaq:signin-attempts:*')), ...(await redis.keys('chumbaq:signup-mail:*'))];
  if (keys.length) await redis.del(...keys);
});

afterAll(() => {
  redis?.disconnect();
  redis = null;
});
