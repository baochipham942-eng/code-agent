// Recovery matrix owns its web server (fresh data dir, kill/restart). No channel:
// this machine has Playwright's bundled Chromium, not system Chrome.
// Do not start a second webServer here — see playwright.e2e.config.ts testIgnore.
import { defineConfig } from '@playwright/test';
import { resolveE2eWebPort } from './e2eWebPort';

const webPort = resolveE2eWebPort({ explicitPort: process.env.E2E_WEB_PORT });
// sticky：worker 进程重评估 config 时靠 env 继承保持同一端口（详见 playwright.e2e.config.ts）
process.env.E2E_WEB_PORT = String(webPort);
// 走 stderr：config 会被 knip 等工具加载，stdout 打印会污染它们的 JSON 输出（CI 实翻过车）
console.error(`  E2E web port: ${webPort}${process.env.E2E_WEB_PORT ? ' (explicit)' : ' (derived from PID)'}`);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/recovery-matrix.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['./fixtures/axeReporter.ts']],
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
