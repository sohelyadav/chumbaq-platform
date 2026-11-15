import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { parse } from 'dotenv';
import { providerStubEnvironment } from './provider-stub';

/**
 * Where the end-to-end stack lives and what it is started with.
 *
 * Ports and database settings come from the repo-root `.env`, the same file the API,
 * the worker and both Vite servers read, so the harness and the apps cannot disagree
 * about them (lanes other than 0 change a few of them, see `laneOverrides`, and hand
 * the changes to every process as environment variables). Its values are never printed. Everything the tests themselves need to
 * know (signing secrets, the fake Razorpay keys) is generated per run here and handed
 * to the apps as environment variables, which take precedence over the `.env`.
 */

export const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Lanes: up to three stacks at once from one checkout, chosen by E2E_LANE. Lane 0 (unset
 * or 0) is the stack the `.env` describes. Lane n (1 or 2) is a separate stack derived
 * from it: database `chumbaq_l<n>_e2e`, Redis database 12 + n, every port moved up by
 * 100 * n, and artefacts under e2e/.artefacts/lane-<n>/.
 */
export const MAX_LANE = 2;
const LANE_PORT_STEP = 100;
const LANE_REDIS_DB_BASE = 12;

export function e2eLane(value: string | undefined = process.env.E2E_LANE): number {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value) || Number(value) > MAX_LANE) {
    throw new Error(`E2E_LANE must be a whole number from 0 to ${MAX_LANE} (got "${value}")`);
  }
  return Number(value);
}

export const LANE = e2eLane();
export const ARTEFACTS_DIR = path.join(REPO_ROOT, 'e2e/.artefacts', ...(LANE === 0 ? [] : [`lane-${LANE}`]));
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
  /** The stub for every other outbound provider and account email (`provider-stub.ts`). */
  providerStub: number;
}

/**
 * The stack's ports, read from `env`: the `.env` itself for lane 0's, or `stackEnv()` for
 * the current lane's. `lane` only moves an explicitly chosen E2E_RAZORPAY_MOCK_PORT; the
 * default mock port follows the API's.
 */
export function stackPorts(env: Record<string, string> = stackEnv(), lane = LANE): StackPorts {
  const api = requiredPort(env.API_PORT, 'API_PORT');
  return {
    api,
    adminApi: requiredPort(env.ADMIN_API_PORT, 'ADMIN_API_PORT'),
    web: portOf(env.APP_URL, 'APP_URL'),
    admin: portOf(env.ADMIN_APP_URL, 'ADMIN_APP_URL'),
    // Not in .env: the mock exists only for this harness.
    razorpayMock: process.env.E2E_RAZORPAY_MOCK_PORT
      ? Number(process.env.E2E_RAZORPAY_MOCK_PORT) + lane * LANE_PORT_STEP
      : api + 90,
    providerStub: api + 91,
  };
}

/** Keys whose values can name one of the stack's own addresses (URLs, origins, hosts). */
const ADDRESS_KEY = /(_URL|_URLS|_ORIGIN|_ORIGINS|_DOMAIN)$|^VITE_/;

/**
 * What lane `lane` changes in the `.env`: nothing for lane 0. For lane n, its own
 * database and Redis database, API_PORT and ADMIN_API_PORT moved up by 100 * n, and the
 * same move applied to the stack's ports wherever an address-like value names one
 * (APP_URL, ADMIN_APP_URL, API_BASE_URL, CORS_ORIGINS, the WebAuthn origins, and so on),
 * so every process sees the lane's addresses and none of lane 0's. VITE_ADMIN_APP_URL is
 * always set, to the lane's admin app. Refuses anything that would leave the lane
 * sharing a database, a Redis database or a port with lane 0.
 */
