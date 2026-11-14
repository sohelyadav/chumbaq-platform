import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PreAuthService } from './pre-auth.service';

/**
 * The sign-in failure limit, against a real Redis: counted before each guess (so
 * guesses sent together are held to it) and kept per network, so a stranger who knows
 * an address cannot lock its owner out from elsewhere.
 */
describe('Sign-in attempt limit (integration)', () => {
  const config = {
    get: (key: string) =>
      ({
        'redis.host': process.env.REDIS_HOST,
        'redis.port': Number(process.env.REDIS_PORT ?? 6379),
        'redis.password': process.env.REDIS_PASSWORD || undefined,
        'redis.db': Number(process.env.REDIS_DB ?? 0),
      })[key],
    getOrThrow: (key: string) =>
      ({ 'redis.host': process.env.REDIS_HOST, 'redis.port': Number(process.env.REDIS_PORT ?? 6379) })[key],
  };
  const preAuth = new PreAuthService(config as never);
  const recorded: string[] = [];
  const events = {
    record: async (event: { type: string }) => {
      recorded.push(event.type);
    },
    recentLoginFailures: async () => 0,
  };
  const auth = new AuthService(
    null as never, null as never, null as never, null as never, events as never, null as never,
    preAuth, null as never, null as never, null as never, null as never,
  );

  afterAll(() => preAuth.onModuleDestroy());

  const address = () => `limit-${randomUUID()}@example.test`;
  const attempt = (email: string, ipAddress: string) =>
    auth.assertUnderLoginLimit(email, { ipAddress }).then(
      () => 'allowed',
      (error: unknown) => (error instanceof HttpException && error.getStatus() === 429 ? 'limited' : 'error'),
    );

  it('holds guesses sent all at once to the limit', async () => {
    const email = address();
    const outcomes = await Promise.all(Array.from({ length: 30 }, () => attempt(email, '198.51.100.1')));
    expect(outcomes.filter((o) => o === 'allowed')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'limited')).toHaveLength(20);
  });

  it('does not lock the owner out on their own network when a stranger used up theirs', async () => {
    const email = address();
    for (let i = 0; i < 12; i++) await attempt(email, '203.0.113.66');
    expect(await attempt(email, '203.0.113.66')).toBe('limited');
    expect(await attempt(email, '198.51.100.20')).toBe('allowed');
  });

  it('counts an IPv6 /64 as one network', async () => {
    const email = address();
    for (let i = 0; i < 10; i++) expect(await attempt(email, `2001:db8:7:7::${i + 1}`)).toBe('allowed');
    expect(await attempt(email, '2001:db8:7:7::ffff')).toBe('limited');
  });

  it('bounds guessing spread over many networks', async () => {
    const email = address();
    for (let i = 0; i < 100; i++) await attempt(email, `192.0.2.${i % 250}`);
    expect(await attempt(email, '198.51.100.99')).toBe('limited');
  });

  it('gives a right guess back, and a complete sign-in clears the window', async () => {
    const email = address();
    for (let i = 0; i < 9; i++) await attempt(email, '198.51.100.5');
    await attempt(email, '198.51.100.5');
    await auth.releaseLoginAttempt(email, { ipAddress: '198.51.100.5' });
    expect(await attempt(email, '198.51.100.5')).toBe('allowed');
    expect(await attempt(email, '198.51.100.5')).toBe('limited');
    await auth.clearLoginLimit(email);
    expect(await attempt(email, '198.51.100.5')).toBe('allowed');
  });
});
