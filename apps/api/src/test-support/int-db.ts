import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as path from 'path';
import { DataSource } from 'typeorm';
import type { ProjectRole } from '../modules/project-access/project-permissions';

loadEnv({ path: path.resolve(__dirname, '../../../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** A dedicated database, so a bad test can never touch dev data. */
export const INT_DB_NAME = `${requireEnv('DATABASE_NAME')}_int`;

export interface PersonSpec {
  id: string;
  externalUserId?: string | null;
  platform?: string;
  country?: string | null;
  city?: string | null;
  totalRevenue?: number;
  lastSeenAt?: Date;
  traits?: Record<string, unknown> | null;
}

export interface EventSpec {
  deviceIdentityId: string;
  eventName: string;
  daysAgo: number;
  properties?: Record<string, unknown> | null;
}

export const INT_PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const INT_OWNER_ID = '22222222-2222-2222-2222-222222222222';

export async function openIntDb(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    host: requireEnv('DATABASE_HOST'),
    port: parseInt(requireEnv('DATABASE_PORT'), 10),
    username: requireEnv('DATABASE_USER'),
    password: requireEnv('DATABASE_PASSWORD'),
    database: INT_DB_NAME,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],
    synchronize: false,
  });

  try {
    await ds.initialize();
  } catch (error) {
    throw new Error(
      `Could not connect to ${INT_DB_NAME}. Create it once with:\n` +
        `  psql -U postgres -c "CREATE DATABASE ${INT_DB_NAME} OWNER ${requireEnv('DATABASE_USER')};"\n` +
        `Original error: ${(error as Error).message}`,
    );
  }

  await ds.runMigrations();
  return ds;
}

/** Truncates fixture tables and reinstates the owning user and project. */
export async function resetFixtures(ds: DataSource): Promise<void> {
  await ds.query(
    'TRUNCATE user_events, segment_members, segments, device_identities RESTART IDENTITY CASCADE',
  );
  await ds.query(
    `INSERT INTO users (id, email, password_hash, name)
     VALUES ($1, 'int@test.local', 'x', 'int')
     ON CONFLICT (id) DO NOTHING`,
    [INT_OWNER_ID],
  );
  await ds.query(
    `INSERT INTO projects (id, name, owner_id)
     VALUES ($1, 'int', $2) ON CONFLICT (id) DO NOTHING`,
    [INT_PROJECT_ID, INT_OWNER_ID],
  );
  await addOwnerMember(ds, INT_PROJECT_ID, INT_OWNER_ID);
}

/**
 * Gives a fixture project a member row, as `ProjectsService.create` does for real ones.
 * Fixtures that insert into `projects` directly need this to be reachable by a member.
 */
export async function addOwnerMember(
  ds: DataSource,
  projectId: string,
  userId: string,
  role: ProjectRole = 'owner',
): Promise<void> {
  await ds.query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [projectId, userId, role],
  );
}

export async function seedPerson(ds: DataSource, spec: PersonSpec): Promise<void> {
  await ds.query(
    `INSERT INTO device_identities
       (id, project_id, external_user_id, device_fingerprint, platform,
        country, city, total_revenue, traits, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      spec.id,
      INT_PROJECT_ID,
      spec.externalUserId ?? null,
      `fp-${spec.id}`,
      spec.platform ?? 'ios',
      spec.country ?? null,
      spec.city ?? null,
      spec.totalRevenue ?? 0,
      spec.traits ? JSON.stringify(spec.traits) : null,
      spec.lastSeenAt ?? new Date(),
    ],
  );
}

export async function seedEvent(ds: DataSource, spec: EventSpec): Promise<void> {
  await ds.query(
    `INSERT INTO user_events
       (project_id, device_identity_id, event_name, properties, timestamp)
     VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 day'))`,
    [
      INT_PROJECT_ID,
      spec.deviceIdentityId,
      spec.eventName,
      spec.properties ? JSON.stringify(spec.properties) : null,
      spec.daysAgo,
    ],
  );
}

export async function closeIntDb(ds: DataSource): Promise<void> {
  if (ds?.isInitialized) await ds.destroy();
}