export function laneOverrides(base: Record<string, string>, lane = LANE): Record<string, string> {
  if (lane === 0) return {};
  const offset = lane * LANE_PORT_STEP;
  const basePorts = stackPorts(base, 0);
  const own = new Set([basePorts.api, basePorts.adminApi, basePorts.web, basePorts.admin]);
  const shift = (value: string) =>
    value.replace(/:(\d{1,5})(?!\d)/g, (match, port: string) => (own.has(Number(port)) ? `:${Number(port) + offset}` : match));

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!ADDRESS_KEY.test(key)) continue;
    const moved = shift(value);
    if (moved !== value) out[key] = moved;
  }
  out.API_PORT = String(basePorts.api + offset);
  out.ADMIN_API_PORT = String(basePorts.adminApi + offset);
  out.APP_URL = shift(base.APP_URL);
  out.ADMIN_APP_URL = shift(base.ADMIN_APP_URL);
  out.VITE_ADMIN_APP_URL = out.ADMIN_APP_URL;
  out.DATABASE_NAME = `chumbaq_l${lane}_e2e`;
  out.REDIS_DB = String(LANE_REDIS_DB_BASE + lane);

  const lanePorts = stackPorts({ ...base, ...out }, lane);
  const shared = Object.values(lanePorts).filter((port) => Object.values(basePorts).includes(port));
  if (shared.length) {
    throw new Error(`Refusing to run lane ${lane}: it would share ports ${shared.join(', ')} with lane 0. Give APP_URL and ADMIN_APP_URL explicit ports in .env.`);
  }
  if (out.DATABASE_NAME === base.DATABASE_NAME || out.REDIS_DB === base.REDIS_DB) {
    throw new Error(`Refusing to run lane ${lane}: the .env already uses its database or Redis database, so lane 0 and lane ${lane} would wipe each other.`);
  }
  return out;
}

/** The `.env` with the current lane's changes on top: what every process of this lane sees. */
export function stackEnv(lane = LANE): Record<string, string> {
  const base = readDotEnv();
  return { ...base, ...laneOverrides(base, lane) };
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
  /** MFA_ENCRYPTION_KEY (32 bytes of base64): encrypts TOTP secrets, keys recovery codes. */
  mfaKey: string;
  /** MIXPANEL_ENCRYPTION_KEY (at least 32 characters): encrypts stored Mixpanel credentials. */
  mixpanelKey: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
}

export function newRunSecrets(): RunSecrets {
  return {
    jwtSecret: randomBytes(32).toString('hex'),
    jwtRefreshSecret: randomBytes(32).toString('hex'),
    credentialsKey: randomBytes(32).toString('hex'),
    mfaKey: randomBytes(32).toString('base64'),
    // The API uses the first 32 characters as the key, so 32 hex characters is 32 bytes.
    mixpanelKey: randomBytes(16).toString('hex'),
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
  mfaKey: 'E2E_MFA_ENCRYPTION_KEY',
  mixpanelKey: 'E2E_MIXPANEL_ENCRYPTION_KEY',
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
    // Authenticator apps and recovery codes on (they need the key), and passkeys for
    // tenants, so the customer app's factor screens exist whatever the .env says.
    MFA_ENCRYPTION_KEY: secrets.mfaKey,
    PASSKEYS_FOR_TENANTS: 'true',
    // Mixpanel credentials can be stored (configure needs the key), whatever the .env says.
    MIXPANEL_ENCRYPTION_KEY: secrets.mixpanelKey,
    // Billing on, against the local mock only. Fake keys; the mock checks the pair.
    BILLING_ENABLED: 'true',
    RAZORPAY_KEY_ID: secrets.razorpayKeyId,
    RAZORPAY_KEY_SECRET: secrets.razorpayKeySecret,
    RAZORPAY_WEBHOOK_SECRET: secrets.razorpayWebhookSecret,
    RAZORPAY_API_BASE_URL: `http://127.0.0.1:${ports.razorpayMock}/v1`,
    // No tax, whatever the .env says, so a price's charged amount is the price itself.
    BILLING_TAX_RATE_BPS: '0',
    ...accountEmailEnvironment(ports),
  };
}

/**
 * Account email on, and every outbound provider (account email's Brevo and the tenants'
 * channel providers) sent to the local provider stub through the API's test-only
 * `*_API_BASE_URL` overrides, so nothing leaves the machine whatever the .env holds. The
 * key is fake; the stub records each mail for `mailbox.ts`. globalSetup also puts these
 * in its own environment, so a CLI a test runs never mails with the .env's settings: run
 * without NODE_ENV=test it refuses the override and sends nothing; with it, it mails the
 * stub.
 */
export function accountEmailEnvironment(ports: StackPorts): Record<string, string> {
  return {
    PLATFORM_BREVO_API_KEY: 'xkeysib-e2e-fake-provider-stub-only',
    PLATFORM_EMAIL_FROM: 'Chumbaq E2E <no-reply@e2e.example.test>',
    ...providerStubEnvironment(`http://127.0.0.1:${ports.providerStub}`),
  };
}
