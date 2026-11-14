import Redis from 'ioredis';
import { Client } from 'pg';
import { assertE2eDatabase, assertE2eRedisDb } from './stack';

/**
 * Empties the e2e database and Redis database before the stack starts, so every run
 * begins from nothing. The API rebuilds the schema at boot (synchronize, NODE_ENV=test).
 * Both are refused unless they are clearly the e2e ones (see the asserts in stack.ts).
 */
export async function resetStores(env: Record<string, string>): Promise<void> {
  const database = assertE2eDatabase(env);
  const redisDb = assertE2eRedisDb(env);

  const client = new Client({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT || 5432),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database,
  });
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: string }).code === '3D000') {
      throw new Error(
        `The e2e database ${database} does not exist. Create it once: psql -U postgres -c "CREATE DATABASE ${database} OWNER ${env.DATABASE_USER};"`,
      );
    }
    throw error;
  }
  try {
    // Checked again on the live connection, in case anything in between rewrote the name.
    const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (!/_e2e$/.test(rows[0].name)) throw new Error('Refusing to reset a database whose name does not end in _e2e');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  const redis = new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: redisDb,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
