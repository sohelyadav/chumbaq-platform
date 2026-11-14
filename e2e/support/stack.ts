import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { parse } from 'dotenv';

/**
 * Where the end-to-end stack lives and what it is started with.
 *
 * Ports and database settings come from the repo-root `.env`, the same file the API,
 * the worker and both Vite servers read, so the harness and the apps cannot disagree
 * about them. Its values are never printed. Everything the tests themselves need to
 * know (signing secrets, the fake Razorpay keys) is generated per run here and handed
 * to the apps as environment variables, which take precedence over the `.env`.
 */

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const ARTEFACTS_DIR = path.join(REPO_ROOT, 'e2e/.artefacts');
export const LOG_DIR = path.join(ARTEFACTS_DIR, 'logs');

/** The repo-root `.env`, parsed without touching `process.env`. */
export function readDotEnv(): Record<string, string> {
  const file = path.join(REPO_ROOT, '.env');
  try {
    return parse(readFileSync(file));
  } catch {
    throw new Error(`The e2e stack needs a .env at the repo root (${file}); see e2e/README.md.`);
  }
}

function portOf(url: string | undefined, name: string): number {
  if (!url) throw new Error(`${name} must be set in .env for the e2e stack`);
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}

function requiredPort(value: string | undefined, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${name} must be set in .env for the e2e stack`);
  return port;
}

export interface StackPorts {
  api: number;
  adminApi: number;
  web: number;
  admin: number;
  razorpayMock: number;
}

export function stackPorts(env: Record<string, string> = readDotEnv()): StackPorts {
  const api = requiredPort(env.API_PORT, 'API_PORT');
  return {
    api,
    adminApi: requiredPort(env.ADMIN_API_PORT, 'ADMIN_API_PORT'),
    web: portOf(env.APP_URL, 'APP_URL'),
    admin: portOf(env.ADMIN_APP_URL, 'ADMIN_APP_URL'),
    // Not in .env: the mock exists only for this harness.
    razorpayMock: Number(process.env.E2E_RAZORPAY_MOCK_PORT || api + 90),
  };
}

/**
 * The database the harness wipes. Refused unless its name ends in `_e2e`, so a `.env`
 * pointed at a real database (or the demo one) can never be reset by a test run.
 */
export function assertE2eDatabase(env: Record<string, string>): string {
  const name = env.DATABASE_NAME ?? '';
  if (!/_e2e$/.test(name)) {
    throw new Error(
      'Refusing to run: DATABASE_NAME in .env must end in _e2e, because the e2e harness drops and recreates its schema.',
    );
  }
  return name;
}

/** The Redis database the harness flushes. Refused when unset or 0, the shared default. */
export function assertE2eRedisDb(env: Record<string, string>): number {
  const db = Number(env.REDIS_DB ?? '0');
  if (!Number.isInteger(db) || db <= 0) {
    throw new Error(
      'Refusing to run: REDIS_DB in .env must be a database of its own (not 0), because the e2e harness flushes it.',
    );
  }
  return db;
}

/** Values made per run and shared with the tests through `process.env` (globalSetup sets them). */
export interface RunSecrets {
  jwtSecret: string;
  jwtRefreshSecret: string;
  /** CREDENTIALS_ENCRYPTION_KEY: the seed helpers store channel credentials with it. */
  credentialsKey: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
}

export function newRunSecrets(): RunSecrets {
  return {
    jwtSecret: randomBytes(32).toString('hex'),
    jwtRefreshSecret: randomBytes(32).toString('hex'),
    credentialsKey: randomBytes(32).toString('hex'),
    // Obviously fake: Razorpay's key shape, a test-mode prefix and a mock-only body.
    razorpayKeyId: 'rzp_test_E2eMockOnly000',
    razorpayKeySecret: `e2e-fake-${randomBytes(8).toString('hex')}`,
    razorpayWebhookSecret: `e2e-fake-webhook-${randomBytes(8).toString('hex')}`,
  };
}

const SECRET_VARS: Record<keyof RunSecrets, string> = {
  jwtSecret: 'E2E_JWT_SECRET',
  jwtRefreshSecret: 'E2E_JWT_REFRESH_SECRET',
  credentialsKey: 'E2E_CREDENTIALS_ENCRYPTION_KEY',
  razorpayKeyId: 'E2E_RAZORPAY_KEY_ID',
  razorpayKeySecret: 'E2E_RAZORPAY_KEY_SECRET',
  razorpayWebhookSecret: 'E2E_RAZORPAY_WEBHOOK_SECRET',
};

export function exportRunSecrets(secrets: RunSecrets): void {
  for (const [key, name] of Object.entries(SECRET_VARS)) {
    process.env[name] = secrets[key as keyof RunSecrets];
  }
}

/** In a test worker: the secrets globalSetup made for this run. */
export function runSecrets(): RunSecrets {
  const out = {} as RunSecrets;
  for (const [key, name] of Object.entries(SECRET_VARS)) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set: run the specs through playwright.config.ts (npm run test:e2e)`);
    out[key as keyof RunSecrets] = value;
  }
  return out;
}

/**
 * What the API, admin API and worker get on top of the `.env`. Environment variables win
 * over the `.env` in every one of them (Nest's ConfigModule and dotenv both keep a value
 * already set), so these hold for the run whatever the `.env` says.
 */
export function appEnvironment(secrets: RunSecrets, ports: StackPorts): Record<string, string> {
  return {
    // Synchronize builds the schema (no migrations run), no SQL logging, cookies not Secure.
    NODE_ENV: 'test',
    JWT_SECRET: secrets.jwtSecret,
    JWT_REFRESH_SECRET: secrets.jwtRefreshSecret,
    // The database starts empty each run, so nothing is encrypted under the .env's key.
    CREDENTIALS_ENCRYPTION_KEY: secrets.credentialsKey,
    // Billing on, against the local mock only. Fake keys; the mock checks the pair.
    BILLING_ENABLED: 'true',
    RAZORPAY_KEY_ID: secrets.razorpayKeyId,
    RAZORPAY_KEY_SECRET: secrets.razorpayKeySecret,
    RAZORPAY_WEBHOOK_SECRET: secrets.razorpayWebhookSecret,
    RAZORPAY_API_BASE_URL: `http://127.0.0.1:${ports.razorpayMock}/v1`,
    // No account email can leave the machine, whatever the .env holds.
    PLATFORM_BREVO_API_KEY: '',
    PLATFORM_EMAIL_FROM: '',
  };
}
