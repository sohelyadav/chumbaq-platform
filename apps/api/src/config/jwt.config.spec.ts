import { durationMs } from './jwt.config';

describe('durationMs', () => {
  it.each([
    ['7d', 7 * 86_400_000],
    ['15m', 900_000],
    ['12 hours', 43_200_000],
    ['2 weeks', 1_209_600_000],
    ['30s', 30_000],
    ['1.5h', 5_400_000],
    ['3600', 3600],
    [' 7D ', 7 * 86_400_000],
  ])('reads %p the way jsonwebtoken does', (value, expected) => {
    expect(durationMs(value)).toBe(expected);
  });

  it.each(['', 'seven days', '7 fortnights', '-7d', '7d 2h'])('refuses %p', (value) => {
    expect(() => durationMs(value)).toThrow(/Cannot read the duration/);
  });
});

describe('jwt config', () => {
  const ACCESS = 'a'.repeat(40);
  const REFRESH = 'r'.repeat(40);
  const load = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return (require('./jwt.config').default as () => Record<string, unknown>)();
    } finally {
      process.env = saved;
    }
  };

  it('gives refresh tokens their own key', () => {
    expect(load({ JWT_SECRET: ACCESS, JWT_REFRESH_SECRET: REFRESH })).toMatchObject({
      secret: ACCESS,
      refreshSecret: REFRESH,
    });
  });

  it.each([
    ['missing', undefined, /JWT_REFRESH_SECRET/],
    ['short', 'short', /at least 32 characters/],
    ['the access key', ACCESS, /must differ from JWT_SECRET/],
  ])('refuses to start when the refresh key is %s', (_case, value, message) => {
    expect(() => load({ JWT_SECRET: ACCESS, JWT_REFRESH_SECRET: value })).toThrow(message);
  });

  describe('maximum session length', () => {
    const keys = { JWT_SECRET: ACCESS, JWT_REFRESH_SECRET: REFRESH };

    it('defaults to 30 days', () => {
      expect(
        load({ ...keys, SESSION_MAX_AGE: undefined, JWT_REFRESH_EXPIRATION: undefined }),
      ).toMatchObject({ sessionMaxAge: '30d', sessionMaxAgeMs: 30 * 86_400_000 });
    });

    it('reads SESSION_MAX_AGE like the token lifetimes', () => {
      expect(load({ ...keys, SESSION_MAX_AGE: '2 weeks' })).toMatchObject({
        sessionMaxAgeMs: 14 * 86_400_000,
      });
    });

    it('may equal the refresh lifetime', () => {
      expect(
        load({ ...keys, SESSION_MAX_AGE: '7d', JWT_REFRESH_EXPIRATION: '7d' }),
      ).toMatchObject({ sessionMaxAgeMs: 7 * 86_400_000, refreshLifetimeMs: 7 * 86_400_000 });
    });

    it('refuses to start when it is shorter than the refresh lifetime', () => {
      expect(() =>
        load({ ...keys, SESSION_MAX_AGE: '6d', JWT_REFRESH_EXPIRATION: '7d' }),
      ).toThrow(/SESSION_MAX_AGE must be at least JWT_REFRESH_EXPIRATION/);
      expect(() =>
        load({ ...keys, SESSION_MAX_AGE: '30d', JWT_REFRESH_EXPIRATION: '31d' }),
      ).toThrow(/SESSION_MAX_AGE/);
    });

    it('refuses to start on a duration it cannot read', () => {
      expect(() => load({ ...keys, SESSION_MAX_AGE: '30 fortnights' })).toThrow(
        /Cannot read the duration/,
      );
    });
  });
});
