import path from 'path';
import type { FullConfig } from '@playwright/test';
import { portInUse, run, runToEnd, stopAll, waitForOutput, waitForUrl, type Started } from './processes';
import { startProviderStub } from './provider-stub';
import { startRazorpayMock } from './razorpay-mock';
import { resetStores } from './reset';
import {
  accountEmailEnvironment,
  appEnvironment,
  assertE2eDatabase,
  assertE2eRedisDb,
  exportRunSecrets,
  LANE,
  laneOverrides,
  LOG_DIR,
  newRunSecrets,
  readDotEnv,
  REPO_ROOT,
  stackPorts,
} from './stack';

const API_DIR = path.join(REPO_ROOT, 'apps/api');
const VITE = path.join(REPO_ROOT, 'node_modules/.bin/vite');
const TYPEORM_CLI = path.join(REPO_ROOT, 'node_modules/typeorm/cli.js');

/**
 * Builds and starts the whole stack for one run (on lane E2E_LANE), and returns its
 * teardown:
 *
 * 0. for a lane other than 0, puts the lane's changes to the .env (its database, Redis
 *    database, ports and addresses) into this process's environment, which every
 *    process started from here inherits (migrations, the apps, both Vite servers, and
 *    the test workers with the CLI they run) and which wins over the .env in each;
 * 1. refuses unless the .env names an `_e2e` database and its own Redis database, and
 *    unless every port the stack needs is free (another stack, or a run that died);
 * 2. builds @chumbaq/shared and the API (skip with E2E_SKIP_BUILD=1 when iterating);
 * 3. drops and recreates the e2e schema, flushes the e2e Redis database, and applies the
 *    migrations, as production does: some tables (the security tripwires, alarms and
 *    incidents) exist only in migrations, so synchronize alone would leave them out;
 * 4. starts the mock Razorpay API and the provider stub (account email and every channel
 *    provider, `provider-stub.ts`), then the customer API (NODE_ENV=test, whose
 *    synchronize then finds next to nothing to change), then the admin API, the worker
 *    and both Vite dev servers, waiting for each.
 */
export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const base = readDotEnv();
  const overrides = laneOverrides(base);
  Object.assign(process.env, overrides);
  const env = { ...base, ...overrides };
  assertE2eDatabase(env);
  assertE2eRedisDb(env);
  const ports = stackPorts(env);

  const busy: number[] = [];
  for (const port of Object.values(ports)) if (await portInUse(port)) busy.push(port);
  if (busy.length) {
    throw new Error(
      `Ports already in use on lane ${LANE}: ${busy.join(', ')}. Another stack (or a previous run) holds them; stop it first, or use another E2E_LANE.`,
    );
  }

  if (process.env.E2E_SKIP_BUILD !== '1') {
    runToEnd('Building @chumbaq/shared', 'npm', ['run', 'build:shared'], REPO_ROOT);
    runToEnd('Building the API', 'npm', ['run', 'build:api'], REPO_ROOT);
  }

  await resetStores(env);
  runToEnd('Applying migrations', 'node', [TYPEORM_CLI, 'migration:run', '-d', 'dist/data-source.js'], API_DIR, {
    ...process.env,
    DATABASE_NAME: assertE2eDatabase(env),
  });

  const secrets = newRunSecrets();
  exportRunSecrets(secrets);
  process.env.E2E_API_URL = `http://localhost:${ports.api}`;
  process.env.E2E_ADMIN_API_URL = `http://127.0.0.1:${ports.adminApi}`;
  process.env.E2E_RAZORPAY_MOCK_URL = `http://127.0.0.1:${ports.razorpayMock}`;
  process.env.E2E_PROVIDER_STUB_URL = `http://127.0.0.1:${ports.providerStub}`;
  Object.assign(process.env, accountEmailEnvironment(ports));

  const mock = await startRazorpayMock(ports.razorpayMock, secrets.razorpayKeyId, secrets.razorpayKeySecret);
  const providerStub = await startProviderStub(ports.providerStub);
  const appEnv = { ...process.env, ...appEnvironment(secrets, ports) };
  const started: Started[] = [];
  const teardown = async () => {
    await stopAll(started);
    await mock.close();
    await providerStub.close();
  };

  try {
    const api = run('api', 'node', ['dist/main'], { cwd: API_DIR, env: appEnv });
    started.push(api);
    await waitForUrl(api, `http://127.0.0.1:${ports.api}/api/health`);

    // The admin API and the worker do no DDL, so they start once the API has built the schema.
    const adminApi = run('admin-api', 'node', ['dist/main-admin'], { cwd: API_DIR, env: appEnv });
    const worker = run('worker', 'node', ['dist/worker'], { cwd: API_DIR, env: appEnv });
    const web = run('web', VITE, ['--port', String(ports.web), '--strictPort'], {
      cwd: path.join(REPO_ROOT, 'apps/web'),
    });
    const admin = run('admin', VITE, ['--port', String(ports.admin), '--strictPort'], {
      cwd: path.join(REPO_ROOT, 'apps/admin'),
    });
    started.push(adminApi, worker, web, admin);
    await Promise.all([
      waitForUrl(adminApi, `http://127.0.0.1:${ports.adminApi}/api/health`),
      waitForOutput(worker, /Chumbaq worker started/),
      waitForUrl(web, `https://localhost:${ports.web}/login`),
      waitForUrl(admin, `https://localhost:${ports.admin}/sign-in`),
    ]);
  } catch (error) {
    await teardown();
    throw new Error(`${(error as Error).message}\nLogs: ${LOG_DIR}`);
  }

  return teardown;
}
