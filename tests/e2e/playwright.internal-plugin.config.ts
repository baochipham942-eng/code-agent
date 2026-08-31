import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { resolveE2eWebPort } from './e2eWebPort';
import { prepareRealEvalCredentials } from './internal-plugin-real-eval-credentials';

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

const webPort = resolveE2eWebPort({ explicitPort: process.env.E2E_WEB_PORT });
process.env.E2E_WEB_PORT = String(webPort);

const e2eHome = process.env.CODE_AGENT_E2E_HOME
  || path.join(os.tmpdir(), `code-agent-internal-plugin-e2e-home-${webPort}`);
const e2eDataDir = process.env.CODE_AGENT_E2E_DATA_DIR
  || path.join(os.tmpdir(), `code-agent-internal-plugin-e2e-data-${webPort}`);
process.env.CODE_AGENT_E2E_HOME = e2eHome;
process.env.CODE_AGENT_E2E_DATA_DIR = e2eDataDir;

if (process.env.CODE_AGENT_REAL_EVAL_E2E === '1') {
  const sourceDir = process.env.CODE_AGENT_REAL_EVAL_SOURCE_DIR
    || path.join(os.homedir(), '.code-agent-chatprobe');
  prepareRealEvalCredentials(sourceDir, e2eDataDir);
  console.error(`  Real eval E2E credentials: selectively imported from ${sourceDir}`);
}

console.error(`  Internal plugin E2E web port: ${webPort}`);
console.error(`  Internal plugin E2E data dir: ${e2eDataDir}`);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/internal-plugin-lifecycle.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['./fixtures/axeReporter.ts'],
  ],
  timeout: process.env.CODE_AGENT_REAL_EVAL_E2E === '1' ? 420_000 : 180_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: `cd ../.. && npm run build:web && npm run build:renderer && WEB_HOST=127.0.0.1 WEB_PORT=${webPort} node dist/web/webServer.cjs`,
    port: webPort,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      CODE_AGENT_E2E: '1',
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
      HOME: e2eHome,
      CODE_AGENT_HOME: e2eHome,
      CODE_AGENT_DATA_DIR: e2eDataDir,
    },
  },
});
