// 临时配置：用系统 Chrome 跑 e2e（chromium 二进制下载不可用时的替代路径）。
// 与 playwright.e2e.config.ts 唯一区别：channel: 'chrome' + 不自起 webServer（要求 E2E_WEB_PORT 对应服务已启动）。
import { defineConfig } from '@playwright/test';
import { resolveE2eWebPort } from './e2eWebPort';

const webPort = resolveE2eWebPort({ explicitPort: process.env.E2E_WEB_PORT });
// 走 stderr：config 会被 knip 等工具加载，stdout 打印会污染它们的 JSON 输出（CI 实翻过车）
console.error(`  E2E web port: ${webPort}${process.env.E2E_WEB_PORT ? ' (explicit)' : ' (derived from PID)'}`);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
