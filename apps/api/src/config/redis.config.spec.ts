import redisConfig from './redis.config';

describe('redisConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when REDIS_HOST is missing', () => {
    delete process.env.REDIS_HOST;
    process.env.REDIS_PORT = '6379';

    expect(() => redisConfig()).toThrow(
      'Missing required environment variable: REDIS_HOST',
    );
  });

  it('throws when REDIS_PORT is missing', () => {
    process.env.REDIS_HOST = 'localhost';
    delete process.env.REDIS_PORT;

    expect(() => redisConfig()).toThrow(
      'Missing required environment variable: REDIS_PORT',
    );
  });

  it('parses port as a number and defaults db to 0', () => {
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    delete process.env.REDIS_DB;
    delete process.env.REDIS_PASSWORD;

    const config = redisConfig();

    expect(config.host).toBe('localhost');
    expect(config.port).toBe(6379);
    expect(config.db).toBe(0);
    expect(config.password).toBeUndefined();
  });

  it('reads optional password and db when present', () => {
    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_DB = '3';

    const config = redisConfig();

    expect(config.password).toBe('secret');
    expect(config.db).toBe(3);
  });
});
