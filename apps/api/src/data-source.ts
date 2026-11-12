import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as path from 'path';
import { DataSource } from 'typeorm';

/**
 * DataSource used by the TypeORM CLI for generating and running migrations.
 *
 * The running application configures TypeORM through Nest (`app.module.ts` and
 * `worker.module.ts`); this file exists only so the CLI has a connection it can
 * introspect. It deliberately loads the same repo-root `.env` those modules use,
 * so there is exactly one place credentials live.
 *
 * Entities are globbed rather than imported so this cannot drift as entities are
 * added — the same reason `worker.module.ts` globs them.
 */
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export default new DataSource({
  type: 'postgres',
  host: requireEnv('DATABASE_HOST'),
  port: parseInt(requireEnv('DATABASE_PORT'), 10),
  username: requireEnv('DATABASE_USER'),
  password: requireEnv('DATABASE_PASSWORD'),
  database: requireEnv('DATABASE_NAME'),
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  // Never true here. The CLI's job is to author and apply migrations; letting it
  // synchronize would defeat the point and could silently diverge from them.
  synchronize: false,
});
