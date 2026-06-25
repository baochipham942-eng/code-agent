import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

const useLocalAgentModel = process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL === '1';
const webPort = Number(process.env.E2E_WEB_PORT || (useLocalAgentModel ? 8181 : 8180));
const browserChannel = process.env.E2E_BROWSER_CHANNEL || undefined;
const recordVideo = process.env.E2E_DISABLE_VIDEO === '1' ? 'off' : 'retain-on-failure';
const reuseExistingServer = !process.env.CI && !process.env.E2E_WEB_PORT && !useLocalAgentModel;
const e2eHome = process.env.CODE_AGENT_E2E_HOME
  || path.join(os.tmpdir(), `code-agent-e2e-home-${webPort}`);
const e2eDataDir = process.env.CODE_AGENT_E2E_DATA_DIR
  || path.join(os.tmpdir(), `code-agent-e2e-data-${webPort}`);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  // ADR-010 #1: CI flake 重试上限 1 次，本地开发保持 0。
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    ...(browserChannel ? { channel: browserChannel } : {}),
    // ADR-010 #1: 失败（或重试）时强制保留 trace + 截图作为 CI artifact。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: recordVideo,
  },
  webServer: {
    command: `cd ../.. && npm run build:web && npm run build:renderer && WEB_HOST=127.0.0.1 WEB_PORT=${webPort} node dist/web/webServer.cjs`,
    port: webPort,
    reuseExistingServer,
    timeout: 180000,
    env: {
      // Enables /api/dev/emit-swarm-event for swarm-chain.spec.ts.
      // Benign for other specs — the route 404s unless this flag is set.
      CODE_AGENT_E2E: '1',
      HOME: e2eHome,
      CODE_AGENT_HOME: e2eHome,
      CODE_AGENT_DATA_DIR: e2eDataDir,
      ...(useLocalAgentModel ? { CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1' } : {}),
    },
  },
});
