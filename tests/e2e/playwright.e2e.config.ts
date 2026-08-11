import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { resolveE2eWebPort } from './e2eWebPort';

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

const useLocalAgentModel = process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL === '1';
const webPort = resolveE2eWebPort({ explicitPort: process.env.E2E_WEB_PORT });
// sticky：Playwright 每个 worker 进程会重新评估本 config，写回 env 让 worker 走显式分支，
// 否则各 worker 按自己的 PID 再派生一次端口，与 webServer 实际监听口错开（CI 实翻过车）。
process.env.E2E_WEB_PORT = String(webPort);
// 走 stderr：config 会被 knip 等工具加载，stdout 打印会污染它们的 JSON 输出（CI 实翻过车）
console.error(`  E2E web port: ${webPort}${process.env.E2E_WEB_PORT ? ' (explicit)' : ' (derived from PID)'}`);
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
      // 不关掉热更新，webServer 会优先 serve <数据目录>/renderer-cache/active（启动时从云端拉的
      // bundle），把刚构建的本地 renderer 整个盖住 —— e2e 于是在测线上包而不是这次的改动。
      // 2026-07-25 实测：新加的 data-testid 三轮找不到，DOM 里还是上一版的文案。
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
      HOME: e2eHome,
      CODE_AGENT_HOME: e2eHome,
      CODE_AGENT_DATA_DIR: e2eDataDir,
      ...(useLocalAgentModel ? { CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1' } : {}),
    },
  },
});
