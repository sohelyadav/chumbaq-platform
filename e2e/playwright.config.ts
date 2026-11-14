import path from 'path';
import { defineConfig, devices } from '@playwright/test';
import { ARTEFACTS_DIR, stackPorts } from './support/stack';

const ports = stackPorts();

/**
 * End-to-end tests against the whole stack, started by support/global-setup.ts on the
 * ports the repo-root .env names (moved for lanes other than 0: E2E_LANE, see
 * support/stack.ts). Chromium only for now (see README.md).
 */
export default defineConfig({
  testDir: './tests',
  outputDir: path.join(ARTEFACTS_DIR, 'test-results'),
  globalSetup: './support/global-setup.ts',
  // Each spec makes its own accounts and projects, so files can run side by side.
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 3,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: path.join(ARTEFACTS_DIR, 'report'), open: 'never' }]],
  use: {
    baseURL: `https://localhost:${ports.web}`,
    // The Vite dev servers use self-signed certificates.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
