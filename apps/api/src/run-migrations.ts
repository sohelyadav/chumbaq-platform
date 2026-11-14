import type { DataSource } from 'typeorm';

/**
 * Applies pending migrations on a connection of their own, before the API's pool (with
 * its statement timeout, `common/db-pool.ts`) exists, so a long migration is never cut
 * off. Not in development or test, which build the schema with `synchronize`.
 */
export async function runMigrationsBeforeBoot(nodeEnv: string | undefined): Promise<void> {
  if ((nodeEnv ?? 'development') === 'development' || nodeEnv === 'test') return;
  const { default: dataSource } = (await import('./data-source')) as { default: DataSource };
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
